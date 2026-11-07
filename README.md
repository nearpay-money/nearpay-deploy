# nearpay-deploy

> Desired runtime state. v1: the Docker Compose stack (profiles local/server/observability), Postgres init, Traefik config, env templates, deploy script and SOPS-encrypted secrets. Post-v1: Argo CD applications, Helm chart, platform components, per-environment overlays.

| | |
|---|---|
| Group | Platform |
| Kind | GitOps |
| Ships as | Argo CD source of truth |
| Owns | Runtime configuration |
| Depends on (published artifacts only) | images, charts |
| First built in | Stage 1 (step 1.1) |

## Documentation

This repo stays surgical: design docs live in [`nearpay-brain`](../nearpay-brain/README.md), not here.

- `nearpay-brain/lld/platform.md` — **low-level design (dev-ready; implement from this)**
- `nearpay-brain/lld/audits/platform.md` — audit findings already folded into the LLD
- `nearpay-brain/roadmap/development-plan.md` — stage and step this repo is built in
- `nearpay-brain/architecture/hld.md` — system design
- `nearpay-brain/architecture/repositories.md` — repo topology and dependency rules
- `nearpay-brain/architecture/infrastructure.md`
- `nearpay-brain/operations/runbooks.md`

## Layout

```
nearpay-deploy/
├── compose/
│   ├── compose.yaml            all services, networks, volumes, secrets (profile-independent)
│   ├── compose.local.yaml      local profile: ports on 127.0.0.1, build contexts, registry, Mailpit, merchant demo
│   ├── env/local.env.example   non-secret configuration (copied to local.env on first run)
│   ├── init/postgres/roles.sh  databases and roles per service (idempotent, runs on every up)
│   ├── traefik/                static config + dynamic/routes.yaml (routers, ForwardAuth, TLS)
│   ├── static/                 nginx for pay, js, dashboard, ops and docs (+ placeholder page)
│   ├── egress-proxy/           Smokescreen image (pinned release)
│   └── registry/config.yaml    Verdaccio for @nearpay/* and @nearpay-internal/*
├── scripts/
│   ├── up.sh                   keys → registry seed + publish if missing → build web apps → build images → start, wait healthy
│   ├── down.sh                 stop (add --volumes to delete local data)
│   ├── seed.sh                 keys: test-only secrets and TLS certificate into .secrets/ (git-ignored)
│   ├── live-setup.mjs          one-time mainnet on-chain setup (relayer keys, agent Intents deposit); dry run by default
│   ├── live-setup/             its code, tests and pinned @near-js/* dependencies (own package.json + pnpm lockfile)
│   └── lib/                    seed-keys.mjs, registry-seed.mjs
├── registry-seed/              exact @nearpay* tarballs the lockfiles resolve to (published by up.sh)
├── apps/ charts/ envs/ platform/ secrets/   post-v1 GitOps layout (empty until then)
└── .github/workflows/ci.yml
```

## Commands

| Command                       | What it does                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `scripts/up.sh local`         | Start everything that is built; `--no-build` skips image builds, `--build-sites` forces web-app builds |
| `scripts/down.sh`             | Stop the stack; `--volumes` also deletes Postgres, NATS, Valkey and registry data                 |
| `scripts/seed.sh data`        | Demo merchant (test mode), merchant-demo key + webhook endpoint, demo agent funded in the sandbox |
| `scripts/seed.sh live`        | Check owner-provided mainnet credentials in `.secrets/live/` and generate the overlay `up.sh` uses |
| `scripts/seed.sh keys`        | Create missing test-only secrets; `--renew-tls` regenerates the certificate (e.g. after mkcert)   |
| `node scripts/live-setup.mjs` | Mainnet on-chain status of the live accounts; `--apply` sends the missing setup transactions       |
| `docker compose -p nearpay logs -f <service>` | Follow a container's logs                                                         |

**What starts.** The platform always: Traefik (gateway, TLS, ForwardAuth to identity), Postgres 17 with one database and two roles per service, NATS JetStream, Valkey, the Smokescreen egress proxy, nginx for the static sites, Mailpit (`https://mail.nearpay.localhost`) and the package registry (`http://127.0.0.1:4873`). Each NearPay service has a Compose profile named after it and joins once `../nearpay-<service>/Dockerfile` exists: its image is built from that repository, `migrate-<service>` applies migrations with the migrator role, then its processes start with the app role and must turn healthy. `up.sh` lists the services that are not built yet.

