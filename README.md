# nearpay-deploy

How NearPay runs: the Docker Compose stack (local, server and observability profiles), Postgres init, Traefik config, env templates, the scripts that start it (`scripts/up.sh` locally, `scripts/beta.sh` for the live beta) and the local package registry every repository installs from.

Part of [NearPay](https://github.com/nearpay-money/nearpay) — start there for the live demo, the architecture diagram and the full "do X, see Y" walkthrough.

- **Where it sits:** it builds an image from every service and web app repository and runs them together. `scripts/up.sh local` is step 2 of the entry repository's local walkthrough (Path E); `scripts/registry.sh` is what Path D uses to run one repository's tests without Docker.
- **Status:** NearPay runs on NEAR mainnet as a closed beta (https://nearpay.money). That deployment is this repository's Compose stack started by `scripts/beta.sh up` behind a Cloudflare Tunnel, with Prometheus, Alertmanager and Grafana (`docs/beta-launch.md`).

| | |
|---|---|
| Group | Platform |
| Kind | GitOps |
| Ships as | Argo CD source of truth |
| Owns | Runtime configuration |
| Depends on (published artifacts only) | images, charts |
| First built in | Stage 1 (step 1.1) |

## Documentation

Design docs live in [`nearpay-brain`](https://github.com/nearpay-money/nearpay-brain), not here.

- `nearpay-brain/lld/platform.md` — **low-level design (dev-ready; implement from this)**
- `nearpay-brain/lld/audits/platform.md` — audit findings already folded into the LLD
- `nearpay-brain/roadmap/development-plan.md` — stage and step this repo is built in
- `nearpay-brain/architecture/hld.md` — system design
- `nearpay-brain/architecture/repositories.md` — repo topology and dependency rules
- `nearpay-brain/architecture/infrastructure.md`
- `nearpay-brain/operations/runbooks.md`

## Local package registry

Every NearPay repository installs `@nearpay-money/*` and `@nearpay-internal/*` from a registry on your machine,
`http://127.0.0.1:4873` (see the `.npmrc` in each repository); everything else comes from npmjs. One command starts
that registry, without Docker:

```sh
git clone https://github.com/nearpay-money/nearpay-deploy
nearpay-deploy/scripts/registry.sh
# registry: up on http://127.0.0.1:4873 (24 packages, 122 versions)

cd nearpay-node        # or any other NearPay repository
pnpm install --frozen-lockfile
```

It needs Node.js 22 and nothing else. The first run takes one to two minutes: it installs Verdaccio 6.10.6 from npm
into `.registry/` (git-ignored) and publishes the tarballs in `registry-seed/`, byte for byte the versions the
lockfiles pin. Later runs answer at once. `scripts/registry.sh status` says whether it is up and complete,
`scripts/registry.sh stop` stops it (the packages stay in `.registry/`), `NP_REGISTRY_PORT` moves it to another port.

The Compose stack runs the same Verdaccio version and config as its `registry` service. When that one is already
listening, `scripts/registry.sh` only reports it; `scripts/up.sh` stops the Docker-free one first, because both use
port 4873.

In GitHub Actions, the composite action in `.github/actions/registry` runs the same script on the runner:

```yaml
- uses: actions/setup-node@v4
  with:
    node-version-file: .nvmrc
- uses: nearpay-money/nearpay-deploy/.github/actions/registry@main
- run: pnpm install --frozen-lockfile
```

A later `docker build` that installs from the registry needs `--network host`, so that the build reaches the
runner's `127.0.0.1`.

## Layout

```
nearpay-deploy/
├── compose/
│   ├── compose.yaml            all services, networks, volumes, secrets (profile-independent)
│   ├── compose.local.yaml      local profile: ports on 127.0.0.1, build contexts, registry, Mailpit, merchant demo
│   ├── compose.beta.yaml       beta overlay (nearpay.money from the owner's Mac): cloudflared, Resend, monitoring
│   ├── env/beta.env            beta configuration (NP_ENV=server, nearpay.money, Cloudflare edge), after local.env
│   ├── traefik/traefik.beta.yaml  beta static config: plain HTTP from cloudflared only, forwarded headers, metrics
│   ├── monitoring/             Prometheus (scrape + alert rules), Alertmanager → Telegram, Grafana "NearPay beta"
│   ├── egress/allowlist.yaml   every internet host the live/beta stack calls, per container
│   ├── env/local.env.example   non-secret configuration (copied to local.env on first run)
│   ├── init/postgres/roles.sh  databases and roles per service (idempotent, runs on every up)
│   ├── traefik/                static config + dynamic/routes.yaml (routers, ForwardAuth, TLS) + dynamic/ops.yaml (generated)
│   ├── identity/               ops-aaguids.local.txt (console passkey AAGUID allow-list, local)
│   ├── static/                 nginx for pay, js, dashboard and docs (+ placeholder page); the console has its own image
│   ├── egress-proxy/           Smokescreen image (pinned release)
│   └── registry/config.yaml    Verdaccio for @nearpay-money/* and @nearpay-internal/*
├── scripts/
│   ├── up.sh                   keys → registry seed + publish if missing → build web apps → build images → start, wait healthy
│   ├── registry.sh             the package registry alone, without Docker (start, stop, status)
│   ├── down.sh                 stop (add --volumes to delete local data)
│   ├── beta.sh                 the closed beta: guided preflight, up, down, status, logs, smoke, telegram, ops
│   ├── seed.sh                 keys: test-only secrets and TLS certificate into .secrets/ (git-ignored)
│   ├── live-setup.mjs          one-time mainnet on-chain setup (relayer keys, agent Intents deposit); dry run by default
│   ├── live-setup/             its code, tests and pinned @near-js/* dependencies (own package.json + pnpm lockfile)
│   └── lib/                    seed-keys.mjs, registry-seed.mjs, registry-local.mjs
├── registry-seed/              exact @nearpay* tarballs the lockfiles resolve to (published by up.sh and registry.sh)
├── docs/beta-launch.md          owner runbook for the beta (Cloudflare, Resend, Telegram, UptimeRobot, first start)
├── apps/ charts/ envs/ platform/ secrets/   post-v1 GitOps layout (empty until then)
├── .github/actions/registry/   composite action: scripts/registry.sh on a GitHub runner, for the other repositories' CI
└── .github/workflows/ci.yml
```

## Commands

| Command                       | What it does                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `scripts/up.sh local`         | Start everything that is built; `--no-build` skips image builds, `--build-sites` forces web-app builds |
| `scripts/beta.sh up`          | The closed beta at nearpay.money (owner's Mac; `docs/beta-launch.md`): preflight, build from the sibling mains, start, smoke test. Also `down`, `status`, `logs <svc>`, `smoke`, `telegram`, `ops <svc> <cmd>` |
| `scripts/down.sh`             | Stop the stack; `--volumes` also deletes Postgres, NATS, Valkey and registry data                 |
| `scripts/registry.sh`         | Only the package registry, without Docker (see "Local package registry"); also `stop`, `status`   |
| `scripts/seed.sh data`        | Demo merchant (test mode), merchant-demo key + webhook endpoint, demo agent funded in the sandbox, billing catalogue (product, prices incl. an auto-debit USDC monthly price, tax rate, customer → `.secrets/demo-billing.json`) |
| `scripts/seed.sh live`        | Check owner-provided mainnet credentials in `.secrets/live/` and generate the overlay `up.sh` uses |
| `scripts/seed.sh keys`        | Create missing test-only secrets; `--renew-tls` regenerates the certificate (e.g. after mkcert)   |
| `node scripts/live-setup.mjs` | Mainnet on-chain status of the live accounts; `--apply` sends the missing setup transactions       |
| `docker compose -p nearpay logs -f <service>` | Follow a container's logs                                                         |

**What starts.** The platform always: Traefik (gateway, TLS, ForwardAuth to identity), Postgres 17 with one database and two roles per service, NATS JetStream, Valkey, the Smokescreen egress proxy, nginx for the static sites, Mailpit (`https://mail.nearpay.localhost`) and the package registry (`http://127.0.0.1:4873`). Each NearPay service has a Compose profile named after it and joins once `../nearpay-<service>/Dockerfile` exists: its image is built from that repository, `migrate-<service>` applies migrations with the migrator role, then its processes start with the app role and must turn healthy. `up.sh` lists the services that are not built yet.

**Images.** `up.sh` builds `nearpay/<service>:local` from each built repository with `docker build --network host --build-arg NP_REGISTRY_URL=http://127.0.0.1:4873`, after publishing `nearpay-spec` and `nearpay-kit` to the registry whenever a version in those repositories is missing; Compose never builds or pulls service images. Service Dockerfiles therefore install `@nearpay-money/*` and `@nearpay-internal/*` from `$NP_REGISTRY_URL`, run `node dist/main.js <process>` (api, worker, …) and declare `HEALTHCHECK` with `dist/main.js healthcheck` (`@nearpay-internal/service`).

**Registry.** `up.sh` starts Verdaccio, then publishes every tarball in `registry-seed/` byte for byte (the exact
versions the lockfiles resolve to, checked against `SHA512SUMS`), and builds `nearpay-spec`, `nearpay-kit`,
`nearpay-node` and `nearpay-agentkit` from source only for versions still missing. See `registry-seed/README.md`.
`scripts/registry.sh` runs the same registry without Docker and publishes the same seed (nothing from source).

**Web apps.** nginx serves `nearpay-checkout/dist` (pay), `nearpay-dashboard/dist` and `nearpay-js/dist` (`/v1/nearpay.js`)
from the sibling repositories. `up.sh` runs `pnpm install --frozen-lockfile && pnpm build` in each one whose output is
missing or older than its HEAD commit (and the checkout when it does not pin the current
`.secrets/public/sentinel_keys.json`), then recreates the static container; `--build-sites` rebuilds all three.
Build logs go to a temp file named in the output. Sites without a build (docs) show a placeholder page.

**Console (`https://ops.nearpay.localhost`, local clients only).** `nearpay/console:local` is built from `nearpay-console`'s Dockerfile like a service image (profile `console`). Its API `ops.…/api/ops/*` is routed per owning service by `compose/traefik/dynamic/ops.yaml`, generated from the spec's `OPS_ROUTES` (`node scripts/lib/ops-routes.mjs > compose/traefik/dynamic/ops.yaml`; `--check` reports drift). Operators are added with identity's ops CLI (`ops.js operator-add <email> ops|ops_admin`, or `pnpm ops operator-add` in nearpay-testbed); the enrolment link arrives in Mailpit. The local AAGUID list (`compose/identity/ops-aaguids.local.txt`) also allows virtual authenticators, which identity honours only with `NP_ENV=local`/`test`.

**Gateway routes.** `compose/traefik/dynamic/routes.yaml` is written by hand; `node scripts/lib/public-routes.mjs [<@nearpay-money/spec public-entry.js>]` checks it against the spec's `PUBLIC_ROUTES` (every route on `api.`, and under `/api` on `pay.`/`dashboard.`, must reach its owning service; the anonymous hosted payment-link and invoice pages, CLI login start/poll and attestations must pass a per-IP limit). Stage 3: billing's routes incl. the hosted invoice (`/v1/invoices/{id}/public/**`, per-IP limit) and the subscription test clock (`/v1/test_helpers/subscriptions/*`), the CLI device login (`/v1/cli/logins*` → identity) and the events stream (`GET /v1/events/stream` → webhooks, flushed per event, `X-Accel-Buffering: no`; the entry point has no write timeout). The pay site sends `Referrer-Policy: no-referrer` on the hosted pages `/c/`, `/l/`, `/i/`. Stage 4 (spec 0.4.0): `/v1/mandates*` and the hosted invoice's mandate routes reach billing through its existing routers; the simulated mandate payer `/v1/test_helpers/mandates/*` joins billing's test-helper router. Continue with Google (ADR-0026, spec 0.5.1): `identity-google-callback` maps the redirect URI registered at Google, `dashboard.<domain>/api/auth/google/callback`, to identity's `/v1/auth/google/callback` (`google-callback-path`), and `identity-google-public` puts a per-IP limit (`google-auth-ratelimit`) on the anonymous start and callback routes; `public-routes.mjs` checks both. The beta overlay passes `NP_GOOGLE_CLIENT_ID` and the optional file secret `.secrets/beta/google_client_secret` (empty = off; docs/beta-launch.md step 13a).

**Stage 4 (auto-debit, Solana/Bitcoin).** One vault account per mode is shared by billing (mandates, keeper), rails (forwards its `nearpay_vault` events) and the sandbox (plays the test-mode vault): `NP_VAULT_CONTRACT` (live: the owner-controlled account the vault was deployed to, mainnet checklist A.4/B; no default, empty = live auto-debit off) and `NP_TEST_VAULT_CONTRACT` (`vault.sandbox.near`) in `local.env`. Test mode: billing talks to the sandbox stand-in over `POST http://sandbox-api:8080/sim/near-rpc` and its keeper (billing-worker only) signs with `.secrets/keeper_test_key.json` (generated by `seed.sh keys`, account `NP_TEST_KEEPER_ACCOUNT`). Live: `NP_KEEPER_ACCOUNT` + `.secrets/live/keeper_key`; billing now joins the `egress` network for NEAR RPC. `NP_VAULT_USD_TOKENS` / `NP_VAULT_TOKENS` / `NP_VAULT_MAX_FEE_BPS` must match the vault's config (NEAR USDC + USDT, 500 bps). Solana RPC / Bitcoin Esplora pools for live mode: `NP_SOLANA_RPC_URLS` / `NP_BITCOIN_ESPLORA_URLS` (rails; sentinel's shared fallback; empty = rails' public defaults, no sentinel coverage) and the checkout's `NP_CHECKOUT_SOLANA_RPC_URL` (build-time `VITE_SOLANA_RPC_URL`); test mode reads the sandbox's simulated chains. `seed.sh data` subscribes merchant-demo to `mandate.*`, checks that the vault tokens are in rails' token registry and adds an auto-debit-eligible USDC monthly price (`price_monthly_usdc`) next to the USD one.

**Secrets.** `seed.sh keys` writes test-only material to `.secrets/` (mode 0700, never committed): database URLs per role, Ed25519 keys (internal JWT current/next, sentinel, payments ticket, webhooks, sandbox), service-client secrets and identity's hashed list, a KEK per service, billing's test-mode keeper key (`keeper_test_key.json`, near-cli JSON for the sandbox vault stand-in), the Turnstile test secret, the registry password and agentpay's x402 operation-token key (`x402_op_key_<kid>`, mounted as `/run/secrets/x402_op_key_<kid>` for `NP_X402_OPERATION_KEY_FILES`; the kid is `NP_X402_OP_KID` in `keys.env`); public keys go to `.secrets/public/` (`keys.env` for Compose, `sentinel_keys.json` for static builds). Existing files are never overwritten. Live credentials (1Click key, Explorer token, treasury and relayer keys) are added by the owner and stay out of git.

**Live (mainnet) credentials.** Put the files you have in `.secrets/live/` and run `scripts/seed.sh live`; it validates them and writes `.secrets/live/compose.live.yaml`, which `up.sh`/`down.sh` include automatically. All are optional; what is missing stays off:

| File | Used by | Without it |
|---|---|---|
| `oneclick_api_key` | rails (1Click JWT) | quotes carry 1Click's unauthenticated fee |
| `explorer_token` | rails Explorer feed (also set `NP_EXPLORER_ENABLED=true`) | provider status polling only |
| `relayer_key_1` … `relayer_key_4` | agentpay batcher: function-call keys of `NP_RELAYER_ACCOUNT` on `intents.near` (near-cli JSON or `ed25519:…`) | live agent payments and checkout Intents relays stay off |
| `keeper_key` | billing worker (Stage 4): function-call key of `NP_KEEPER_ACCOUNT` for the vault, gas only (near-cli JSON or `ed25519:…`; billing refuses a full-access key) | live mandates are not collected |
| `sentinel_solana_rpc_urls`, `sentinel_bitcoin_esplora_urls` | sentinel (Stage 4): its own provider accounts, comma-separated https URLs on one line | sentinel uses `NP_SOLANA_RPC_URLS` / `NP_BITCOIN_ESPLORA_URLS`, else that chain's audits are `unverifiable` |

Accounts and RPCs go in `compose/env/local.env`: `NP_TREASURY_ACCOUNT`, `NP_RELAYER_ACCOUNT`, `NP_KEEPER_ACCOUNT`, `NP_EVM_RPC_URLS_8453` / `_42161`, `NP_SOLANA_RPC_URLS`, `NP_BITCOIN_ESPLORA_URLS` (comma-separated, your own keys preferred), `NP_NEAR_RPC_URLS`, `NP_CHECKOUT_SOLANA_RPC_URL`.

**Live on-chain setup.** Before the first live run, `scripts/live-setup.mjs` checks and, with `--apply`, prepares the
mainnet side: the relayer's function-call keys and the agent's NEAR Intents USDC. It reads
`.secrets/accounts/{treasury,relayer,merchant,agent}.json` (near-cli JSON) and `.secrets/live/relayer_key_1..4`, and
the RPCs from `NP_NEAR_RPC_URLS` in `compose/env/local.env` (the first that answers). Every path has a flag (`--help`).

```sh
pnpm -C scripts/live-setup install --frozen-lockfile   # once: pinned @near-js/* 2.5.1, no install scripts run
node scripts/live-setup.mjs                            # dry run: status + next steps (who to fund, how much)
node scripts/live-setup.mjs --apply                    # add the missing relayer keys (prints the tx, asks y/N)
node scripts/live-setup.mjs --apply --deposit all      # also move the agent's native USDC into intents.near
```

- **Dry run** (the default) only reads: each account's existence and NEAR balance, which `relayer_key_N` are on the relayer
  and with what permission, the agent's native USDC (`ft_balance_of`) and NEAR Intents USDC (`mt_balance_of` on
  `intents.near`), and whether `intents.near` knows the agent's and the merchant's key (`has_public_key`).
- **`--apply`** prints every transaction (signer, key, receiver, actions, deposit, gas) and needs `y` (or `--yes`) before
  signing. Then it waits for FINAL and prints the `nearblocks.io` link. It never prints private keys and is idempotent: a
  second run sends nothing. It can send:
  - (a) one transaction from the relayer's full-access key adding each missing key as a function-call key: receiver
    `intents.near`, methods `[execute_intents]`, allowance 5 NEAR (the agentpay key policy);
  - (b) with `--deposit <amount|all>`, the agent's `ft_transfer_call` of native USDC to `intents.near`, with `msg` = the
    agent's own account id (1 yoctoNEAR, 100 Tgas; `storage_deposit` first if `intents.near` is not registered on the token);
  - (c) `intents.near` `add_public_key` only where `has_public_key` is false. For implicit accounts it is true by default,
    so this step is normally skipped.
- **Tests** run offline against a fake RPC and fixture keys: `pnpm -C scripts/live-setup test`.

**TLS.** With [mkcert](https://github.com/FiloSottile/mkcert) installed the certificate is trusted by browsers (run `mkcert -install` once); otherwise a self-signed local CA is generated and browsers warn — passkeys (WebAuthn) need the trusted certificate.

**Beta (nearpay.money from the owner's Mac).** `scripts/beta.sh up` runs `scripts/up.sh beta`: Compose project
`nearpay-beta` (own volumes), `compose/env/beta.env` and `.secrets/beta/beta.env` after `local.env`, and
`compose/compose.beta.yaml` on top of the local and live overlays. `NP_ENV=server` everywhere. Cloudflare terminates
TLS; `cloudflared` (token `.secrets/beta/cloudflared_token`, remotely-managed tunnel whose 8 public hostnames point at
`http://traefik:8080`) is the gateway's only client on the private `tunnel` network; Traefik publishes no ports,
trusts `X-Forwarded-*` from cloudflared's fixed address only (`traefik.beta.yaml`), keys its per-IP limits on
`CF-Connecting-IP`, routes the console to tunnel traffic only (Cloudflare Access in front) and answers
`api.<domain>/healthz` from identity's readiness (`routes.yaml`, `NP_EDGE=cloudflare`). Email: Resend SMTP
(`.secrets/beta/resend_api_key`), from `NearPay <receipts@nearpay.money>`, Reply-To `nearpaydotmoney@gmail.com`.
Turnstile: real keys (`.secrets/beta/turnstile_{sitekey,secret}`; the sitekey is baked into the checkout and dashboard
builds). The marketing site (apex, `www` → apex) and docs come from `nearpay-site`. Monitoring on `127.0.0.1`:
Prometheus (every process's `:9464`, Traefik, node-exporter), Grafana dashboard "NearPay beta", Alertmanager → Telegram
(`.secrets/beta/telegram_bot_token`, chat id discovered by `beta.sh`). No Mailpit, merchant demo or local CA.

**Networks.** `edge` (Traefik, static), `internal` (services; no internet), `data` (Postgres, NATS, Valkey and their clients), `egress` (only services that call the internet); webhook deliveries leave only through the egress proxy, which allows exactly one private address: the merchant demo on the `demo` network. The checkout and dashboard call the API same-origin under `/api`, so the API has no CORS surface.

## Status

- **Local stack** (`scripts/up.sh local`): the whole platform in test mode. Platform containers start healthy, Postgres roles are isolated per service, Traefik routes every public path to its owning service through ForwardAuth.
- **Live beta** (`scripts/beta.sh up`, runbook `docs/beta-launch.md`): the same stack in live mode on NEAR mainnet at https://nearpay.money, behind a Cloudflare Tunnel, with Prometheus, Alertmanager (alerts to Telegram) and Grafana, automatic restart of unhealthy containers, and a routing check that proves live payments can be quoted (`scripts/beta.sh routing`).
- **Local package registry** (`scripts/registry.sh`): runs on Linux and macOS with Node 22 only; CI proves both.
- Not built: the Kubernetes path (Argo CD, Helm) described in the design docs.

## Built with

Docker Compose, Traefik 3, PostgreSQL 17, NATS 2.10 (JetStream), Valkey 8, Smokescreen, nginx (unprivileged), Mailpit, Verdaccio, Prometheus, Alertmanager, Grafana, Cloudflare Tunnel (`cloudflared`), mkcert or OpenSSL, Node.js (key generation). Licence: Apache-2.0. Code and documentation are written with AI assistance (Claude) under human direction and review.
