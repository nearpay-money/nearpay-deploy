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
    #    (payment_intent.*, checkout.session.*, agent_payment.*, refund.*, invoice.*, customer.subscription.*, mandate.*)
    #    with its signing secret, in .secrets/merchant-demo/ (test-mode values; readable by the container user)
    # 3. sandbox: the demo agent's simulated Intents balance (USDC), topped up to 100 USDC
    # 4. billing (Stage 3, when billing-api runs): a product with a one-time and a monthly price, an exclusive tax
    #    rate and a customer; ids in .secrets/demo-billing.json (created once, recognised by metadata seed=nearpay-demo).
    #    Stage 4: both monthly prices are auto-debit eligible — USD (paid at par in USDC) and a USDC-on-NEAR asset price
    #    (price_monthly_usdc, added to an existing catalogue); the vault tokens must be in rails' token registry.
    # The demo secret key (sk_test_) also works with the CLI (`nearpay listen|trigger --api-key`); `nearpay login`
    # needs a dashboard user with a passkey (sign up at dashboard.<domain>; the testbed signs up its own).
    running() { docker compose -p nearpay ps --status running --services 2>/dev/null | grep -qx "$1"; }
    running identity-api || die "identity-api is not running (start the stack with scripts/up.sh first)"
    # identity checks the destination asset against rails' token registry; on a fresh stack rails' first refresh can
    # run before the sandbox answers (seen on a fresh stack: asset_unsupported), so refresh before seeding.
    if running rails-api; then
      docker compose -p nearpay exec -T rails-api /nodejs/bin/node dist/ops.js tokens-refresh >/dev/null ||
        die "rails tokens-refresh failed"
    fi
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
    events='["payment_intent.created","payment_intent.processing","payment_intent.succeeded","payment_intent.payment_failed","payment_intent.requires_review","payment_intent.overpaid","payment_intent.canceled","checkout.session.completed","checkout.session.expired","agent_payment.settled","agent_payment.failed","refund.created","refund.requires_action","refund.pending","refund.succeeded","refund.failed","refund.canceled","invoice.created","invoice.finalized","invoice.sent","invoice.paid","invoice.payment_failed","invoice.overdue","invoice.voided","invoice.marked_uncollectible","customer.subscription.created","customer.subscription.updated","customer.subscription.deleted","customer.subscription.renewal_upcoming","mandate.activated","mandate.collected","mandate.insufficient_funds","mandate.canceled","mandate.exhausted","mandate.updated","mandate.unlinked","mandate.released"]'
    endpoints="$(api GET "/v1/webhook_endpoints?limit=100")" || die "listing webhook endpoints failed (is webhooks-api running?)"
    if [ -s "$secrets/merchant-demo/webhook_secret" ] && printf '%s' "$endpoints" | grep -q "\"$hook\""; then
      # an endpoint from an earlier stage: add the event types it lacks (PATCH replaces the list)
      # shellcheck disable=SC2016 # JavaScript template literal, not a shell expansion
      patch="$(printf '%s' "$endpoints" | node -e '
        let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
          const [hook, want] = [process.argv[1], JSON.parse(process.argv[2])];
          const ep = JSON.parse(s).data.find((e) => e.url === hook);
          const missing = want.filter((t) => !ep.enabled_events.includes(t) && !ep.enabled_events.includes("*"));
          if (missing.length) process.stdout.write(`${ep.id} ${JSON.stringify({ enabled_events: [...ep.enabled_events, ...missing] })}`);
        });' "$hook" "$events")"
      if [ -n "$patch" ]; then
        api PATCH "/v1/webhook_endpoints/${patch%% *}" "${patch#* }" >/dev/null || die "updating the merchant-demo webhook endpoint failed"
        say "merchant-demo webhook endpoint present (added the missing event types)"
      else
        say "merchant-demo webhook endpoint present"
      fi
    else
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

    # Stage 4: the vault's allowed tokens (billing NP_VAULT_TOKENS; default NEAR USDC + USDT, the stand-in's tokens)
    # must be registered in rails' test-mode token registry, or prepareMandate answers auto_debit_unavailable.
    if running rails-api && running billing-api; then
      vault_tokens="$(sed -n 's/^NP_VAULT_TOKENS=//p' "$env_file" 2>/dev/null | tail -1)"
      vault_tokens="${vault_tokens:-17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1,usdt.tether-token.near}"
      # shellcheck disable=SC2016 # JavaScript template literal, not a shell expansion
      missing_tokens="$(api GET /v1/assets | node -e '
        let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
          const have = new Set(JSON.parse(s).data.map((a) => a.asset_id));
          const miss = process.argv[1].split(",").map((t) => t.trim()).filter((t) => t && !have.has(`nep141:${t}`));
          process.stdout.write(miss.join(" "));
        });' "$vault_tokens")" || die "listing assets failed (is rails-api running?)"
      [ -z "$missing_tokens" ] || die "vault tokens missing from the rails token registry: $missing_tokens"
      say "vault tokens registered in rails: $vault_tokens"
    fi

    # billing catalogue (Stage 3): created once; .secrets/demo-billing.json keeps the ids
    if running billing-api; then
      if [ -s "$secrets/demo-billing.json" ] &&
        api GET "/v1/products/$(node -pe 'require(process.argv[1]).product' "$secrets/demo-billing.json")" >/dev/null 2>&1; then
        say "demo billing catalogue present (.secrets/demo-billing.json)"
        # Stage 4: an asset-priced monthly price (10 USDC on NEAR) for catalogues seeded before it existed
        if ! grep -q '"price_monthly_usdc"' "$secrets/demo-billing.json"; then
          product="$(node -pe 'require(process.argv[1]).product' "$secrets/demo-billing.json")"
          usdc_monthly="$(api POST /v1/prices "{\"product\":\"$product\",\"unit_amount\":\"10000000\",\"currency\":\"asset\",\"asset_id\":\"$usdc\",\"recurring\":{\"interval\":\"month\"},\"nickname\":\"Monthly (USDC)\",\"metadata\":{\"seed\":\"nearpay-demo\"}}" |
            node -pe 'JSON.parse(require("fs").readFileSync(0)).id')" || die "creating the demo USDC monthly price failed"
          (umask 077 && node -e 'const f=process.argv[1];const j=require(f);j.price_monthly_usdc=process.argv[2];require("fs").writeFileSync(f,JSON.stringify(j)+"\n")' \
            "$secrets/demo-billing.json" "$usdc_monthly")
          say "demo USDC monthly price created: $usdc_monthly (auto-debit eligible)"
        fi
      else
        jget() { node -pe 'JSON.parse(require("fs").readFileSync(0)).id'; }
        meta='"metadata":{"seed":"nearpay-demo"}'
        product="$(api POST /v1/products "{\"name\":\"NearPay Demo Plan\",\"description\":\"Seeded by nearpay-deploy (test mode)\",$meta}" | jget)" ||
          die "creating the demo product failed"
        one_time="$(api POST /v1/prices "{\"product\":\"$product\",\"unit_amount\":2500,\"currency\":\"usd\",\"nickname\":\"One-time setup\",$meta}" | jget)" ||
          die "creating the demo one-time price failed"
        monthly="$(api POST /v1/prices "{\"product\":\"$product\",\"unit_amount\":1000,\"currency\":\"usd\",\"recurring\":{\"interval\":\"month\"},\"nickname\":\"Monthly\",$meta}" | jget)" ||
          die "creating the demo monthly price failed"
        usdc_monthly="$(api POST /v1/prices "{\"product\":\"$product\",\"unit_amount\":\"10000000\",\"currency\":\"asset\",\"asset_id\":\"$usdc\",\"recurring\":{\"interval\":\"month\"},\"nickname\":\"Monthly (USDC)\",$meta}" | jget)" ||
          die "creating the demo USDC monthly price failed"
        tax="$(api POST /v1/tax_rates "{\"display_name\":\"VAT\",\"percentage\":\"19\",\"inclusive\":false,\"jurisdiction\":\"DE\",$meta}" | jget)" ||
          die "creating the demo tax rate failed"
        customer="$(api POST /v1/customers "{\"email\":\"customer@merchant.test\",\"name\":\"Demo Customer\",$meta}" | jget)" ||
          die "creating the demo customer failed"
        (umask 077 && printf '{"product":"%s","price_one_time":"%s","price_monthly":"%s","price_monthly_usdc":"%s","tax_rate":"%s","customer":"%s"}\n' \
          "$product" "$one_time" "$monthly" "$usdc_monthly" "$tax" "$customer" >"$secrets/demo-billing.json")
        say "demo billing catalogue created: $product (prices $one_time, $monthly, $usdc_monthly), tax rate $tax, customer $customer"
      fi
    fi
    ;;
  live)
    # Owner-provided mainnet credentials (never generated here); see scripts/lib/live-overlay.mjs.
    mkdir -p "$secrets/live" && chmod 700 "$secrets/live"
    node "$deploy/scripts/lib/live-overlay.mjs" "$secrets/live" || die "fix the files in .secrets/live/ and re-run"
    for v in NP_TREASURY_ACCOUNT NP_RELAYER_ACCOUNT NP_KEEPER_ACCOUNT NP_VAULT_CONTRACT NP_EVM_RPC_URLS_8453 NP_EVM_RPC_URLS_42161 NP_SOLANA_RPC_URLS NP_BITCOIN_ESPLORA_URLS; do
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
