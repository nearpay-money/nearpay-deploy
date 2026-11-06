# Stand-in for postgres:17.11: PostgreSQL 17 from Ubuntu 25.10 (questing-updates) with the official
# image's docker-entrypoint.sh (POSTGRES_PASSWORD[_FILE], POSTGRES_DB, /docker-entrypoint-initdb.d,
# gosu to the postgres user), PGDATA and PATH as in the official image.
FROM nearpay-local/ubuntu:25.10
RUN set -eux; \
    groupadd -r -g 999 postgres; \
    useradd -r -g postgres -u 999 --home-dir=/var/lib/postgresql --shell=/bin/bash postgres; \
    mkdir -p /var/lib/postgresql; chown postgres:postgres /var/lib/postgresql; \
    printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d; chmod +x /usr/sbin/policy-rc.d; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends postgresql-common; \
    sed -ri 's/#(create_main_cluster) .*$/\1 = false/' /etc/postgresql-common/createcluster.conf; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends postgresql-17; \
    rm -rf /var/lib/apt/lists/*; \
    sed -ri "s!^#?(listen_addresses)\s*=\s*\S+.*!\1 = '*'!" /usr/share/postgresql/17/postgresql.conf.sample; \
    mkdir -p /var/run/postgresql; chown -R postgres:postgres /var/run/postgresql; chmod 3777 /var/run/postgresql; \
    mkdir /docker-entrypoint-initdb.d
ENV PATH=$PATH:/usr/lib/postgresql/17/bin PGDATA=/var/lib/postgresql/data
RUN mkdir -p "$PGDATA" && chown -R postgres:postgres "$PGDATA" && chmod 1777 "$PGDATA"
COPY postgres-docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && ln -s docker-entrypoint.sh /usr/local/bin/docker-ensure-initdb.sh \
    && echo "org.nearpay.contents=$(postgres --version)"
VOLUME /var/lib/postgresql/data
LABEL org.nearpay.contents="PostgreSQL 17 (Ubuntu 25.10 questing-updates package) + official docker-entrypoint.sh" \
      org.nearpay.stand-in-for="postgres:17.11"
ENTRYPOINT ["docker-entrypoint.sh"]
STOPSIGNAL SIGINT
EXPOSE 5432
CMD ["postgres"]