**Images.** `up.sh` builds `nearpay/<service>:local` from each built repository with `docker build --network host --build-arg NP_REGISTRY_URL=http://127.0.0.1:4873`, after publishing `nearpay-spec` and `nearpay-kit` to the registry whenever a version in those repositories is missing; Compose never builds or pulls service images. Service Dockerfiles therefore install `@nearpay/*` and `@nearpay-internal/*` from `$NP_REGISTRY_URL`, run `node dist/main.js <process>` (api, worker, …) and declare `HEALTHCHECK` with `dist/main.js healthcheck` (`@nearpay-internal/service`).

**Registry.** `up.sh` starts Verdaccio, then publishes every tarball in `registry-seed/` byte for byte (the exact
versions the lockfiles resolve to, checked against `SHA512SUMS`), and builds `nearpay-spec`, `nearpay-kit`,
`nearpay-node` and `nearpay-agentkit` from source only for versions still missing. See `registry-seed/README.md`.

**Web apps.** nginx serves `nearpay-checkout/dist` (pay), `nearpay-dashboard/dist` and `nearpay-js/dist` (`/v1/nearpay.js`)
from the sibling repositories. `up.sh` runs `pnpm install --frozen-lockfile && pnpm build` in each one whose output is
missing or older than its HEAD commit (and the checkout when it does not pin the current
`.secrets/public/sentinel_keys.json`), then recreates the static container; `--build-sites` rebuilds all three.
Build logs go to a temp file named in the output. Sites without a build (console, docs) show a placeholder page.

**Secrets.** `seed.sh keys` writes test-only material to `.secrets/` (mode 0700, never committed): database URLs per role, Ed25519 keys (internal JWT current/next, sentinel, payments ticket, webhooks, sandbox), service-client secrets and identity's hashed list, a KEK per service, the Turnstile test secret and the registry password; public keys go to `.secrets/public/` (`keys.env` for Compose, `sentinel_keys.json` for static builds). Existing files are never overwritten. Live credentials (1Click key, Explorer token, treasury and relayer keys) are added by the owner and stay out of git.

**Live (mainnet) credentials.** Put the files you have in `.secrets/live/` and run `scripts/seed.sh live`; it validates them and writes `.secrets/live/compose.live.yaml`, which `up.sh`/`down.sh` include automatically. All are optional; what is missing stays off:

| File | Used by | Without it |
|---|---|---|
| `oneclick_api_key` | rails (1Click JWT) | quotes carry 1Click's unauthenticated fee |
| `explorer_token` | rails Explorer feed (also set `NP_EXPLORER_ENABLED=true`) | provider status polling only |
| `relayer_key_1` … `relayer_key_4` | agentpay batcher: function-call keys of `NP_RELAYER_ACCOUNT` on `intents.near` (near-cli JSON or `ed25519:…`) | live agent payments and checkout Intents relays stay off |

Accounts and RPCs go in `compose/env/local.env`: `NP_TREASURY_ACCOUNT`, `NP_RELAYER_ACCOUNT`, `NP_EVM_RPC_URLS_8453` / `_42161` (comma-separated, your own keys preferred), `NP_NEAR_RPC_URLS`.

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

**Networks.** `edge` (Traefik, static), `internal` (services; no internet), `data` (Postgres, NATS, Valkey and their clients), `egress` (only services that call the internet); webhook deliveries leave only through the egress proxy, which allows exactly one private address: the merchant demo on the `demo` network. The checkout and dashboard call the API same-origin under `/api`, so the API has no CORS surface.

## Status

Stage 1 step 1.1: local profile complete — platform containers start healthy, Postgres roles are isolated per service, Traefik routes every Stage-1 public path to its owning service through ForwardAuth, and services join automatically once built. The server and observability profiles arrive in Stage 5.

## Built with

Docker Compose, Traefik 3, PostgreSQL 17, NATS 2.10 (JetStream), Valkey 8, Smokescreen, nginx (unprivileged), Mailpit, Verdaccio, mkcert or OpenSSL, Node.js (key generation). Code and documentation are written with AI assistance (Claude) under human direction and review.
