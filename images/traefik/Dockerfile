# Stand-in for traefik:v3.5.6: the official Traefik release binary with the official entrypoint
# behaviour ("-…" arguments and Traefik subcommands run traefik).
FROM nearpay-local/ubuntu:25.10
ARG TRAEFIK_VERSION
COPY traefik_v${TRAEFIK_VERSION}_linux_amd64.tar.gz /tmp/
RUN set -eux; \
    tar -xzf "/tmp/traefik_v${TRAEFIK_VERSION}_linux_amd64.tar.gz" -C /tmp traefik; \
    install -m 0755 /tmp/traefik /usr/local/bin/traefik; rm -rf /tmp/*; traefik version
COPY entrypoint.sh /entrypoint.sh
LABEL org.nearpay.contents="traefik ${TRAEFIK_VERSION} (official release binary), Ubuntu 25.10" \
      org.nearpay.stand-in-for="traefik:v3.5.6"
EXPOSE 80
ENTRYPOINT ["/entrypoint.sh"]
CMD ["traefik"]
