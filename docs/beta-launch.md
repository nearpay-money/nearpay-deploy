# NearPay closed beta: launch runbook (owner)

The beta is the full v1 product in **live mode on mainnet**, served at **nearpay.money** from your Mac (Docker Desktop)
through a **Cloudflare Tunnel**: no router ports are opened. Anyone can sign up; only merchants whose business details
you approve in the console go live. Email goes out through **Resend**, alerts come to **Telegram**, and an external
**UptimeRobot** check tells you when the site is unreachable (for example, when the Mac is asleep).

Work through the steps in order and tick each box. Everything is free. Each step says where the value it produces goes.
**Never paste a key, token or password into a chat.** Values go into files in `nearpay-deploy/.secrets/beta/` on the Mac
(step 13). If something fails, paste the script's output back: it never prints secrets.

What the pieces are (for orientation):

| Piece | Where | What it does |
|---|---|---|
| Cloudflare | cloud | DNS for nearpay.money, HTTPS certificates, firewall (WAF), Turnstile (bot check on sign-up and checkout), Access (a login wall in front of the console), the tunnel to your Mac |
| `cloudflared` | your Mac (container) | keeps the tunnel to Cloudflare open; only it can reach the gateway |
| NearPay stack | your Mac (containers) | gateway (Traefik), services, Postgres, NATS, web apps |
| Prometheus, Grafana, Alertmanager | your Mac, `127.0.0.1` only | metrics, the "NearPay beta" dashboard, alerts → Telegram |
| Resend | cloud | sends NearPay's emails from `receipts@nearpay.money` (100 a day on the free plan) |
| UptimeRobot | cloud | checks `https://api.nearpay.money/healthz` every 5 minutes from outside |

---

## 0. Before you start

- [ ] Docker Desktop is installed and running, with **Settings → Resources → Memory: 8 GB or more** (12 GB if you have 24 GB+ RAM) and **Disk usage limit ≥ 64 GB**. Turn on **Settings → General → Start Docker Desktop when you sign in**.
- [ ] Node.js 22, pnpm (`corepack enable`), git and the NearPay repositories in `~/work/near-hackathon/` (as for the local stack). The script builds every image from each repository's `main`.
- [ ] `compose/env/local.env` has the live accounts from the mainnet checklist **C.1** (`NP_TREASURY_ACCOUNT`, `NP_RELAYER_ACCOUNT`, `NP_NEAR_RPC_URLS`, your RPC URLs) and `.secrets/live/relayer_key_1` … `relayer_key_4` exist (prepared on 7 Nov). **`NP_VAULT_CONTRACT` is optional for the first start**: leave it empty until the vault is deployed (live auto-debit stays off; `beta.sh` warns). Never set it to an account under `nearpay.near` such as `v1.vault.nearpay.near`: NearPay does not control `nearpay.near`, so payers' mandate funding would go to someone else's contract (`beta.sh` refuses it). The keeper key can come later too (step 15).
- [ ] The Mac stays **plugged in with the lid open**. In **System Settings → Battery (or Energy) → Options**: turn on "Prevent automatic sleeping on power adapter when the display is off" and "Wake for network access". The script also runs `caffeinate` while the beta is up.

## 1. Free security setup (do this first)

These accounts control the domain, the console and the alerts. Protect each with an **authenticator app** (Google Authenticator, 2FAS or Aegis on your phone), not SMS.

