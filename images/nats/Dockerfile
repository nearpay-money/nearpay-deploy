# Stand-in for nats:2.10.29-alpine: the official nats-server release binary; like the official image,
# arguments starting with "-" are passed to nats-server. wget for health checks.
FROM nearpay-local/ubuntu:25.10
ARG NATS_VERSION
COPY nats-server-v${NATS_VERSION}-linux-amd64.tar.gz /tmp/
RUN set -eux; \
    tar -xzf "/tmp/nats-server-v${NATS_VERSION}-linux-amd64.tar.gz" -C /tmp; \
    install -m 0755 "/tmp/nats-server-v${NATS_VERSION}-linux-amd64/nats-server" /usr/local/bin/nats-server; \
    rm -rf /tmp/*; mkdir -p /etc/nats; printf 'port: 4222\nmonitor_port: 8222\n' > /etc/nats/nats-server.conf; \
    nats-server --version
COPY entrypoint.sh /usr/local/bin/docker-entrypoint.sh
LABEL org.nearpay.contents="nats-server ${NATS_VERSION} (official release binary), Ubuntu 25.10" \
      org.nearpay.stand-in-for="nats:2.10.29-alpine"
EXPOSE 4222 6222 8222
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["nats-server", "--config", "/etc/nats/nats-server.conf"]
