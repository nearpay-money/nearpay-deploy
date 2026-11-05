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
├── apps/
├── charts/
│   └── nearpay-service/
├── compose/
│   ├── env/
│   ├── init/
│   │   └── postgres/
│   └── traefik/
├── envs/
│   ├── prod-nue/
│   ├── prod-vie/
│   └── staging/
├── platform/
│   ├── argo-rollouts/
│   ├── cilium/
│   ├── cnpg/
│   ├── egress-proxy/
│   ├── kyverno/
│   ├── nats/
│   ├── observability/
│   ├── openbao/
│   ├── traefik/
│   ├── valkey/
│   └── zot/
├── scripts/
├── secrets/
└── .github/
    └── workflows/
```

## Status

Scaffold only. Implementation starts in **Stage 1 (step 1.1)** (`nearpay-brain/roadmap/development-plan.md`).

## Built with

Libraries are listed here as they are added (hackathon rule Q-005). Code and documentation are written with AI assistance (Claude) under human direction and review.