- [ ] **Google account** `nearpaydotmoney@gmail.com`: [myaccount.google.com/security](https://myaccount.google.com/security) → 2-Step Verification → On, with **Authenticator** as the second step. Generate **backup codes**, print them and keep the paper somewhere safe (not on the Mac).
- [ ] **Cloudflare**: My Profile → Authentication → Two-Factor Authentication (authenticator app). Save the recovery codes.
- [ ] **Namecheap**: Profile → Security → 2FA (TOTP authenticator). Domain List → nearpay.money → **Domain lock On** (Registrar Lock).
- [ ] **Resend** (after step 9): Settings → Account → enable two-factor authentication.
- [ ] **GitHub**: Settings → Password and authentication → two-factor (authenticator app).
- [ ] **Telegram**: Settings → Privacy and Security → Two-Step Verification → set a cloud password (and a recovery email).
- [ ] **This Mac**: System Settings → Privacy & Security → **FileVault On**; Lock Screen → require password **immediately**, screen saver/display off after **≤ 5 minutes**; a strong login password; Network → **Firewall On**.

## 2. Cloudflare account

- [ ] Sign up at [dash.cloudflare.com](https://dash.cloudflare.com/sign-up) with `nearpaydotmoney@gmail.com` and turn on 2FA (step 1).

## 3. Add nearpay.money to Cloudflare (Free plan)

- [ ] Cloudflare dashboard → **Add a domain** → `nearpay.money` → "Quick scan for DNS records" → choose the **Free** plan.
- [ ] Review the imported DNS records: delete Namecheap parking/forwarding records (`parkingpage.namecheap.com`, URL-redirect records). Keep any mail records you really use. The tunnel creates the website records itself (step 4).
- [ ] Note the **two Cloudflare nameservers** shown (like `ada.ns.cloudflare.com`, `bob.ns.cloudflare.com`).

## 4. Point the domain at Cloudflare (Namecheap)

- [ ] Namecheap → Domain List → nearpay.money → **Manage** → Nameservers → **Custom DNS** → enter the two Cloudflare nameservers → ✓ save.
- [ ] Wait until Cloudflare shows the domain as **Active** (minutes to a few hours; Cloudflare emails you). Then continue.
- [ ] **SSL/TLS → Overview**: encryption mode **Full (strict)**. (Tunnel traffic is encrypted end to end anyway; this mode only matters for anything not on the tunnel.)
- [ ] **SSL/TLS → Edge Certificates**: **Always Use HTTPS On**, **Minimum TLS Version 1.2**, **Automatic HTTPS Rewrites On**. Enable **HSTS** (max-age 6 months, include subdomains On, preload Off, No-Sniff On) once all hostnames of step 5 load over https.
- [ ] **Rules → Settings → Managed Transforms**: turn on **"Add visitor location headers"** (NearPay's geo rules read `CF-IPCountry` / `CF-Region-Code`).

## 5. Create the tunnel and copy its token

- [ ] Cloudflare dashboard → **Zero Trust** (left menu). The first time, choose a **team name** (e.g. `nearpay`; it becomes `nearpay.cloudflareaccess.com`) and the **Free** plan. It may ask for a card; the Free plan costs $0.
- [ ] Zero Trust → **Networks → Tunnels → Create a tunnel** → **Cloudflared** → name `nearpay-beta` → Save.
- [ ] On "Install and run a connector", choose **Docker**. The command shown ends with `--token eyJ…`. Copy **only the token** (the long `eyJ…` string). This goes to `.secrets/beta/cloudflared_token` (step 13). Do **not** run the command: `scripts/beta.sh` runs cloudflared for you.
- [ ] Next → **Public hostnames**. Add these 8, all with **Service: HTTP** and **URL: `traefik:8080`** (no other settings):

  | Subdomain | Domain | Service |
  |---|---|---|
  | *(empty)* | nearpay.money | HTTP `traefik:8080` |
  | `www` | nearpay.money | HTTP `traefik:8080` |
  | `api` | nearpay.money | HTTP `traefik:8080` |
  | `pay` | nearpay.money | HTTP `traefik:8080` |
  | `js` | nearpay.money | HTTP `traefik:8080` |
  | `dashboard` | nearpay.money | HTTP `traefik:8080` |
  | `ops` | nearpay.money | HTTP `traefik:8080` |
  | `docs` | nearpay.money | HTTP `traefik:8080` |

  Cloudflare creates the DNS records for each one. `scripts/beta.sh status` prints this list again. Never point a hostname at anything other than `traefik:8080`: the gateway is what checks every request.

## 6. Turnstile (bot check)

- [ ] Cloudflare dashboard → **Turnstile → Add widget** → name `NearPay beta` → hostnames **`dashboard.nearpay.money`** and **`pay.nearpay.money`** → widget mode **Managed** → Create.
- [ ] Copy the **Site Key** (starts with `0x`) → `.secrets/beta/turnstile_sitekey`, and the **Secret Key** (starts with `0x`) → `.secrets/beta/turnstile_secret` (step 13).

## 7. Cloudflare Access in front of the console (ops.nearpay.money)

**What this is.** Zero Trust is Cloudflare's free login service (free up to 50 users). **Access** is the part that puts a
login page in front of a website: before anyone reaches `ops.nearpay.money`, Cloudflare asks them to sign in and lets
only the email addresses you allow through. Each protected website is an **application** in Access. NearPay then checks
Cloudflare's signed login token again on your Mac (`NP_OPS_AUTH_MODE=cloudflare_access`). For that it needs two
identifiers (not secrets): the application's **AUD tag** (which app the token is for) and your **team domain** (who
issued it).

**Login method: pick one.**
- **Simplest: One-time PIN** (on by default, no setup). Cloudflare emails a 6-digit code to `nearpaydotmoney@gmail.com`.
  This is as safe as your Google account, because the code lands in that Gmail.
- **Sign in with Google** (optional, about 10 minutes): Zero Trust → **Integrations → Identity providers** (older
  dashboards: Settings → Authentication → Login methods) → **Add → Google**, then follow Cloudflare's steps:
  1. [console.cloud.google.com](https://console.cloud.google.com) → new project `nearpay-access` → **APIs & Services →
     OAuth consent screen**: External, app name `NearPay Access`, support email `nearpaydotmoney@gmail.com`, add
     `nearpaydotmoney@gmail.com` as a test user.
  2. **Credentials → Create credentials → OAuth client ID** → Web application → Authorized JavaScript origin
     `https://<team>.cloudflareaccess.com`, Authorized redirect URI
     `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`.
  3. Paste the **Client ID** and **Client secret** into Cloudflare → Save → **Test**.

**Create the application** (dashboard labels as of 2026; older dashboards say "Access → Applications → Add an
application → Self-hosted"):

- [ ] Zero Trust → **Access controls → Applications → Create new application**.
- [ ] Choose **Self-hosted and private**. ("Self-hosted" = a website you run yourself, here behind your tunnel. The
  other choices are SaaS, for logging in to third-party apps like Slack, and private hostnames/IPs, which need the
  Cloudflare One/WARP client on every device. You want a **public hostname**.)
- [ ] Name `NearPay console`. **Add public hostname** → subdomain `ops`, domain `nearpay.money`, **path empty** (this
  covers every path, including the console API `/api/ops/*`).
- [ ] **Access policies → Create new policy**: name `Owner`, Action **Allow**, rule **Include → Emails →
  `nearpaydotmoney@gmail.com`**. Save it and make sure it is attached to the application. (Access denies everyone
  who does not match an Allow policy.)
- [ ] **Login methods**: One-time PIN (and Google if you set it up). Leave "Apply instant authentication" off unless
  you use only one method.
- [ ] **Session Duration: 8 hours** → **Create**.
- [ ] **Copy the AUD tag**: Access controls → Applications → `NearPay console` → **Configure** → **Basic information**
  (on some dashboards **Additional settings** or **Overview**) → **Application Audience (AUD) Tag**: a 64-character
  hex string.
- [ ] **Team domain**: `<team>.cloudflareaccess.com`, from the team name you chose in step 5 (shown under Zero Trust →
  Settings).
- [ ] The first `scripts/beta.sh up` asks for both and saves them in `.secrets/beta/beta.env`. Check: open
  `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` in a browser; it shows a page of keys.

## 8. Firewall (WAF) and bot settings

- [ ] **Security → WAF → Managed rules**: the **Cloudflare Free Managed Ruleset** is **On** (it is by default; turn it on if not).
- [ ] **Security → Settings**: Security level **Medium**. Leave **Bot Fight Mode Off**: it challenges server-to-server calls (merchants' backends calling `api.nearpay.money`) and cannot be skipped per hostname on the Free plan.
- [ ] If merchants' API calls get Cloudflare 403 pages: **Rules → Configuration Rules → Create** → hostname equals `api.nearpay.money` → Browser Integrity Check **Off**.

## 9. Resend (email)

- [ ] Sign up at [resend.com](https://resend.com) with `nearpaydotmoney@gmail.com` (this is only your login). Turn on 2FA (step 1).
- [ ] Emails are sent **from `receipts@nearpay.money`**, not from the Gmail address: Resend (and every sending service) only sends from a domain you own and verify, and nobody can verify `gmail.com`. Replies go to `nearpaydotmoney@gmail.com` (Reply-To), and no mailbox is needed on nearpay.money.
- [ ] **Domains → Add domain** → `nearpay.money`. Resend shows DNS records. Click **"Auto configure"** (Sign in to Cloudflare) or add them by hand in Cloudflare → DNS, each with **Proxy status: DNS only** (grey cloud):
  - **DKIM**: TXT `resend._domainkey` → the long `p=…` value Resend shows.
  - **SPF** for the sending subdomain: MX `send` → `feedback-smtp.<region>.amazonses.com` (priority 10) and TXT `send` → `v=spf1 include:amazonses.com ~all` (use Resend's exact values).
  - **DMARC** (add yourself): TXT `_dmarc` → `v=DMARC1; p=none; rua=mailto:nearpaydotmoney@gmail.com`. After a week of clean reports, change `p=none` to `p=quarantine`.
- [ ] Wait until Resend shows the domain **Verified**. No mailbox is needed: Resend sends as `NearPay <receipts@nearpay.money>`; replies go to `nearpaydotmoney@gmail.com` (Reply-To).
- [ ] **API Keys → Create** → name `nearpay-beta`, permission **Sending access**, domain `nearpay.money` → copy the key (starts with `re_`) → `.secrets/beta/resend_api_key` (step 13).
- [ ] Free plan limits: **100 emails a day**, 3,000 a month. NearPay stops at 90 a day and keeps the last 15 for security and approval mails; you get a Telegram alert when it gets close.

## 10. Optional: support@nearpay.money → your Gmail (Cloudflare Email Routing, free)

- [ ] Cloudflare → nearpay.money → **Email → Email Routing → Get started** → custom address `support` → destination `nearpaydotmoney@gmail.com` → verify the destination (Cloudflare emails you) → let Cloudflare add its MX/TXT records. Resend's records (step 9) stay as they are.

## 11. Telegram bot for alerts

The bot `@NearPay_alertbot` exists already. For the beta you keep its current token (owner decision 2026-11-09):

- [ ] Copy the token BotFather gave you (`123456789:AA…`) → `.secrets/beta/telegram_bot_token` (step 13). Before the VPS move, rotate it: @BotFather → `/revoke` → `@NearPay_alertbot`, put the new token in the same file, run `scripts/beta.sh telegram`.
- [ ] (For a new bot in future: @BotFather → `/newbot` → a name → a username ending in `bot` → copy the token.)
- [ ] On the first `scripts/beta.sh up`, the script asks you to open the bot and press **Start** (or send any message); it then finds your chat by itself and saves it in `.secrets/beta/beta.env`. Every alert and the smoke test message arrive in that chat.

## 12. UptimeRobot (outside check)

- [ ] Sign up at [uptimerobot.com](https://uptimerobot.com) (free) with `nearpaydotmoney@gmail.com`; enable 2FA.
- [ ] **New monitor** → HTTP(s) → URL `https://api.nearpay.money/healthz` → interval **5 minutes** → alert contact: your email (add the Telegram integration too if you like). It turns red when the Mac sleeps, Docker stops, the tunnel drops or identity is not ready.
- [ ] Optional second monitor: `https://nearpay.money`.

## 13. Put the secrets on the Mac

In Terminal, from `nearpay-deploy`. For each value: copy it in the browser, then run the matching line (it writes the clipboard to the file without showing it):

```sh
mkdir -p .secrets/beta && chmod 700 .secrets/beta
pbpaste | tr -d '\n' > .secrets/beta/cloudflared_token     # step 5 (eyJ…)
pbpaste | tr -d '\n' > .secrets/beta/turnstile_sitekey     # step 6 (0x…)
pbpaste | tr -d '\n' > .secrets/beta/turnstile_secret      # step 6 (0x…)
pbpaste | tr -d '\n' > .secrets/beta/resend_api_key        # step 9 (re_…)
pbpaste | tr -d '\n' > .secrets/beta/telegram_bot_token    # step 11 (123456789:AA…)
```

- [ ] All five files exist. The script creates the rest itself (`grafana_admin_password`, `ops_attestation_roots.pem`, `alertmanager.yml`, `beta.env`).

| File in `.secrets/beta/` | Who creates it | Used by |
|---|---|---|
| `cloudflared_token` | you (step 5) | cloudflared |
| `turnstile_sitekey` | you (step 6) | checkout + dashboard builds |
| `turnstile_secret` | you (step 6) | identity, payments |
| `resend_api_key` | you (step 9) | notify (SMTP password) |
| `telegram_bot_token` | you (step 11) | Alertmanager, smoke test |
| `beta.env` | script (Telegram chat id, Access AUD tag and team domain you type in) | Alertmanager config, identity |
| `grafana_admin_password` | script | Grafana (user `admin`) |
| `ops_attestation_roots.pem` | script (Yubico's published roots) | identity (hardware keys, for later) |
| `alertmanager.yml` | script | Alertmanager |

## 14. Start the beta

```sh
scripts/beta.sh up
```

- [ ] It checks the Mac (Docker memory, disk), that every repository is on a clean `main` (and pulls it), the secrets, the Telegram chat, the Access identifiers, the live settings, then builds and starts everything and runs the smoke test. The first run takes a while (image builds). Paste back any `FAIL` or error.
- [ ] At the end it prints the public URLs and "Smoke test passed". Grafana: <http://127.0.0.1:3000> (user `admin`, password in `.secrets/beta/grafana_admin_password`), dashboard **NearPay beta**.
- [ ] **Sign in to the console**: open <https://ops.nearpay.money> → Cloudflare Access → **Sign in with Google** as `nearpaydotmoney@gmail.com`. You are the first operator (`ops_admin`) automatically (`NP_OPS_BOOTSTRAP_EMAIL`); nothing to enrol.
- [ ] Sign up as a merchant yourself at <https://dashboard.nearpay.money> to check the flow (Turnstile, email code, passkey).

## 15. Live setup and the vault (mainnet checklist)

Run **`claude/mainnet-checklist.md` sections A → C** with these beta differences:

- [ ] **A** (pre-mainnet gates) and **B** (vault deploy) are unchanged. The vault account is the owner-controlled one decided at A.4 (for example under `nearpay-money.near`), never under `nearpay.near`.
- [ ] **C.1–C.3**: unchanged (accounts in `local.env`, `scripts/seed.sh live`, `node scripts/live-setup.mjs --apply --deposit all`).
- [ ] **Turn on live auto-debit** (only after **B** and the keeper): set `NP_VAULT_CONTRACT` in `local.env` to the account you deployed the vault to, add `.secrets/live/keeper_key` and `NP_KEEPER_ACCOUNT`, then run `scripts/beta.sh up` again. Until then the beta runs with live auto-debit off: merchants get `auto_debit_unavailable` for live auto-debit, `send_invoice` works, and Grafana/Prometheus show `nearpay_billing_live_vault_configured 0`.
- [ ] **C.4**: use `scripts/beta.sh up` (not `scripts/up.sh local`); the health URL is `https://api.nearpay.money/healthz`.
- [ ] **C.5** (merchant onboarding): the testbed script targets the local stack. In the beta, sign the merchant up in the dashboard, then approve its business details in the console (**KYB cases → Approve**). Interim path while the console's KYB screen is not available to you:

  ```sh
  scripts/beta.sh ops compliance kyb-decide <acct_…> approved --reason "beta: details reviewed by owner"
  ```

  The beta runs strict (`NP_ENV=server`) but with the destination **cool-off set to 0** (`NP_COOLOFF_SECONDS=0`): a new settlement destination is usable at once; its attestation, step-up and the activation email still apply.
- [ ] **C.6**: the dashboard shows **Live**; the console shows the kill switch **off**; Grafana's "Kill switch" tile says off.

## Console sign-in (decided 2026-11-09)

- **Google login through Cloudflare Access** (`NP_OPS_AUTH_MODE=cloudflare_access`): Access lets only `nearpaydotmoney@gmail.com` in (session 8 hours, one-time PIN as fallback), and identity verifies Access's token on every console request. Actions that need a fresh confirmation ask you to log in to Access again. Protect the Google account with an authenticator app and printed backup codes (step 1): it is the key to the console.
- **Two-person rule, adaptive:** while you are the only active operator, approvals that normally need a second operator are completed by you after a short delay, with a reason, and each sends a Telegram **NOTICE: single-operator action: …**. If you ever get one you did not cause: Zero Trust → Access → revoke sessions, then secure the Google account. Once a second operator exists, the normal two-person approval applies again.
- Passkey mode with hardware keys stays available for later (`compose/identity/ops-aaguids.beta.txt`, `.secrets/beta/ops_attestation_roots.pem`).

## When an alert fires (Telegram)

Each message says what is wrong, where, since when, and a first command to try. Common ones:

| Alert | First thing to do |
|---|---|
| ServiceDown / PlatformComponentDown | `scripts/beta.sh status`, then `scripts/beta.sh logs <container>`; `scripts/beta.sh up` restarts what is missing |
| ErrorSpike / EdgeErrorSpike | `scripts/beta.sh logs <service>-api`; Grafana → Requests |
| KillSwitchEngaged | live payments are stopped on purpose by sentinel: read `scripts/beta.sh logs sentinel-api`, decide in the console |
| ReconciliationDifference, QuoteIntegrityFailure | money-path checks: stop and look (`logs payments-worker` / `logs rails-api`) before anything else |
| FinalityRecheckFailed | a Base/Arbitrum payment confirmed on L2 blocks was contradicted (or not finalized in 2 h) at Ethereum finality; it still shows succeeded: `logs rails-tracker` (`ALERT finalized re-check`), open the execution's evidence trail in the console, hold delivery until checked |
| OutboxBacklog, DeadLetters, WebhookBacklog | a service or NATS is stuck: `logs` of the service named, then `scripts/beta.sh up` |
| KeeperCollectFailed, KeeperStuck, VaultEventsRejected | auto-debit collections: `logs billing-worker`; check the keeper account has NEAR for gas |
| EmailCapLow, EmailCapped, EmailFailures | Resend dashboard → Usage / Logs; `logs notify-worker` |
| DiskLow, DiskCritical | `docker system df`, `docker image prune`, `docker builder prune`; raise Docker Desktop's disk limit |
| SingleOperatorAction (notice) | confirm it was you (see "Console sign-in") |

UptimeRobot emails you separately when the site is unreachable from outside: check the Mac is awake, Docker Desktop is running, then `scripts/beta.sh up`.

## Day to day

| Command | What it does |
|---|---|
| `scripts/beta.sh status` | containers, firing alerts, keep-awake, memory per container, the tunnel hostnames |
| `scripts/beta.sh logs <container>` | follow logs (`cloudflared`, `traefik`, `payments-api`, `notify-worker`, …) |
| `scripts/beta.sh smoke` | public URLs, Access on ops, Prometheus targets, outbound hosts, Telegram test message |
| `scripts/beta.sh up` | update to the latest `main` everywhere and restart what changed (safe to repeat) |
| `scripts/beta.sh down` | stop the beta (data is kept) and let the Mac sleep |
| `scripts/beta.sh telegram` | find the Telegram chat again (e.g. after a new bot token) |

- After a macOS update or reboot: sign in, wait for Docker Desktop, run `scripts/beta.sh up`.
- The beta keeps its own data (Compose project `nearpay-beta`), separate from the local test stack; `beta.sh up` stops the local stack if it is running. There are no backups in v1.
- Monitoring UIs listen on `127.0.0.1` only: Grafana `:3000`, Prometheus `:9090`, Alertmanager `:9093`.
