# Stand-in for valkey/valkey:8.1.11-alpine: Valkey 8.1 from Ubuntu 25.10 (questing-updates). The
# entrypoint mirrors the official one: "-…"/".conf" arguments go to valkey-server, protected mode is
# off without a config file, and the server drops to the valkey user. Data in /data.
FROM nearpay-local/ubuntu:25.10
RUN set -eux; \
    printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d; chmod +x /usr/sbin/policy-rc.d; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends valkey-server valkey-tools; \
    rm -rf /var/lib/apt/lists/*; \
    mkdir /data; chown valkey:valkey /data; valkey-server --version
COPY entrypoint.sh /usr/local/bin/docker-entrypoint.sh
VOLUME /data
WORKDIR /data
LABEL org.nearpay.contents="Valkey 8.1 (Ubuntu 25.10 questing-updates package)" \
      org.nearpay.stand-in-for="valkey/valkey:8.1.11-alpine"
EXPOSE 6379
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["valkey-server"]
