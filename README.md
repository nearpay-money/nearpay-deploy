# nearpay-deploy

> Desired state of every cluster: Argo CD applications, the shared service Helm chart, platform components, per-environment overlays, SOPS-encrypted config.

| | |
|---|---|
| Group | Platform |
| Kind | GitOps |
| Ships as | Argo CD source of truth |
| Owns | Runtime configuration |
| Depends on (published artifacts only) | images, charts |
| Roadmap phase | P0 Foundations |

## Documentation

This repo stays surgical: design docs live in [`nearpay-brain`](../nearpay-brain/README.md), not here.

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
├── secrets/
└── .github/
    └── workflows/
```

## Status

Scaffold only. Implementation starts in phase **P0 Foundations** (`nearpay-brain/roadmap/roadmap.md`).
