# Smokescreen (Stripe's egress proxy), built from a pinned release: webhook deliveries to merchant
# URLs go through it so they can never reach private or internal addresses (webhooks LLD, SSRF).
FROM golang:1.25.14-alpine3.24 AS build
ARG SMOKESCREEN_VERSION=v0.1.0
ENV CGO_ENABLED=0 GOFLAGS=-trimpath
RUN go install -ldflags="-s -w" github.com/stripe/smokescreen@${SMOKESCREEN_VERSION}

FROM alpine:3.24.2
RUN adduser -D -H -u 10001 smokescreen
COPY --from=build /go/bin/smokescreen /usr/local/bin/smokescreen
USER 10001
EXPOSE 4750
ENTRYPOINT ["/usr/local/bin/smokescreen"]
CMD ["--listen-ip=0.0.0.0", "--listen-port=4750"]
