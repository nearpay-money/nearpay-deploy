#!/usr/bin/env bash
# The closed beta at nearpay.money, run from the owner's Mac (docs/beta-launch.md). One guided, idempotent script:
#
#   scripts/beta.sh up [--no-pull]   preflight → sibling mains → build → start (scripts/up.sh beta) → URLs → smoke test
#   scripts/beta.sh down             stop the beta (data is kept) and let the Mac sleep again
#   scripts/beta.sh status           containers, firing alerts, keep-awake, memory per container
#   scripts/beta.sh logs <service>   follow one container's logs (e.g. payments-api, cloudflared, traefik)
#   scripts/beta.sh smoke            public URLs, Cloudflare Access on ops, Prometheus targets, egress hosts, Telegram
#   scripts/beta.sh telegram         (re)discover the Telegram chat for alerts and send a test message
#   scripts/beta.sh ops <svc> <args> run a service's ops CLI, e.g. `ops identity operator-add you@x ops_admin`
#
# Secrets stay in .secrets/ on this Mac (never in chat, never committed). Paste any error back as it is: no secret is
# ever printed. Re-running `up` is safe; it only changes what is missing or out of date.
set -euo pipefail

deploy="$(cd "$(dirname "$0")/.." && pwd)"
work="$(dirname "$deploy")"
compose_dir="$deploy/compose"
secrets="$deploy/.secrets"
beta="$secrets/beta"
live="$secrets/live"
local_env="$compose_dir/env/local.env"
beta_env="$compose_dir/env/beta.env"
owner_env="$beta/beta.env" # owner-specific values this script discovers (git-ignored)
project=nearpay-beta

SERVICES=(identity payments rails agentpay compliance webhooks notify sandbox sentinel billing)
# every repository the beta builds from (services, console image, web apps, the packages up.sh publishes)
REPOS=(nearpay-spec nearpay-kit nearpay-node nearpay-agentkit nearpay-console nearpay-js nearpay-checkout
  nearpay-dashboard nearpay-site)
for s in "${SERVICES[@]}"; do REPOS+=("nearpay-$s"); done
# public hostnames (also the Cloudflare Tunnel's public hostnames, docs/beta-launch.md step 4)
HOSTS=(nearpay.money www.nearpay.money api.nearpay.money pay.nearpay.money js.nearpay.money
  dashboard.nearpay.money ops.nearpay.money docs.nearpay.money)

if [ -t 1 ]; then B=$'\033[1m' R=$'\033[31m' G=$'\033[32m' Y=$'\033[33m' N=$'\033[0m'; else B="" R="" G="" Y="" N=""; fi
say() { printf '%s\n' "$*"; }
step() { printf '\n%s==> %s%s\n' "$B" "$*" "$N"; }
ok() { printf '  %sok%s   %s\n' "$G" "$N" "$*"; }
warn() { printf '  %swarn%s %s\n' "$Y" "$N" "$*"; }
bad() { printf '  %sFAIL%s %s\n' "$R" "$N" "$*"; }
die() { printf '\n%sbeta: %s%s\n' "$R" "$*" "$N" >&2; exit 1; }

envval() { # last value of $1 in local.env, beta.env, .secrets/beta/beta.env (Compose order), unquoted
  local f v="" x
  for f in "$local_env" "$beta_env" "$owner_env"; do
    [ -f "$f" ] || continue
    x="$(sed -n "s/^$1=//p" "$f" | tail -1)"
    [ -n "$x" ] && v="$x"
  done
  v="${v#\"}"
  printf '%s' "${v%\"}"
}

bcompose() { # the beta project, same files as scripts/up.sh beta
  local args=(-f "$compose_dir/compose.yaml" -f "$compose_dir/compose.local.yaml")
  [ -f "$live/compose.live.yaml" ] && args+=(-f "$live/compose.live.yaml")
  args+=(-f "$compose_dir/compose.beta.yaml" --env-file "$local_env" --env-file "$beta_env")
  [ -f "$owner_env" ] && args+=(--env-file "$owner_env")
  docker compose --project-name "$project" --project-directory "$compose_dir" "${args[@]}" \
    --env-file "$secrets/public/keys.env" "$@"
}

readfile() { tr -d '[:space:]' <"$1"; }

