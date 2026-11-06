#!/usr/bin/env bash
# Local test-only material for the Compose stack (lld/platform.md §1).
#   scripts/seed.sh keys [--renew-tls]   secrets + key pairs + TLS certificate into .secrets/ (idempotent)
#   scripts/seed.sh data                 demo merchant, merchant-demo webhook + key, funded demo agent (test mode)
#   scripts/seed.sh live                 check owner-provided mainnet credentials in .secrets/live/ and
#                                        generate the Compose overlay that passes them to rails/agentpay
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
    # merchant-demo reads its test-mode key and webhook secret from here (filled by `seed.sh data`)
    mkdir -p "$secrets/merchant-demo" && chmod 755 "$secrets/merchant-demo"
    mkdir -p "$secrets/live" && chmod 700 "$secrets/live"
    ;;
  data)
    # Demo data (test mode):
    # 1. identity seed-demo: owner, account, test destination and API keys (idempotent on the email);
    #    keys in .secrets/demo.json
    # 2. merchant-demo: its secret key and a webhook endpoint http://merchant-demo:3000/webhooks
    #    (payment_intent.*, checkout.session.*, agent_payment.*) with its signing secret, in
    #    .secrets/merchant-demo/ (test-mode values; readable by the container user)
    # 3. sandbox: the demo agent's simulated Intents balance (USDC), topped up to 100 USDC
    running() { docker compose -p nearpay ps --status running --services 2>/dev/null | grep -qx "$1"; }
    running identity-api || die "identity-api is not running (start the stack with scripts/up.sh first)"
    out="$(docker compose -p nearpay exec -T identity-api /nodejs/bin/node dist/ops.js seed-demo "${@:2}")" ||
      die "identity seed-demo failed"
    (umask 077 && printf '%s\n' "$out" >"$secrets/demo.json")
    sk="$(printf '%s' "$out" | node -pe 'JSON.parse(require("fs").readFileSync(0)).secret_key')"
    say "demo merchant ready (test mode); keys in .secrets/demo.json"

    mkdir -p "$secrets/merchant-demo" && chmod 755 "$secrets/merchant-demo"
    printf '%s' "$sk" >"$secrets/merchant-demo/secret_key" && chmod 644 "$secrets/merchant-demo/secret_key"
    domain="$(sed -n 's/^NP_BASE_DOMAIN=//p' "$deploy/compose/env/local.env" 2>/dev/null | tail -1)"
    domain="${NP_BASE_DOMAIN:-${domain:-nearpay.localhost}}"
    port="$(sed -n 's/^NP_HTTPS_PORT=//p' "$deploy/compose/env/local.env" 2>/dev/null | tail -1)"
    port="${NP_HTTPS_PORT:-${port:-443}}"
    api() { # method path [json]
      curl -fsS --noproxy '*' --cacert "$secrets/tls/ca.pem" --resolve "api.$domain:$port:127.0.0.1" \
        -X "$1" "https://api.$domain:$port$2" -H "authorization: Bearer $sk" \
        ${3:+-H "content-type: application/json" -H "idempotency-key: seed-$(date +%s)-$RANDOM" -d "$3"}
    }
    hook="http://merchant-demo:3000/webhooks"
    if [ -s "$secrets/merchant-demo/webhook_secret" ] &&
      api GET "/v1/webhook_endpoints?limit=100" | grep -q "\"$hook\""; then
      say "merchant-demo webhook endpoint present"
    else
      events='["payment_intent.created","payment_intent.processing","payment_intent.succeeded","payment_intent.payment_failed","payment_intent.requires_review","payment_intent.overpaid","payment_intent.canceled","checkout.session.completed","checkout.session.expired","agent_payment.settled","agent_payment.failed"]'
      created="$(api POST /v1/webhook_endpoints "{\"url\":\"$hook\",\"enabled_events\":$events,\"description\":\"merchant-demo (seed.sh)\"}")" ||
        die "creating the merchant-demo webhook endpoint failed (is webhooks-api running?)"
      printf '%s' "$created" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).secret))' \
        >"$secrets/merchant-demo/webhook_secret"
      chmod 644 "$secrets/merchant-demo/webhook_secret"
      say "merchant-demo webhook endpoint created ($hook)"
    fi

    agent="${NP_DEMO_AGENT_ACCOUNT:-0857962d91335176f92257df38175401936a4ca31b832f0c98c77b836800c655}" # test-only key (testbed demo/agent.ts)
    usdc="nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"
    if running sandbox-api; then
      bal="$(docker compose -p nearpay exec -T sandbox-api /nodejs/bin/node dist/ops.js intents-balance "$agent" "$usdc" |
        node -pe 'JSON.parse(require("fs").readFileSync(0)).balance')"
      if [ "$bal" -lt 100000000 ]; then
        docker compose -p nearpay exec -T sandbox-api /nodejs/bin/node dist/ops.js intents-fund "$agent" "$usdc" \
          "$((100000000 - bal))" >/dev/null || die "funding the demo agent failed"
      fi
      say "demo agent $agent: 100 USDC in the sandbox Intents ledger"
    fi
    ;;
  live)
    # Owner-provided mainnet credentials (never generated here); see scripts/lib/live-overlay.mjs.
    mkdir -p "$secrets/live" && chmod 700 "$secrets/live"
    node "$deploy/scripts/lib/live-overlay.mjs" "$secrets/live" || die "fix the files in .secrets/live/ and re-run"
    for v in NP_TREASURY_ACCOUNT NP_RELAYER_ACCOUNT NP_EVM_RPC_URLS_8453 NP_EVM_RPC_URLS_42161; do
      val="$(sed -n "s/^$v=//p" "$env_file" 2>/dev/null | tail -1)"
      say "  $v: ${val:-<unset in compose/env/local.env>}"
    done
    say "overlay written to .secrets/live/compose.live.yaml (up.sh includes it)"
    ;;
  *)
    say "usage: scripts/seed.sh keys [--renew-tls] | data | live" >&2
    exit 2
    ;;
esac
