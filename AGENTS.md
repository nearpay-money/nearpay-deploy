# AGENTS.md — nearpay-deploy

You are working in **nearpay-deploy**, one of 27 NearPay repositories (`nearpay-brain/architecture/repositories.md`).
Scope: Desired runtime state. v1: the Docker Compose stack (profiles local/server/observability), Postgres init, Traefik config, env templates, deploy script and SOPS-encrypted secrets. Post-v1: Argo CD applications, Helm chart, platform components, per-environment overlays.

## Before changing anything

1. Read `../nearpay-brain/AGENTS.md`, then this repo's LLD (`../nearpay-brain/lld/platform.md`) — it is the implementation spec; do not make design decisions it already makes.
2. Contracts (requests, responses, events, errors) come from `@nearpay-money/spec`. If one must change, open a PR in `nearpay-spec` first; never hand-write contract types here.
3. Check your change against invariants INV-1…INV-9 in `nearpay-brain/product/requirements.md`.

## Rules for this repo

- Only image digests (never tags) in env overlays; production changes merge only with human approval.
- Platform upgrades go to staging first and soak 48 h.

## Never

- Import source code from another NearPay repo (depend on published packages/images only).
- Read or write another service's database.
- Add design documents here — update `nearpay-brain` and link to it.
- Commit secrets, private keys or real customer data.
- Merge changes to paths listed in `.github/CODEOWNERS` without the required human review.
