# Stand-in for gcr.io/distroless/nodejs22-debian12:nonroot (runtime stage of the service images):
# FROM scratch with only node, the shared libraries it links, CA certificates and time zones. No
# shell, no package manager; user nonroot (65532); ENTRYPOINT /nodejs/bin/node like distroless.
FROM node:22-bookworm-slim AS src
ARG NODE_VERSION
RUN set -eux; \
    mkdir -p /out/nodejs/bin /out/etc/ssl/certs /out/tmp /out/home/nonroot /out/usr/share /out/etc; \
    cp /usr/local/bin/node /out/nodejs/bin/node; \
    for lib in $(ldd /usr/local/bin/node | awk '/=>/ { print $3 } /ld-linux/ { print $1 }'); do \
      mkdir -p "/out$(dirname "$lib")"; cp -L "$lib" "/out$lib"; \
    done; \
    cp /etc/ld.so.cache /out/etc/; \
    cp /etc/ssl/certs/ca-certificates.crt /out/etc/ssl/certs/; \
    cp -r /usr/share/zoneinfo /out/usr/share/; \
    printf 'root:x:0:0:root:/root:/sbin/nologin\nnobody:x:65534:65534:nobody:/nonexistent:/sbin/nologin\nnonroot:x:65532:65532:nonroot:/home/nonroot:/sbin/nologin\n' > /out/etc/passwd; \
    printf 'root:x:0:\nnobody:x:65534:\nnonroot:x:65532:\n' > /out/etc/group; \
    printf 'hosts: files dns\n' > /out/etc/nsswitch.conf; \
    chmod 1777 /out/tmp; chown 65532:65532 /out/home/nonroot
FROM scratch
ARG NODE_VERSION
COPY --from=src /out/ /
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
USER 65532:65532
WORKDIR /home/nonroot
LABEL org.nearpay.contents="node ${NODE_VERSION} (official build) on scratch with glibc from Ubuntu 25.10, nonroot" \
      org.nearpay.stand-in-for="gcr.io/distroless/nodejs22-debian12:nonroot"
ENTRYPOINT ["/nodejs/bin/node"]
