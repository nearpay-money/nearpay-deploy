# Stand-in for ghcr.io/foundry-rs/foundry:v1.4.4: the official Foundry release binaries
# (anvil, forge, cast, chisel); ENTRYPOINT ["/bin/sh", "-c"] as in the official image.
FROM nearpay-local/ubuntu:25.10
ARG FOUNDRY_VERSION
COPY foundry_v${FOUNDRY_VERSION}_linux_amd64.tar.gz /tmp/
RUN set -eux; tar -xzf "/tmp/foundry_v${FOUNDRY_VERSION}_linux_amd64.tar.gz" -C /usr/local/bin; rm -rf /tmp/*; anvil --version
LABEL org.nearpay.contents="foundry ${FOUNDRY_VERSION} (official release binaries), Ubuntu 25.10" \
      org.nearpay.stand-in-for="ghcr.io/foundry-rs/foundry:v1.4.4"
EXPOSE 8545
ENTRYPOINT ["/bin/sh", "-c"]
