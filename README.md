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
│   ├── up.sh                   seed → registry → publish spec/kit if missing → build images → start, wait healthy
│   ├── down.sh                 stop (add --volumes to delete local data)
│   ├── seed.sh                 keys: test-only secrets and TLS certificate into .secrets/ (git-ignored)
│   └── lib/seed-keys.mjs
├── apps/ charts/ envs/ platform/ secrets/   post-v1 GitOps layout (empty until then)
└── .github/workflows/ci.yml
```

## Commands

| Command                       | What it does                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `scripts/up.sh local`         | Start everything that is built; `--no-build` skips image builds                                  |
| `scripts/down.sh`             | Stop the stack; `--volumes` also deletes Postgres, NATS, Valkey and registry data                 |
| `scripts/seed.sh data`        | Demo merchant (test mode), merchant-demo key + webhook endpoint, demo agent funded in the sandbox |
| `scripts/seed.sh live`        | Check owner-provided mainnet credentials in `.secrets/live/` and generate the overlay `up.sh` uses |
| `scripts/seed.sh keys`        | Create missing test-only secrets; `--renew-tls` regenerates the certificate (e.g. after mkcert)   |
| `docker compose -p nearpay logs -f <service>` | Follow a container's logs                                                         |

**What starts.** The platform always: Traefik (gateway, TLS, ForwardAuth to identity), Postgres 17 with one database and two roles per service, NATS JetStream, Valkey, the Smokescreen egress proxy, nginx for the static sites, Mailpit (`https://mail.nearpay.localhost`) and the package registry (`http://127.0.0.1:4873`). Each NearPay service has a Compose profile named after it and joins once `../nearpay-<service>/Dockerfile` exists: its image is built from that repository, `migrate-<service>` applies migrations with the migrator role, then its processes start with the app role and must turn healthy. `up.sh` lists the services that are not built yet.

**Images.** `up.sh` builds `nearpay/<service>:local` from each built repository with `docker build --network host --build-arg NP_REGISTRY_URL=http://127.0.0.1:4873`, after publishing `nearpay-spec` and `nearpay-kit` to the registry whenever a version in those repositories is missing; Compose never builds or pulls service images. Service Dockerfiles therefore install `@nearpay/*` and `@nearpay-internal/*` from `$NP_REGISTRY_URL`, run `node dist/main.js <process>` (api, worker, …) and declare `HEALTHCHECK` with `dist/main.js healthcheck` (`@nearpay-internal/service`).

**Secrets.** `seed.sh keys` writes test-only material to `.secrets/` (mode 0700, never committed): database URLs per role, Ed25519 keys (internal JWT current/next, sentinel, payments ticket, webhooks, sandbox), service-client secrets and identity's hashed list, a KEK per service, the Turnstile test secret and the registry password; public keys go to `.secrets/public/` (`keys.env` for Compose, `sentinel_keys.json` for static builds). Existing files are never overwritten. Live credentials (1Click key, Explorer token, treasury and relayer keys) are added by the owner and stay out of git.

**Live (mainnet) credentials.** Put the files you have in `.secrets/live/` and run `scripts/seed.sh live`; it validates them and writes `.secrets/live/compose.live.yaml`, which `up.sh`/`down.sh` include automatically. All are optional; what is missing stays off:

| File | Used by | Without it |
|---|---|---|
| `oneclick_api_key` | rails (1Click JWT) | quotes carry 1Click's unauthenticated fee |
| `explorer_token` | rails Explorer feed (also set `NP_EXPLORER_ENABLED=true`) | provider status polling only |
| `relayer_key_1` … `relayer_key_4` | agentpay batcher: function-call keys of `NP_RELAYER_ACCOUNT` on `intents.near` (near-cli JSON or `ed25519:…`) | live agent payments and checkout Intents relays stay off |

Accounts and RPCs go in `compose/env/local.env`: `NP_TREASURY_ACCOUNT`, `NP_RELAYER_ACCOUNT`, `NP_EVM_RPC_URLS_8453` / `_42161` (comma-separated, your own keys preferred), `NP_NEAR_RPC_URLS`.

**TLS.** With [mkcert](https://github.com/FiloSottile/mkcert) installed the certificate is trusted by browsers (run `mkcert -install` once); otherwise a self-signed local CA is generated and browsers warn — passkeys (WebAuthn) need the trusted certificate.

**Networks.** `edge` (Traefik, static), `internal` (services; no internet), `data` (Postgres, NATS, Valkey and their clients), `egress` (only services that call the internet); webhook deliveries leave only through the egress proxy, which allows exactly one private address: the merchant demo on the `demo` network. The checkout and dashboard call the API same-origin under `/api`, so the API has no CORS surface.

## Status

Stage 1 step 1.1: local profile complete — platform containers start healthy, Postgres roles are isolated per service, Traefik routes every Stage-1 public path to its owning service through ForwardAuth, and services join automatically once built. The server and observability profiles arrive in Stage 5.

## Built with

Docker Compose, Traefik 3, PostgreSQL 17, NATS 2.10 (JetStream), Valkey 8, Smokescreen, nginx (unprivileged), Mailpit, Verdaccio, mkcert or OpenSSL, Node.js (key generation). Code and documentation are written with AI assistance (Claude) under human direction and review.
