# registry-seed

The exact `@nearpay-money/*` and `@nearpay-internal/*` tarballs that every repo's `pnpm-lock.yaml` was resolved against,
including the older contract versions still pinned (for example `nearpay-kit` 0.1.2 depends on spec 0.1.1).
`scripts/up.sh` publishes them to the local registry byte for byte (`scripts/lib/registry-seed.mjs`), so a clean
checkout installs with `--frozen-lockfile`. Rebuilding from source can't recreate old versions, and a rebuilt
tarball's sha512 need not match the lockfiles.

`SHA512SUMS` is checked on every run. After releasing a new package version to the local registry, add its
tarball here (copy it from the registry's storage, `@scope/name/name-<version>.tgz`) and regenerate the sums:

```sh
cd registry-seed && find . -name '*.tgz' | sort | xargs sha512sum > SHA512SUMS
```