print_hostnames() { # the tunnel's public hostnames, as entered in the Cloudflare dashboard
  local h sub
  say "  Cloudflare Tunnel public hostnames (Zero Trust > Networks > Tunnels > your tunnel > Public hostnames):"
  for h in "${HOSTS[@]}"; do
    sub="${h%.nearpay.money}"
    [ "$sub" = "$h" ] && sub="(empty)"
    printf '    subdomain %-10s domain nearpay.money   service HTTP  traefik:8080\n' "$sub"
  done
}

set_owner_env() { # key value → .secrets/beta/beta.env (replaces the key)
  local tmp
  tmp="$(mktemp)"
  if [ -f "$owner_env" ]; then grep -v "^$1=" "$owner_env" >"$tmp" || true; fi
  printf '%s=%s\n' "$1" "$2" >>"$tmp"
  mv "$tmp" "$owner_env"
  chmod 644 "$owner_env"
}

telegram() { # method [curl config lines…] → JSON on stdout; the token goes to curl on stdin, never on a command line
  local method="$1" token
  shift
  token="$(readfile "$beta/telegram_bot_token")"
  { printf 'url = "https://api.telegram.org/bot%s/%s"\n' "$token" "$method"; for l in "$@"; do printf '%s\n' "$l"; done; } |
    curl -sS --max-time 20 -K -
}

# ---- preflight ------------------------------------------------------------------------------------------------------
preflight_machine() {
  step "This Mac and Docker"
  if [ "$(uname -s)" = Darwin ]; then ok "macOS $(sw_vers -productVersion 2>/dev/null)"; else warn "not macOS: keep-awake (caffeinate) is skipped"; fi
  command -v docker >/dev/null 2>&1 || die "Docker Desktop is not installed (https://www.docker.com/products/docker-desktop/)"
  docker info >/dev/null 2>&1 || die "Docker Desktop is not running: start it and run this again"
  local mem gib
  mem="$(docker info --format '{{.MemTotal}}')"
  gib=$((mem / 1073741824))
  # Docker Desktop's "8 GB" shows as ~7.7 GiB inside the VM
  if [ "$mem" -lt 8000000000 ]; then
    die "Docker Desktop has ${gib} GiB of memory; the beta needs 8 GB. Docker Desktop > Settings > Resources > Memory: 8 GB or more, Apply & restart, then run this again"
  fi
  ok "Docker Desktop memory: ${gib} GiB"
  local free_gb
  free_gb=$(($(df -Pk "$deploy" | awk 'NR==2 {print $4}') / 1048576))
  if [ "$free_gb" -lt 20 ]; then die "only ${free_gb} GB free on this disk; free at least 20 GB (images, Postgres, Prometheus)"; fi
  if [ "$free_gb" -lt 40 ]; then warn "${free_gb} GB free on this disk (40 GB or more is comfortable)"; else ok "disk: ${free_gb} GB free"; fi
  for c in curl node pnpm git openssl; do command -v "$c" >/dev/null 2>&1 || die "$c is required (see docs/beta-launch.md, 'Before you start')"; done
  ok "curl, node, pnpm, git, openssl present"
}

preflight_repos() {
  local pull="$1" r dir branch
  step "Sibling repositories (built from main)"
  for r in "${REPOS[@]}"; do
    dir="$work/$r"
    [ -d "$dir/.git" ] || die "$r is missing next to nearpay-deploy (expected $dir; run nearpay/scripts/bootstrap.sh)"
    branch="$(git -C "$dir" rev-parse --abbrev-ref HEAD)"
    [ "$branch" = main ] || die "$r is on branch '$branch'; the beta builds from main: git -C $dir switch main"
    [ -z "$(git -C "$dir" status --porcelain --untracked-files=no)" ] ||
      die "$r has uncommitted changes; commit or stash them first (git -C $dir status)"
    if [ "$pull" = 1 ]; then
      git -C "$dir" pull --ff-only --quiet || die "$r: git pull --ff-only failed (git -C $dir status)"
    fi
    ok "$r main @ $(git -C "$dir" rev-parse --short HEAD)"
  done
  for r in "${SERVICES[@]}" console; do
    [ -f "$work/nearpay-$r/Dockerfile" ] || die "nearpay-$r has no Dockerfile on main: the beta needs every service"
  done
}

check_secret() { # file, description, regex (extended), hint
  local f="$beta/$1"
  if [ ! -s "$f" ]; then bad ".secrets/beta/$1 is missing — $2"; return 1; fi
  if ! readfile "$f" | grep -Eq "$3"; then bad ".secrets/beta/$1 does not look right — $4"; return 1; fi
  ok ".secrets/beta/$1"
}

