#!/usr/bin/env bash
# Local test-only material for the Compose stack (lld/platform.md §1).
#   scripts/seed.sh keys [--renew-tls]   secrets + key pairs + TLS certificate into .secrets/ (idempotent)
#   scripts/seed.sh data                 demo merchant via the API (needs identity + payments, step 1.2+)
set -euo pipefail
deploy="$(cd "$(dirname "$0")/.." && pwd)"
secrets="${NP_SECRETS_DIR:-$deploy/.secrets}"
env_file="$deploy/compose/env/local.env"

say() { printf '%s\n' "$*"; }
die() { printf 'seed: %s\n' "$*" >&2; exit 1; }

base_domain() {
  local d=""
  [ -f "$env_file" ] && d="$(sed -n 's/^NP_BASE_DOMAIN=//p' "$env_file" | tail -1)"
  printf '%s' "${NP_BASE_DOMAIN:-${d:-nearpay.localhost}}"
}

tls() {
  local renew="${1:-}" dir="$secrets/tls" domain names
  domain="$(base_domain)"
  names="$domain *.$domain api.$domain pay.$domain js.$domain dashboard.$domain ops.$domain docs.$domain mail.$domain merchant-demo.$domain"
  mkdir -p "$dir"
  chmod 700 "$secrets"
  if [ -z "$renew" ] && [ -s "$dir/cert.pem" ] && [ -s "$dir/key.pem" ] && [ -s "$dir/ca.pem" ] && [ "$(cat "$dir/names" 2>/dev/null)" = "$names" ]; then
    return
  fi
  rm -f "$dir/cert.pem" "$dir/key.pem" "$dir/ca.pem" "$dir/names"
  if command -v mkcert >/dev/null 2>&1; then
    # shellcheck disable=SC2086 # names is a word list
    mkcert -cert-file "$dir/cert.pem" -key-file "$dir/key.pem" $names >/dev/null 2>&1 || die "mkcert failed"
    cp "$(mkcert -CAROOT)/rootCA.pem" "$dir/ca.pem"
    echo mkcert > "$dir/mode"
    say "TLS: mkcert certificate for *.$domain (if browsers warn, run 'mkcert -install' once, then reload)"
  else
    command -v openssl >/dev/null 2>&1 || die "neither mkcert nor openssl is installed"
    local tmp i=1 alt=""
    tmp="$(mktemp -d)"
    for n in $names; do alt="${alt}DNS.$i = $n"$'\n'; i=$((i + 1)); done
    cat > "$tmp/ca.cnf" <<CNF
[req]
distinguished_name = dn
prompt = no
[dn]
CN = NearPay local CA (test only)
[v3_ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
CNF
    cat > "$tmp/leaf.cnf" <<CNF
[req]
distinguished_name = dn
prompt = no
[dn]
CN = $domain
[v3_leaf]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt
[alt]
$alt
CNF
    openssl ecparam -name prime256v1 -genkey -noout -out "$tmp/ca.key" 2>/dev/null
    openssl req -x509 -new -key "$tmp/ca.key" -sha256 -days 825 -config "$tmp/ca.cnf" -extensions v3_ca -out "$dir/ca.pem" 2>/dev/null
    openssl ecparam -name prime256v1 -genkey -noout -out "$dir/key.pem" 2>/dev/null
    openssl req -new -key "$dir/key.pem" -config "$tmp/leaf.cnf" -out "$tmp/leaf.csr" 2>/dev/null
    openssl x509 -req -in "$tmp/leaf.csr" -CA "$dir/ca.pem" -CAkey "$tmp/ca.key" -CAcreateserial -CAserial "$tmp/ca.srl" \
      -days 397 -sha256 -extfile "$tmp/leaf.cnf" -extensions v3_leaf -out "$dir/cert.pem" 2>/dev/null || die "openssl could not sign the certificate"
    rm -rf "$tmp"
    echo self-signed > "$dir/mode"
    say "TLS: self-signed certificate for *.$domain (mkcert not found)."
    say "     Browsers will warn and passkeys (WebAuthn) will not work. Install mkcert, then run: scripts/seed.sh keys --renew-tls"
  fi
  chmod 644 "$dir/cert.pem" "$dir/key.pem" "$dir/ca.pem"
  printf '%s' "$names" > "$dir/names"
}

cmd="${1:-}"
case "$cmd" in
  keys)
    command -v node >/dev/null 2>&1 || die "Node.js 22 is required (https://nodejs.org)"
    NP_SECRETS_DIR="$secrets" node "$deploy/scripts/lib/seed-keys.mjs"
    tls "${2:-}"
    ;;
  data)
    die "demo data needs identity and payments (development step 1.2); nothing to seed yet"
    ;;
  *)
    say "usage: scripts/seed.sh keys [--renew-tls] | data" >&2
    exit 2
    ;;
esac
