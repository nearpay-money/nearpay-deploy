# Stand-in for nginxinc/nginx-unprivileged:1.29.8-alpine: nginx 1.28 from Ubuntu 25.10 laid out like
# the unprivileged image (user 101, pid and temp files in /tmp, conf.d includes, logs to stdio), so
# it runs with a read-only root and a /tmp tmpfs.
FROM nearpay-local/ubuntu:25.10
RUN set -eux; \
    printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d; chmod +x /usr/sbin/policy-rc.d; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nginx; \
    rm -rf /var/lib/apt/lists/* /etc/nginx/sites-enabled /etc/nginx/sites-available /etc/nginx/conf.d/*; \
    groupadd -r -g 101 nginx; useradd -r -g nginx -u 101 -d /nonexistent -s /usr/sbin/nologin nginx; \
    mkdir -p /etc/nginx/conf.d /etc/nginx/snippets /usr/share/nginx/html; \
    printf 'server {\n  listen 8080;\n  location / { root /usr/share/nginx/html; }\n}\n' > /etc/nginx/conf.d/default.conf; \
    nginx -v
COPY nginx.conf /etc/nginx/nginx.conf
LABEL org.nearpay.contents="nginx 1.28 (Ubuntu 25.10 questing-updates package), unprivileged layout" \
      org.nearpay.stand-in-for="nginxinc/nginx-unprivileged:1.29.8-alpine"
USER 101
EXPOSE 8080
STOPSIGNAL SIGQUIT
CMD ["nginx", "-e", "stderr", "-g", "daemon off;"]