preflight_secrets() {
  step "Secrets in .secrets/beta/ (docs/beta-launch.md step 12)"
  mkdir -p "$beta" && chmod 700 "$secrets" "$beta"
  local missing=0
  if ! check_secret cloudflared_token "Cloudflare tunnel token (step 4)" '^eyJ[A-Za-z0-9+/_=-]{40,}$' \
    "paste only the token (the long eyJ… string after --token), one line"; then
    missing=1
    print_hostnames
  fi
  check_secret resend_api_key "Resend API key (step 9)" '^re_[A-Za-z0-9_]{10,}$' "Resend keys start with re_" || missing=1
  check_secret turnstile_sitekey "Turnstile site key (step 5)" '^0x[A-Za-z0-9_-]{10,}$' \
    "real site keys start with 0x (1x…/2x…/3x… are Cloudflare's test keys)" || missing=1
  check_secret turnstile_secret "Turnstile secret key (step 5)" '^0x[A-Za-z0-9_-]{10,}$' \
    "real secret keys start with 0x (1x…/2x…/3x… are Cloudflare's test keys)" || missing=1
  check_secret telegram_bot_token "Telegram bot token from @BotFather (step 10)" '^[0-9]{5,}:[A-Za-z0-9_-]{30,}$' \
    "it looks like 123456789:AA… (one line)" || missing=1
  [ "$missing" = 0 ] || die "create the missing files (one value per file, nothing else), then run this again"
  # containers run as their own users: the files must be readable inside .secrets (0700 keeps them private)
  chmod 644 "$beta"/* 2>/dev/null || true

  if [ ! -s "$beta/grafana_admin_password" ]; then
    (umask 022 && openssl rand -base64 24 | tr -d '/+=' >"$beta/grafana_admin_password")
    ok "generated .secrets/beta/grafana_admin_password (Grafana user: admin)"
  fi
  if [ ! -s "$beta/ops_attestation_roots.pem" ]; then
    # Yubico's published FIDO attestation roots (developers.yubico.com/U2F/Attestation_and_Metadata), for operators
    # with hardware keys. The beta signs in with Touch ID (NP_OPS_ALLOW_PLATFORM_PASSKEYS); this keeps the hardware-key
    # policy wired for a later switch back.
    local tmp u
    tmp="$(mktemp)"
    for u in yubico-ca-1.pem yubico-fido-ca-1.pem yubico-fido-ca-2.pem; do
      curl -fsS --max-time 20 "https://developers.yubico.com/PKI/$u" >>"$tmp" || die "downloading Yubico's attestation root $u failed"
      printf '\n' >>"$tmp"
    done
    grep -q 'BEGIN CERTIFICATE' "$tmp" || die "the Yubico attestation roots did not download as PEM"
    mv "$tmp" "$beta/ops_attestation_roots.pem" && chmod 644 "$beta/ops_attestation_roots.pem"
    ok "downloaded Yubico attestation roots → .secrets/beta/ops_attestation_roots.pem"
  fi
}

preflight_telegram() {
  local chat
  chat="${NP_TELEGRAM_CHAT_ID:-$(envval NP_TELEGRAM_CHAT_ID)}"
  if [ -z "$chat" ] || [ "${1:-}" = rediscover ]; then
    step "Telegram chat for alerts"
    local me
    me="$(telegram getMe | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j.ok?"@"+j.result.username:"")}catch{}})')"
    [ -n "$me" ] || die "Telegram does not accept the bot token in .secrets/beta/telegram_bot_token (check it with @BotFather)"
    [ -t 0 ] || die "NP_TELEGRAM_CHAT_ID is not set: run 'scripts/beta.sh telegram' in a terminal"
    say "  Open Telegram, find your bot $me, press Start (or send it any message), then come back here."
    read -r -p "  Press Enter once you have sent the message… " _
    chat="$(telegram getUpdates | node -e '
      let s=""; process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{
        try { const r = JSON.parse(s).result || [];
          for (let i = r.length - 1; i >= 0; i--) { const m = r[i].message || r[i].edited_message || r[i].channel_post;
            if (m && m.chat && m.chat.id !== undefined) { process.stdout.write(String(m.chat.id)); return; } } } catch {}
      });')"
    [ -n "$chat" ] || die "no message reached $me yet: send it a message in Telegram, then run 'scripts/beta.sh telegram'"
    set_owner_env NP_TELEGRAM_CHAT_ID "$chat"
    ok "alerts go to Telegram chat $chat (saved in .secrets/beta/beta.env)"
  fi
  printf '%s' "$chat" | grep -Eq '^-?[0-9]+$' || die "NP_TELEGRAM_CHAT_ID '$chat' is not a Telegram chat id (run: scripts/beta.sh telegram)"
  # Alertmanager cannot read environment variables: render its config with the chat id (the token stays a file)
  sed "s/__TELEGRAM_CHAT_ID__/$chat/" "$compose_dir/monitoring/alertmanager/alertmanager.yml.tmpl" >"$beta/alertmanager.yml"
  chmod 644 "$beta/alertmanager.yml"
}

preflight_live() {
  step "Live (mainnet) settings: compose/env/local.env and .secrets/live/"
  [ -f "$local_env" ] || die "compose/env/local.env is missing: run scripts/up.sh once (it creates it), then fill the accounts (mainnet checklist C.1)"
  local v missing=0
  for v in NP_TREASURY_ACCOUNT NP_RELAYER_ACCOUNT NP_NEAR_RPC_URLS NP_VAULT_CONTRACT; do
    if [ -n "$(envval "$v")" ]; then ok "$v=$(envval "$v")"; else bad "$v is empty in compose/env/local.env"; missing=1; fi
  done
  for v in 1 2 3 4; do
    if [ -s "$live/relayer_key_$v" ]; then ok ".secrets/live/relayer_key_$v"; else bad ".secrets/live/relayer_key_$v is missing"; missing=1; fi
  done
  [ "$missing" = 0 ] || die "live mode needs these (mainnet checklist C.1); add them and run this again"
  if [ -s "$live/keeper_key" ] && [ -n "$(envval NP_KEEPER_ACCOUNT)" ]; then ok "keeper key + NP_KEEPER_ACCOUNT (live auto-debit)"
  else warn "no .secrets/live/keeper_key or NP_KEEPER_ACCOUNT: live auto-debit is off until the vault is deployed (checklist B, C.1); then run 'beta.sh up' again"; fi
  if [ -s "$live/oneclick_api_key" ]; then ok ".secrets/live/oneclick_api_key"; else warn "no .secrets/live/oneclick_api_key: 1Click quotes carry its unauthenticated fee"; fi
  [ -n "$(envval NP_EVM_RPC_URLS_8453)" ] || warn "NP_EVM_RPC_URLS_8453 is empty: Base uses public RPCs (your own key is more reliable)"
  "$deploy/scripts/seed.sh" live >/dev/null || die "scripts/seed.sh live rejected a file in .secrets/live/ (run it to see which)"
  ok "live overlay written (.secrets/live/compose.live.yaml)"
}

preflight_config() {
  step "Beta configuration"
  local ip
  ip="$(envval NP_TUNNEL_IP)"
  grep -q "\"$ip/32\"" "$compose_dir/traefik/traefik.beta.yaml" ||
    die "NP_TUNNEL_IP=$ip (beta.env) differs from trustedIPs in compose/traefik/traefik.beta.yaml: keep them equal"
  ok "Traefik trusts forwarded headers from cloudflared ($ip) only"
  [ "$(envval NP_ENV)" = server ] || die "NP_ENV must be server for the beta (compose/env/beta.env)"
  ok "NP_ENV=server, NP_BASE_DOMAIN=$(envval NP_BASE_DOMAIN)"
  if docker compose -p nearpay ps -q 2>/dev/null | grep -q .; then
    warn "the local test stack (project nearpay) is running: stopping it (its data is kept)"
    "$deploy/scripts/down.sh" >/dev/null
  fi
}

keep_awake() {
  [ "$(uname -s)" = Darwin ] || return 0
  local pidf="$beta/caffeinate.pid"
  if [ -f "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null; then ok "keep-awake already on (caffeinate pid $(cat "$pidf"))"; return; fi
  # -i idle sleep, -m disk sleep, -s system sleep (on power adapter). Closing the lid still sleeps a MacBook
  # without an external display: keep it open and plugged in.
  nohup caffeinate -ims >/dev/null 2>&1 &
  echo $! >"$pidf"
  ok "keep-awake on (caffeinate pid $!); keep the Mac plugged in with the lid open"
}

# ---- smoke ----------------------------------------------------------------------------------------------------------
smoke() {
  local fail=0 h code loc i
  step "Public URLs (through Cloudflare)"
  for i in $(seq 1 12); do
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 https://api.nearpay.money/healthz 2>/dev/null || true)"
    [ "$code" = 200 ] && break
    [ "$i" = 1 ] && say "  waiting for https://api.nearpay.money/healthz (DNS and the tunnel can take a minute)…"
    sleep 5
  done
  if [ "$code" = 200 ]; then ok "https://api.nearpay.money/healthz → 200 (identity ready)"
  else bad "https://api.nearpay.money/healthz → ${code:-no answer} (beta.sh logs cloudflared; beta.sh logs identity-api)"; fail=1; fi
  for h in nearpay.money pay.nearpay.money dashboard.nearpay.money docs.nearpay.money; do
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "https://$h/" 2>/dev/null || true)"
    case "$code" in 2* | 3*) ok "https://$h/ → $code" ;; *) bad "https://$h/ → ${code:-no answer}"; fail=1 ;; esac
  done
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 https://js.nearpay.money/v1/nearpay.js 2>/dev/null || true)"
  if [ "$code" = 200 ]; then ok "https://js.nearpay.money/v1/nearpay.js → 200"; else bad "https://js.nearpay.money/v1/nearpay.js → ${code:-no answer}"; fail=1; fi
  loc="$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 10 https://www.nearpay.money/x 2>/dev/null || true)"
  case "$loc" in "301 https://nearpay.money/x") ok "https://www.nearpay.money → https://nearpay.money" ;; *) bad "www redirect: got '$loc'"; fail=1 ;; esac

  step "Cloudflare Access in front of the console"
  for h in "https://ops.nearpay.money/" "https://ops.nearpay.money/api/ops/merchants"; do
    loc="$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 10 "$h" 2>/dev/null || true)"
    case "$loc" in
      30[23]\ https://*.cloudflareaccess.com/*) ok "$h → Cloudflare Access sign-in" ;;
      401\ * | 403\ *) ok "$h → ${loc%% *} (refused at the edge)" ;;
      *) bad "$h → '$loc': Cloudflare Access is NOT protecting the console (docs/beta-launch.md step 6)"; fail=1 ;;
    esac
  done

  step "Monitoring (this Mac)"
  local pport down
  pport="$(envval NP_PROMETHEUS_PORT)"
  # shellcheck disable=SC2016 # JavaScript template literal
  down="$(curl -sS --max-time 10 "http://127.0.0.1:${pport:-9090}/api/v1/targets?state=active" 2>/dev/null | node -e '
    let s=""; process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{
      try { const t = JSON.parse(s).data.activeTargets;
        const d = t.filter((x) => x.health !== "up").map((x) => x.labels.instance || x.scrapeUrl);
        process.stdout.write(d.length ? d.join(" ") : `ALLUP ${t.length}`); } catch { process.stdout.write("ERROR"); } });' || echo ERROR)"
  case "$down" in
    ALLUP*) ok "Prometheus: all ${down#ALLUP } targets up" ;;
    ERROR) bad "Prometheus does not answer on 127.0.0.1:${pport:-9090}"; fail=1 ;;
    *) bad "Prometheus targets down: $down (they may still be starting; re-run 'beta.sh smoke' in a minute)"; fail=1 ;;
  esac
  if curl -fsS --max-time 5 "http://127.0.0.1:$(envval NP_ALERTMANAGER_PORT)/-/ready" >/dev/null 2>&1; then ok "Alertmanager ready"
  else bad "Alertmanager not ready (beta.sh logs alertmanager)"; fail=1; fi

  step "Internet hosts the services call (compose/egress/allowlist.yaml)"
  local line host port
  while IFS= read -r line; do
    host="$(printf '%s' "$line" | sed -n 's/.*host: \([^,]*\),.*/\1/p')"
    port="$(printf '%s' "$line" | sed -n 's/.*port: \([0-9]*\).*/\1/p')"
    if [ -z "$host" ] || [ -z "$port" ]; then continue; fi
    if bcompose exec -T egress-proxy nc -z -w 5 "$host" "$port" >/dev/null 2>&1; then ok "$host:$port"
    else bad "$host:$port unreachable from the stack (firewall/VPN on this Mac?)"; fail=1; fi
  done < <(grep 'beta_smoke: true' "$compose_dir/egress/allowlist.yaml")

  step "Telegram alert channel"
  local chat res
  chat="$(envval NP_TELEGRAM_CHAT_ID)"
  res="$(telegram sendMessage "data = \"chat_id=$chat\"" \
    "data-urlencode = \"text=NearPay beta: smoke test from $(hostname -s) at $(date -u '+%Y-%m-%d %H:%M UTC'). Alerts arrive in this chat.\"" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j.ok?"ok":String(j.description))}catch{process.stdout.write("no answer")}})' || true)"
  if [ "$res" = ok ]; then ok "test message sent to Telegram chat $chat"; else bad "Telegram: $res (run: scripts/beta.sh telegram)"; fail=1; fi

  say ""
  if [ "$fail" = 0 ]; then say "${G}Smoke test passed.${N}"; else say "${R}Smoke test found problems (above).${N} Paste this output back."; return 1; fi
}

