# Stand-in for node:22-bookworm-slim (build stages of the service images): the official Node.js
# Linux build as published to npm (node-linux-x64), with npm and corepack, on Ubuntu 25.10.
FROM nearpay-local/ubuntu:25.10
ARG NODE_VERSION
ARG NPM_VERSION
ARG COREPACK_VERSION
COPY node-linux-x64-${NODE_VERSION}.tgz npm-${NPM_VERSION}.tgz corepack-${COREPACK_VERSION}.tgz extra-ca.crt /tmp/
RUN set -eux; \
    if [ -s /tmp/extra-ca.crt ]; then \
      cp /tmp/extra-ca.crt /usr/local/share/ca-certificates/nearpay-extra-ca.crt; update-ca-certificates; \
    fi; \
    mkdir -p /tmp/n /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack; \
    tar -xzf "/tmp/node-linux-x64-${NODE_VERSION}.tgz" -C /tmp/n; \
    install -m 0755 /tmp/n/package/bin/node /usr/local/bin/node; \
    cp -r /tmp/n/package/include /usr/local/include; \
    tar -xzf "/tmp/npm-${NPM_VERSION}.tgz" -C /usr/local/lib/node_modules/npm --strip-components=1; \
    tar -xzf "/tmp/corepack-${COREPACK_VERSION}.tgz" -C /usr/local/lib/node_modules/corepack --strip-components=1; \
    ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm; \
    ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx; \
    ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack; \
    groupadd -g 1000 node; useradd -u 1000 -g node -m -s /bin/bash node; \
    rm -rf /tmp/*; node --version; npm --version; corepack --version
LABEL org.nearpay.contents="node ${NODE_VERSION} (official build, npm node-linux-x64), npm ${NPM_VERSION}, corepack ${COREPACK_VERSION}, Ubuntu 25.10" \
      org.nearpay.stand-in-for="node:22-bookworm-slim"
# node trusts the system store too (only differs when an extra CA was given at build time)
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
CMD ["node"]
