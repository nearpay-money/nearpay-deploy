# Stand-in for verdaccio/verdaccio:6.10.6: Verdaccio from npm on the local node image, laid out like
# the official image (/verdaccio/{conf,storage,plugins}, user 10001, port 4873).
FROM node:22-bookworm-slim
ARG VERDACCIO_VERSION
RUN set -eux; \
    npm install -g --no-audit --no-fund "verdaccio@${VERDACCIO_VERSION}"; npm cache clean --force; \
    groupadd -g 10001 verdaccio; useradd -u 10001 -g verdaccio -d /verdaccio -s /usr/sbin/nologin verdaccio; \
    mkdir -p /verdaccio/storage /verdaccio/plugins /verdaccio/conf; chown -R 10001:10001 /verdaccio
COPY config.yaml /verdaccio/conf/config.yaml
LABEL org.nearpay.contents="verdaccio ${VERDACCIO_VERSION} (npm) on node 22, Ubuntu 25.10" \
      org.nearpay.stand-in-for="verdaccio/verdaccio:6.10.6"
USER 10001
ENV VERDACCIO_PORT=4873
EXPOSE 4873
VOLUME /verdaccio/storage
CMD ["verdaccio", "--config", "/verdaccio/conf/config.yaml", "--listen", "0.0.0.0:4873"]
