# Stand-in for nearpay/egress-proxy:smokescreen-v0.1.0 where golang/alpine images cannot be pulled:
# Smokescreen v0.1.0 built offline from its vendored sources (-mod=vendor, no module downloads) with
# Go 1.26 from Ubuntu's packages, on the Ubuntu 25.10 base (nc for the health check). Same user,
# port and entrypoint as compose/egress-proxy/Dockerfile.
FROM nearpay-local/ubuntu:25.10 AS build
COPY golang-1.26-go_1.26.0-1_amd64.deb golang-1.26-src_1.26.0-1_all.deb smokescreen-v0.1.0.tar.gz /tmp/
RUN set -eux; \
    dpkg -x /tmp/golang-1.26-go_1.26.0-1_amd64.deb /; dpkg -x /tmp/golang-1.26-src_1.26.0-1_all.deb /; \
    tar -xzf /tmp/smokescreen-v0.1.0.tar.gz -C /tmp; cd /tmp/smokescreen; \
    CGO_ENABLED=0 GOTOOLCHAIN=local GOFLAGS=-mod=vendor GOPROXY=off \
      /usr/lib/go-1.26/bin/go build -trimpath -ldflags="-s -w" -o /smokescreen .
FROM nearpay-local/ubuntu:25.10
RUN useradd -M -u 10001 smokescreen
COPY --from=build /smokescreen /usr/local/bin/smokescreen
LABEL org.nearpay.contents="smokescreen v0.1.0 (vendored source, Go 1.26 from Ubuntu), Ubuntu 25.10" \
      org.nearpay.stand-in-for="nearpay/egress-proxy:smokescreen-v0.1.0"
USER 10001
EXPOSE 4750
ENTRYPOINT ["/usr/local/bin/smokescreen"]
CMD ["--listen-ip=0.0.0.0", "--listen-port=4750"]
