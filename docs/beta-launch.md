# NearPay closed beta: launch runbook (owner)

The beta is the full v1 product in **live mode on mainnet**, served at **nearpay.money** from your Mac (Docker Desktop)
through a **Cloudflare Tunnel**: no router ports are opened. Anyone can sign up and go live at once by saving their
business details (open onboarding, ADR-0024); payments confirm on one block of their own chain (ADR-0022). Email goes out through **Resend**, alerts come to **Telegram**, and an external
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
| Google Cloud (optional) | cloud | an OAuth client for "Continue with Google" on the dashboard (step 13a); identity verifies Google's tokens itself |
| Autoheal, watchdog | your Mac (a container; launchd jobs) | restart what fails, start the beta at login, keep the Mac awake ("Uptime" below) |
| UptimeRobot | cloud | checks the five public URLs every 5 minutes from outside |

---

## 0. Before you start

- [ ] Docker Desktop is installed and running, with **Settings → Resources → Memory: 10 GB** (8 GB is the minimum; the beta's memory limits are sized for 10) and **Disk usage limit ≥ 64 GB**. Turn on **Settings → General → Start Docker Desktop when you sign in to your computer**.
- [ ] Node.js 22, pnpm (`corepack enable`), git and the NearPay repositories in `~/work/near-hackathon/` (as for the local stack). The script builds every image from each repository's `main`.
- [ ] `compose/env/local.env` has the live accounts from the mainnet checklist **C.1** (`NP_TREASURY_ACCOUNT`, `NP_RELAYER_ACCOUNT`, `NP_NEAR_RPC_URLS`, your RPC URLs) and `.secrets/live/relayer_key_1` … `relayer_key_4` exist (prepared on 7 Nov). **`NP_VAULT_CONTRACT` is optional for the first start**: leave it empty until the vault is deployed (live auto-debit stays off; `beta.sh` warns). Never set it to an account under `nearpay.near` such as `v1.vault.nearpay.near`: NearPay does not control `nearpay.near`, so payers' mandate funding would go to someone else's contract (`beta.sh` refuses it). The keeper key can come later too (step 15).
- [ ] The Mac stays **plugged in with the lid open**. In **System Settings → Battery (or Energy) → Options**: turn on "Prevent automatic sleeping on power adapter when the display is off" and "Wake for network access". The sleep and power commands are in **"Uptime" → "Once, by you"** below; `scripts/beta.sh doctor` checks them.

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

The Mac cannot report that it is off, asleep or offline. UptimeRobot checks the site from outside every 5 minutes
(free plan: 50 monitors, 5-minute interval) and tells you.

- [ ] Sign up at [uptimerobot.com](https://uptimerobot.com) (free) with `nearpaydotmoney@gmail.com`; enable 2FA (My settings → Two-factor authentication).
- [ ] **Telegram as alert contact**: **Integrations** (on some dashboards **Integrations & Team**) → **Telegram** → **Add**. It opens UptimeRobot's Telegram bot: press **Start**, and the chat becomes an alert contact. If UptimeRobot marks Telegram as a paid integration on your account, use **email** plus the **UptimeRobot mobile app** (push notifications, free) instead; the Mac's own watchdog alerts on Telegram either way.
- [ ] **New monitor** five times, each **HTTP(s)** (website monitoring), interval **5 minutes**, notifications **Telegram** (and email):

  | Friendly name | URL | Notes |
  |---|---|---|
  | NearPay API | `https://api.nearpay.money/healthz` | 200 only while sign-in (identity) is ready; optional: type **Keyword**, keyword `ok`, alert when it does **not** exist |
  | NearPay site | `https://nearpay.money` | marketing site |
  | NearPay checkout | `https://pay.nearpay.money` | hosted checkout |
  | NearPay dashboard | `https://dashboard.nearpay.money` | merchant dashboard |
  | NearPay docs | `https://docs.nearpay.money` | docs |

- [ ] Optional public status page: **Status pages → New status page** → name `NearPay status`, add the five monitors → Save. It gets a free `stats.uptimerobot.com/…` address you can give beta merchants (your own domain on it is a paid feature).
- [ ] They turn red when the Mac sleeps or is off, Docker stops, the tunnel drops, the home internet is down, or identity is not ready. The watchdog on the Mac usually fixes the last three by itself within minutes (see "Uptime").

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
| `google_client_secret` | you (step 13a, optional); the script creates it **empty** when absent (= Google sign-in off) | identity |

## 13a. Optional: "Continue with Google" on the dashboard (ADR-0026)

Merchants can then sign up and sign in with their Google account next to the passkey. Skip this step and the dashboard
simply shows no Google button (everything else works). This is **not** the console login (step 7 stays as it is), and
Google never replaces the passkey for sensitive actions (payout destinations, refunds, API keys, team).

In the [Google Cloud console](https://console.cloud.google.com/), signed in as `nearpaydotmoney@gmail.com`:

- [ ] **Project**: top bar → project picker → **New project** → name `NearPay` → Create, and select it.
- [ ] **OAuth consent screen** (menu → **Google Auth Platform** → **Branding**; older consoles: **APIs & Services → OAuth consent screen**) → **Get started**:
  - App name `NearPay`, user support email `nearpaydotmoney@gmail.com`.
  - Audience: **External**.
  - Contact email: `nearpaydotmoney@gmail.com` → agree to the policy → **Create**.
  - **Branding**: app home page `https://nearpay.money`, privacy policy and terms links on `https://nearpay.money` if you have them, **Authorized domains**: add `nearpay.money` → Save.
  - **Data access** → **Add or remove scopes** → tick exactly **`openid`**, **`.../auth/userinfo.email`** (`email`) and **`.../auth/userinfo.profile`** (`profile`) → Update → Save. Nothing else (these are non-sensitive scopes: no Google verification review is needed).
  - **Audience**: while the app is in **Testing**, only the test users you add here can sign in (up to 100) — add the Google accounts of your beta merchants, or press **Publish app** to open it to every Google account (with only these three scopes Google publishes without a review; the consent screen shows "NearPay" and nearpay.money).
- [ ] **Clients** (Google Auth Platform → **Clients**; older consoles: **APIs & Services → Credentials → Create credentials → OAuth client ID**) → **Create client**:
  - Application type: **Web application**, name `NearPay dashboard`.
  - **Authorized JavaScript origins**: `https://dashboard.nearpay.money`
  - **Authorized redirect URIs**: `https://dashboard.nearpay.money/api/auth/google/callback` (exactly this, no trailing slash)
  - **Create**. Copy the **Client ID** (`…apps.googleusercontent.com`) and the **Client secret** (`GOCSPX-…`; download the JSON if you want a copy — keep it out of chats and repositories).
- [ ] On the Mac, from `nearpay-deploy`:

  ```sh
  pbpaste | tr -d '\n' > .secrets/beta/google_client_secret     # the Client secret (GOCSPX-…)
  echo 'NP_GOOGLE_CLIENT_ID=<paste the Client ID>' >> .secrets/beta/beta.env   # not a secret
  scripts/beta.sh up
  ```

- [ ] `beta.sh up` prints **Continue with Google: on**, and the smoke test checks that the dashboard offers it. Open <https://dashboard.nearpay.money/signin>: the white **Continue with Google** button is above the passkey option.
- [ ] Check it once with a Google account that has **no** NearPay user yet: you land on the setup checklist of a new account. A Google account whose email already has a NearPay user is refused on purpose ("This email already has a NearPay account. Sign in with your passkey, then connect Google in Settings."): sign in with the passkey, then **Settings → Account & payments → Sign-in methods → Connect Google**.
- [ ] To switch it off again: empty the secret (`: > .secrets/beta/google_client_secret`) and run `scripts/beta.sh up`. Users who only ever used Google and never added a passkey then cannot sign in until it is on again (the API's email recovery, which adds a passkey, has no dashboard page yet), so ask them to add a passkey first (the dashboard prompts them at their first sensitive action). To rotate the secret: add a new secret to the client in Google Cloud, write it to the file, `scripts/beta.sh up`, then delete the old one in Google Cloud.

## 14. Start the beta

```sh
scripts/beta.sh up
```

- [ ] It checks the Mac (Docker memory, disk), that every repository is on a clean `main` (and pulls it), the secrets, the Telegram chat, the Access identifiers, the live settings, then builds and starts everything and runs the smoke test. The first run takes a while (image builds). Paste back any `FAIL` or error.
- [ ] At the end it prints the public URLs and "Smoke test passed". Grafana: <http://127.0.0.1:3000> (user `admin`, password in `.secrets/beta/grafana_admin_password`), dashboard **NearPay beta**.
- [ ] **Sign in to the console**: open <https://ops.nearpay.money> → Cloudflare Access → enter `nearpaydotmoney@gmail.com` and the one-time code emailed to it (or **Sign in with Google** if you set it up in step 7). Team domain: `nearpay-money.cloudflareaccess.com`. You are the first operator (`ops_admin`) automatically (`NP_OPS_BOOTSTRAP_EMAIL`); nothing to enrol.
- [ ] Sign up as a merchant yourself at <https://dashboard.nearpay.money> to check the flow (Turnstile, email code, passkey; and **Continue with Google** if you did step 13a).

## 15. Live setup and the vault (mainnet checklist)

Run **`claude/mainnet-checklist.md` sections A → C** with these beta differences:

- [ ] **A** (pre-mainnet gates) and **B** (vault deploy) are unchanged. The vault account is the owner-controlled one decided at A.4 (for example under `nearpay-money.near`), never under `nearpay.near`.
- [ ] **C.1–C.3**: unchanged (accounts in `local.env`, `scripts/seed.sh live`, `node scripts/live-setup.mjs --apply --deposit all`).
- [ ] **Turn on live auto-debit** (only after **B** and the keeper): set `NP_VAULT_CONTRACT` in `local.env` to the account you deployed the vault to, add `.secrets/live/keeper_key` and `NP_KEEPER_ACCOUNT`, then run `scripts/beta.sh up` again. Until then the beta runs with live auto-debit off: merchants get `auto_debit_unavailable` for live auto-debit, `send_invoice` works, and Grafana/Prometheus show `nearpay_billing_live_vault_configured 0`.
- [ ] **C.4**: use `scripts/beta.sh up` (not `scripts/up.sh local`); the health URL is `https://api.nearpay.money/healthz`.
- [ ] **C.5** (merchant onboarding): the testbed script targets the local stack. In the beta, sign the merchant up in the dashboard and save its business details (**Settings → Business details**; the registration number is optional). There is **no approval step**: with `NP_KYB_MODE=auto` (the beta default, open onboarding — ADR-0024) the business goes live at once and the dashboard shows "You're live — you can accept real payments". A business registered in a blocked country is declined automatically. The console's **Businesses** list shows every business with its screening result; use it (or **Merchants → suspend**) only for abuse.

  To turn a manual review back on, set `NP_KYB_MODE=manual` in `compose/env/beta.env` and run `scripts/beta.sh up`; then decide each business in the console (**Businesses → Submitted**) or with:

  ```sh
  scripts/beta.sh ops compliance kyb-decide <acct_…> approved --reason "beta: details reviewed by owner"
  ```

  The beta runs strict (`NP_ENV=server`). Payout wallets have **no cool-off** (owner decision 2026-11-11, final; `NP_COOLOFF_SECONDS=0`, also identity's default): a new payout wallet is active, and live payments to it possible, as soon as its ownership is signed (and a second owner/admin approves, when the account has two); its screening, step-up and the "payout wallet active" security email still apply.
- [ ] **C.6**: the dashboard shows **Live**; the console shows the kill switch **off**; Grafana's "Kill switch" tile says off.

## Uptime

The beta runs on one Mac, so "never stops" means: everything that can restart itself does, within about a minute,
and you hear about anything that cannot. Three layers do that:

| Layer | Watches | Does by itself | Tells you |
|---|---|---|---|
| Docker (`restart: unless-stopped`) | each container's process | restarts a container whose process exits; restarts every container when Docker Desktop starts | — |
| **autoheal** (a container in the stack) | each container's health check | restarts a container that stays **unhealthy** (Docker never does): after ~3 min of failed checks, then with backoff 2, 4, 8, 16, 30 min, at most 3 restarts per 10 min. When many are unhealthy at once the Mac is overloaded: it holds back (restarting would add load). Postgres is left to you | Telegram via Alertmanager: `ContainerAutoHealed`, `ContainerUnhealthy`, `AutohealHeld`, `AutohealDown` |
| **watchdog** (launchd, every minute) | Docker Desktop, stopped or missing containers, the public URLs through Cloudflare | opens Docker Desktop; `docker start` for a stopped service; `scripts/beta.sh up --no-pull` when containers are missing (at most every 15 min); restarts `cloudflared` when every URL fails with a tunnel error | Telegram directly (works even when Alertmanager is down): once when a problem starts, every 6 h while it lasts, once when it clears |
| **UptimeRobot** (cloud) | the five public URLs from outside | — | Telegram or email/app: the Mac is off, asleep or offline |

Also automatic now:

- **Health checks**: every long-running container has one. They check **liveness** (is the process answering?
  NearPay services: `GET /healthz`), never readiness, so a Postgres or NATS outage makes services *not ready* but
  never triggers a wave of restarts. `cloudflared` is healthy while it holds a connection to Cloudflare.
- **At login** (launchd `money.nearpay.beta.autostart`): waits for Docker Desktop (opens it if needed), gives Docker a
  minute to restart the containers, then runs `scripts/beta.sh up --no-pull` only if containers are missing. It sends a
  Telegram note so you know the Mac restarted.
- **Keep-awake** (launchd `money.nearpay.beta.keepawake`): `caffeinate -ims` owned by launchd, so closing Terminal or
  logging out of a shell does not end it, and launchd restarts it if it dies.
- **Memory limits**: each NearPay process stops at 1 GB (it restarts instead of starving the Mac); Postgres has no cap
  and the kernel's out-of-memory killer picks any other container first. Postgres and Valkey are sized for 10 GB.
- **Disk**: every container's log rotates at 10 MB × 3; Prometheus keeps at most 2 GB.
- **Deploys**: `scripts/beta.sh up` silences only the availability alerts (`ServiceDown`, `PlatformComponentDown`,
  the container alerts) while it recreates containers, and lifts the silence after the smoke test. Money-path alerts
  are never silenced. The smoke test retries each check with backoff before it reports a failure.
- **`scripts/beta.sh down`** means "off on purpose": it leaves a marker, so autostart, keep-awake and the watchdog
  stand still until the next `scripts/beta.sh up`. Stopping containers any other way (Docker Desktop's stop button,
  `docker stop`) is undone by the watchdog within a minute.

### Once, by you

1. **Docker Desktop** → Settings → General → tick **Start Docker Desktop when you sign in to your computer**. Settings →
   Resources → Memory **10 GB** → Apply & restart.
2. **Never sleep on the power adapter** (Terminal, your Mac password):

   ```sh
   sudo pmset -c sleep 0 disksleep 0
   sudo pmset autorestart 1        # start again by itself after a power failure (desktop Macs; MacBooks skip it)
   sudo pmset -c womp 1            # wake for network access
   ```

   Keep it **plugged in with the lid open** (a MacBook with the lid closed sleeps unless an external display, keyboard
   and mouse are attached).
3. **macOS updates**: System Settings → General → Software Update → Automatic updates (i) → turn off **Install macOS
   updates** for the beta (keep "Download new updates"). Install updates yourself at a quiet time.
4. **Login after a restart.** Launchd jobs and Docker Desktop need you signed in. Keep **FileVault on** (the live
   relayer keys are on this disk): macOS then cannot log in by itself, so after a power cut or crash the beta stays down
   until you type your password at the Mac (UptimeRobot tells you). For a planned restart run
   `sudo fdesetup authrestart`: the Mac restarts, unlocks the disk once and signs in, and the beta comes back alone.
   (Automatic login — System Settings → Users & Groups → Automatically log in as — is only possible with FileVault
   off; not recommended here.) Locking the screen is fine; do not log out.
5. **Install the launchd jobs** (after the beta has started once with `scripts/beta.sh up`):

   ```sh
   scripts/beta.sh install-autostart
   scripts/beta.sh doctor          # every check with its fix; repeat until there is no FAIL
   ```

   Keep the repositories where they are (`~/work/near-hackathon/`): macOS does not let launchd jobs read Desktop,
   Documents or Downloads. Remove the jobs with `scripts/beta.sh uninstall-autostart`.
6. **UptimeRobot**: step 12.
7. Optional, free: **a dead man's switch** that alerts when the Mac stops checking in (asleep, off, offline, launchd
   stuck). [healthchecks.io](https://healthchecks.io) → sign up → **Add check** → name `nearpay-beta-mac`, period
   **1 minute**, grace **5 minutes** → **Integrations → Telegram** (follow its link, press Start) → copy the check's
   **ping URL** and, on the Mac: `pbpaste | tr -d '\n' > .secrets/beta/healthchecks_url`. The watchdog pings it every
   round (a `/fail` ping while it sees a problem).
8. Optional: Cloudflare → nearpay.money → **Caching → Configuration → Always Online → On** (free). When the origin is
   unreachable, Cloudflare may show a cached copy of public pages such as the marketing site and docs; it never covers
   the API, checkout or dashboard, and it does not help with every tunnel error. Custom error pages ("we'll be right
   back") need a paid Cloudflare plan.
9. Check: `scripts/beta.sh status` starts with the **Uptime** summary — Docker, containers, tunnel, autoheal,
   watchdog (last round), the public health URL, keep-awake, autostart, kill switch and live routing.

### When something fires

| Message | What it means | What to do |
|---|---|---|
| `ContainerAutoHealed` | autoheal restarted a container whose health check kept failing | nothing if it is a one-off; if it repeats: `scripts/beta.sh logs <container>` |
| `ContainerUnhealthy` | still unhealthy after 10 min (autoheal backing off, or Postgres, which it never restarts) | `scripts/beta.sh logs <container>`; then `docker restart <container>` |
| `AutohealHeld` | many containers unhealthy at once: the Mac or Docker is overloaded | `docker stats --no-stream`, `scripts/beta.sh doctor`; free memory/CPU (close apps), check the disk (`DiskLow`) |
| `AutohealDown` | autoheal is not running (the watchdog still restarts unhealthy containers after 5 min) | `scripts/beta.sh logs autoheal`, `scripts/beta.sh up` |
| watchdog: Docker Desktop is not answering | Docker Desktop quit or hung | it is being opened; if it does not come back, quit and reopen Docker Desktop (or restart the Mac with `sudo fdesetup authrestart`) |
| watchdog: beta containers are missing | containers were removed | the watchdog runs `scripts/beta.sh up --no-pull`; its output: `~/Library/Logs/NearPay/watchdog-up.log` |
| watchdog: these containers keep stopping | a service exits right after starting | `scripts/beta.sh logs <name>` (a missing secret, config or database error) |
| watchdog: public URLs fail | Cloudflare cannot reach the stack; on tunnel errors (530) the watchdog restarts cloudflared | `scripts/beta.sh logs cloudflared`; a 503 on the API = identity not ready: `scripts/beta.sh logs identity-api` |
| watchdog: the Mac cannot reach the internet | router, Wi-Fi or ISP | fix the connection; everything resumes by itself |
| UptimeRobot / Healthchecks.io: down | the Mac is off, asleep, offline or signed out | go to the Mac: power, lid, network, sign in; then `scripts/beta.sh status` |

To work on the stack without the watchdog interfering: `scripts/beta.sh watchdog pause 30` (minutes; it still checks
and alerts, it only stops healing), then `scripts/beta.sh watchdog resume`. Its log: `scripts/beta.sh watchdog log`
(`~/Library/Logs/NearPay/watchdog.log`).

### What can still take the beta down

| Single point of failure | Cheapest mitigation |
|---|---|
| The Mac itself (hardware, macOS crash, a restart that waits at the FileVault screen) | `sudo pmset autorestart 1`; planned restarts with `sudo fdesetup authrestart`; UptimeRobot + Healthchecks.io tell you within 5 min; after the beta: the VPS move |
| Power | keep the MacBook plugged in (its battery bridges short cuts); a small UPS for the router and a desktop Mac |
| Home internet / router | a phone hotspot as fallback (cloudflared reconnects by itself over any network); UPS for the router |
| Docker Desktop (hangs, updates) | the watchdog reopens it; turn off Docker Desktop's automatic updates during the beta (Settings → Software updates) |
| Postgres (one instance, no backups in v1) | the disk alerts (`DiskLow`, `DiskCritical`); never `docker compose down -v`; backups arrive with the VPS |
| Cloudflare (DNS, tunnel, Access) | none needed at this size (Cloudflare's own redundancy); the tunnel keeps four connections to two data centres |

## Console sign-in (decided 2026-11-09)

- **Cloudflare Access** (`NP_OPS_AUTH_MODE=cloudflare_access`, team `nearpay-money`): Access lets only `nearpaydotmoney@gmail.com` in with an emailed one-time code (Google login optional, step 7; session 8 hours), and identity verifies Access's token on every console request. Actions that need a fresh confirmation ask you to log in to Access again. Protect the Google account with an authenticator app and printed backup codes (step 1): it is the key to the console.
- **Two-person rule, adaptive:** while you are the only active operator, approvals that normally need a second operator are completed by you after a short delay, with a reason, and each sends a Telegram **NOTICE: single-operator action: …**. If you ever get one you did not cause: Zero Trust → Access → revoke sessions, then secure the Google account. Once a second operator exists, the normal two-person approval applies again.
- Passkey mode with hardware keys stays available for later (`compose/identity/ops-aaguids.beta.txt`, `.secrets/beta/ops_attestation_roots.pem`).

## When an alert fires (Telegram)

Each message says what is wrong, where, since when, and a first command to try. Common ones:

| Alert | First thing to do |
|---|---|
| ServiceDown / PlatformComponentDown | `scripts/beta.sh status`, then `scripts/beta.sh logs <container>`; `scripts/beta.sh up` restarts what is missing |
| ErrorSpike / EdgeErrorSpike | `scripts/beta.sh logs <service>-api`; Grafana → Requests |
| KillSwitchEngaged | live payments are stopped on purpose by sentinel: read `scripts/beta.sh logs sentinel-api`, decide in the console |
| LivePaymentsNotRouting | every live payment option is unavailable (payers see "Payments are temporarily unavailable"): the message lists the reasons; see "Payments are temporarily unavailable" below |
| TokenRegistryStale | rails cannot load the token list from 1Click: `scripts/beta.sh logs rails-feeds \| grep 'ALERT token_registry_refresh_failed'`, then `scripts/beta.sh logs egress-proxy` |
| ReconciliationDifference, QuoteIntegrityFailure | money-path checks: stop and look (`logs payments-worker` / `logs rails-api`) before anything else |
| FinalityRecheckFailed | a payment confirmed on one block (EVM incl. Ethereum, Solana `confirmed`, Bitcoin 1 confirmation) was contradicted at finality — EVM `finalized` (2 h), Solana `finalized` (30 min), Bitcoin 6 confirmations (6 h) — or not final in that window; it still shows succeeded: `logs rails-tracker` (`ALERT finalized re-check`), open the execution's evidence trail in the console, hold delivery until checked |
| OutboxBacklog, DeadLetters, WebhookBacklog | a service or NATS is stuck: `logs` of the service named, then `scripts/beta.sh up` |
| KeeperCollectFailed, KeeperStuck, VaultEventsRejected | auto-debit collections: `logs billing-worker`; check the keeper account has NEAR for gas |
| EmailCapLow, EmailCapped, EmailFailures | Resend dashboard → Usage / Logs; `logs notify-worker` |
| DiskLow, DiskCritical | `docker system df`, `docker image prune`, `docker builder prune`; raise Docker Desktop's disk limit |
| ContainerAutoHealed, ContainerUnhealthy, AutohealHeld, AutohealDown, watchdog messages | see "Uptime" → "When something fires" |
| SingleOperatorAction (notice) | confirm it was you (see "Console sign-in") |

### "Payments are temporarily unavailable"

The checkout shows this when rails marks every payment option unavailable. Rails always knows why: see the reasons with

```sh
scripts/beta.sh routing                          # from Prometheus: ok, or each blocking reason with its fix
scripts/beta.sh ops rails routing-health live    # straight from rails: reasons, settlement assets affected, registry age
```

(Prometheus: `nearpay_rails_routing_available{livemode="true"}` is 0 and `nearpay_rails_routing_blocked{livemode="true",reason="…"}` is 1 per reason; rails-api logs `ALERT routing_blocked` when it starts, and payments-api logs `no payment option available` once per checkout session with the same codes.)

| Reason | What it means | Fix |
|---|---|---|
| `kill_switch_engaged` | sentinel's kill switch stops live payments on purpose | find out why (`scripts/beta.sh logs sentinel-api`, console audit log), then release it in the console (**Kill switch**) |
| `kill_switch_unknown` | rails could not read the kill switch from sentinel, so it refuses live payments (fail closed) | `scripts/beta.sh logs rails-api \| grep 'ALERT kill_switch_unknown'`: `cause` says why (`auth` = rails' service token refused, `network:*`/`timeout` = sentinel unreachable, `sentinel_url_unset`); check `sentinel-api` is up. It clears by itself within 10 s of sentinel answering |
| `treasury_unset` | `NP_TREASURY_ACCOUNT` (NearPay's live fee recipient) is not configured | set it in `compose/env/local.env` (mainnet checklist C.1), then `scripts/beta.sh up` |
| `cross_chain_paused` | an operator paused cross-chain routes (control flag) | `scripts/beta.sh ops rails flag-set cross_chain_enabled true "resume: <why>"` |
| `settlement_price_stale` | the settlement asset's 1Click price is older than 5 minutes (by 1Click's own timestamp) | rails-feeds is not refreshing prices: `scripts/beta.sh logs rails-feeds \| grep 'ALERT token_registry_refresh_failed'` (`error_class` says why: `proxy_denied`, `network:*`, `auth`, `timeout`, `empty`), then `scripts/beta.sh logs egress-proxy` |
| `settlement_price_missing` | a price source has no price for the settlement asset (1Click list, or CoinGecko for non-stablecoins) | `scripts/beta.sh logs rails-feeds` (token refresh, secondary-prices) |
| `settlement_price_depeg` | the settlement stablecoin is more than 2 % off its peg: NearPay refuses to settle at par | nothing to fix in NearPay; wait, or settle in another asset |
| `settlement_price_disagree` | 1Click and CoinGecko disagree by more than 1.5 % on a non-stablecoin | usually clears by itself; `scripts/beta.sh logs rails-feeds` |
| `fx_unavailable` | no current ECB rate for the stablecoin's peg currency | `scripts/beta.sh logs rails-feeds \| grep -i fx`; check the egress proxy reaches the ECB |
| `token_registry_stale` (warning) | the token list has not refreshed for 90 s; prices go stale (and payments stop) after 5 minutes | as for `settlement_price_stale` |

The price checks are never relaxed to get payments going again: fix the feed, not the rule.

UptimeRobot alerts you separately when the site is unreachable from outside: check the Mac is awake, signed in and online; `scripts/beta.sh status` shows the rest ("Uptime").

## Day to day

| Command | What it does |
|---|---|
| `scripts/beta.sh status` | the uptime summary (containers, tunnel, autoheal, watchdog, keep-awake, autostart, kill switch, live routing), firing alerts, memory per container, the tunnel hostnames |
| `scripts/beta.sh doctor` | is this Mac set up to keep the beta running on its own? each problem with its fix |
| `scripts/beta.sh watchdog pause 30` / `resume` / `log` | stop the watchdog healing for a while (it still alerts), resume, show its log |
| `scripts/beta.sh install-autostart` / `uninstall-autostart` | the launchd jobs: start at login, keep awake, watchdog every minute |
| `scripts/beta.sh logs <container>` | follow logs (`cloudflared`, `traefik`, `payments-api`, `notify-worker`, …) |
| `scripts/beta.sh smoke` | public URLs, Access on ops, Prometheus targets, live payments can route, outbound hosts, Telegram test message |
| `scripts/beta.sh routing` | can live payments route? if not, each reason with its fix ("Payments are temporarily unavailable") |
| `scripts/beta.sh up` | update to the latest `main` everywhere and restart what changed (safe to repeat) |
| `scripts/beta.sh down` | stop the beta on purpose (data is kept): autostart, keep-awake and the watchdog stand still until `up` |
| `scripts/beta.sh telegram` | find the Telegram chat again (e.g. after a new bot token) |

- After a macOS update or reboot: sign in (FileVault asks for your password once); Docker Desktop and the beta start by themselves, and Telegram says so. `scripts/beta.sh status` to check.
- The beta keeps its own data (Compose project `nearpay-beta`), separate from the local test stack; `beta.sh up` stops the local stack if it is running. There are no backups in v1.
- Monitoring UIs listen on `127.0.0.1` only: Grafana `:3000`, Prometheus `:9090`, Alertmanager `:9093`.
