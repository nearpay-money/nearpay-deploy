# Stand-in for axllent/mailpit:v1.27.11: the official Mailpit release binary at /mailpit.
FROM nearpay-local/ubuntu:25.10
ARG MAILPIT_VERSION
COPY mailpit-linux-amd64.tar.gz /tmp/
RUN set -eux; tar -xzf /tmp/mailpit-linux-amd64.tar.gz -C /tmp mailpit; install -m 0755 /tmp/mailpit /mailpit; rm -rf /tmp/*; /mailpit version 2>/dev/null | head -1
LABEL org.nearpay.contents="mailpit ${MAILPIT_VERSION} (official release binary), Ubuntu 25.10" \
      org.nearpay.stand-in-for="axllent/mailpit:v1.27.11"
EXPOSE 1025 8025
HEALTHCHECK --interval=15s --start-period=10s CMD ["/mailpit", "readyz"]
ENTRYPOINT ["/mailpit"]