# ---- commands -------------------------------------------------------------------------------------------------------
cmd="${1:-}"
[ $# -gt 0 ] && shift
case "$cmd" in
  up)
    pull=1
    for a in "$@"; do case "$a" in --no-pull) pull=0 ;; *) die "unknown option $a (usage: beta.sh up [--no-pull])" ;; esac; done
    preflight_machine
    preflight_repos "$pull"
    preflight_secrets
    preflight_telegram
    preflight_live
    preflight_config
    step "Keep this Mac awake"
    keep_awake
    step "Build and start (scripts/up.sh beta; the first run takes a while)"
    "$deploy/scripts/up.sh" beta
    smoke || die "the beta is running but the smoke test failed; fix the FAIL lines and run: scripts/beta.sh smoke"
    say ""
    say "Grafana: http://127.0.0.1:$(envval NP_GRAFANA_PORT)  (user admin, password in .secrets/beta/grafana_admin_password)"
    say "Next: docs/beta-launch.md step 14 (operators, live setup)."
    ;;
  down)
    "$deploy/scripts/down.sh" beta
    if [ -f "$beta/caffeinate.pid" ]; then kill "$(cat "$beta/caffeinate.pid")" 2>/dev/null || true; rm -f "$beta/caffeinate.pid"; fi
    say "beta stopped (data kept; 'scripts/beta.sh up' starts it again)"
    ;;
  status)
    bcompose ps -a --format 'table {{.Service}}\t{{.Status}}'
    if [ -f "$beta/caffeinate.pid" ] && kill -0 "$(cat "$beta/caffeinate.pid")" 2>/dev/null; then say "keep-awake: on"; else say "keep-awake: OFF"; fi
    firing="$(curl -sS --max-time 5 "http://127.0.0.1:$(envval NP_ALERTMANAGER_PORT)/api/v2/alerts?active=true&silenced=false" 2>/dev/null |
      node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s);process.stdout.write(a.length?a.map(x=>x.labels.alertname+"("+(x.labels.service||x.labels.instance||"")+")").join(" "):"none")}catch{process.stdout.write("Alertmanager not answering")}})' || true)"
    say "firing alerts: $firing"
    print_hostnames
    # shellcheck disable=SC2046 # one argument per container id
    docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}' $(bcompose ps -q) 2>/dev/null || true
    ;;
  logs)
    [ $# -ge 1 ] || die "usage: beta.sh logs <service> (e.g. payments-api, cloudflared, traefik, notify-worker)"
    bcompose logs -f --tail 200 "$1"
    ;;
  smoke) smoke ;;
  telegram)
    preflight_telegram rediscover
    smoke_chat="$(envval NP_TELEGRAM_CHAT_ID)"
    telegram sendMessage "data = \"chat_id=$smoke_chat\"" "data-urlencode = \"text=NearPay beta: this chat now receives alerts.\"" >/dev/null
    say "test message sent; run 'scripts/beta.sh up' (or restart Alertmanager) to apply the chat"
    ;;
  ops)
    [ $# -ge 2 ] || die "usage: beta.sh ops <identity|compliance|payments|…> <command…> (e.g. ops identity operator-add you@x ops_admin)"
    svc="$1"
    shift
    bcompose exec "$svc-api" /nodejs/bin/node dist/ops.js "$@"
    ;;
  -h | --help | "") sed -n '2,13p' "$0" ;;
  *) die "unknown command '$cmd' (beta.sh --help)" ;;
esac
