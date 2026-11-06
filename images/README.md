# Local stand-in images

Build these only on a machine that **cannot pull** from Docker Hub, gcr.io or ghcr.io (a sandboxed CI
or cloud workspace whose egress policy blocks container registries). On a normal machine Docker pulls
the official images and you never need this folder.

`images/build.sh` builds a local image under the **same tag** as every third-party image the stack,
the service Dockerfiles and the Testcontainers suites use, so no repository changes:

| Tag | Built from |
|---|---|
| `node:22-bookworm-slim` | official Node.js 22.23.4 build (npm `node-linux-x64`), npm, corepack on Ubuntu 25.10 |
| `gcr.io/distroless/nodejs22-debian12:nonroot` | `FROM scratch`: node + the libraries it links, CA certificates, time zones; user 65532 |
| `postgres:17.11` | PostgreSQL 17 from Ubuntu 25.10 (questing-updates) + the official `docker-entrypoint.sh` |
| `nats:2.10.29-alpine` | official nats-server release binary |
| `valkey/valkey:8.1.11-alpine` | Valkey 8.1 from Ubuntu 25.10 (questing-updates), official entrypoint behaviour |
| `traefik:v3.5.6` | official Traefik release binary |
| `axllent/mailpit:v1.27.11` | official Mailpit release binary |
| `nginxinc/nginx-unprivileged:1.29.8-alpine` | nginx 1.28 from Ubuntu 25.10, unprivileged layout (user 101, `/tmp`) |
| `verdaccio/verdaccio:6.10.6` | verdaccio from npm on the local node image |
| `ghcr.io/foundry-rs/foundry:v1.4.4` | official Foundry release binaries (anvil, forge, cast, chisel) |
| `nearpay/egress-proxy:smokescreen-v0.1.0` | Smokescreen v0.1.0 built offline from its vendored sources with Go 1.26 from Ubuntu's packages |

The base is `nearpay-local/ubuntu:25.10`, a debootstrap of Ubuntu 25.10 made by `images/rootfs.sh`.
Downloads are verified against `SHA256SUMS`. Distro packages can trail a tag's patch level (for
example PostgreSQL 17.10 under `postgres:17.11`); each image records its real contents in the label
`org.nearpay.contents`:

```sh
docker image inspect -f '{{index .Config.Labels "org.nearpay.contents"}}' postgres:17.11
```

## Usage

```sh
sudo apt-get install debootstrap          # once
images/build.sh                           # build what is missing (rootfs first)
images/build.sh --force                   # rebuild everything
images/build.sh postgres                  # one image
```

- `NP_IMAGES_EXTRA_CA=<pem>`: networks that intercept TLS (a workspace egress proxy) need their CA
  trusted inside the node images so `pnpm install` works during service image builds. The CA stays in
  these local stand-ins only.
- `NP_IMAGES_UPDATE_SUMS=1`: record checksums for new downloads (after a version bump).
- Start the stack with `scripts/up.sh --no-build` after building the service images yourself: a plain
  `up.sh` asks Compose to rebuild the egress proxy from `compose/egress-proxy/Dockerfile`, which pulls
  `golang`/`alpine`.
- Testcontainers' reaper image is not built: run tests with `TESTCONTAINERS_RYUK_DISABLED=true`.

Remove the stand-ins (and let Docker pull the official images again) with
`docker image rm <tag>` once the registries are reachable.
