# Production Caddy. The stock image cannot serve the wildcard
# *.shops.<domain> block: its DNS-01 challenge needs the third-party
# caddy-dns/cloudflare module, hence the xcaddy build.
FROM caddy:2-builder AS builder

RUN xcaddy build --with github.com/caddy-dns/cloudflare

FROM caddy:2

COPY --from=builder /usr/bin/caddy /usr/bin/caddy
