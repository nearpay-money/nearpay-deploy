#!/usr/bin/env bash
# The closed beta at nearpay.money, run from the owner's Mac (docs/beta-launch.md). One guided, idempotent script:
#
#   scripts/beta.sh up [--no-pull]   preflight → sibling mains → build → start (scripts/up.sh beta) → URLs → smoke test
#   scripts/beta.sh down             stop the beta (data is kept) and let the Mac sleep again
#   scripts/beta.sh status           uptime summary (containers, tunnel, keep-awake, autostart, watchdog, kill switch,
#                                    live routing), firing alerts, memory per container
#   scripts/beta.sh doctor           is this Mac set up to keep the beta running on its own? each problem with its fix
#   scripts/beta.sh install-autostart   launchd: start the beta at login, keep the Mac awake, watchdog every minute
#   scripts/beta.sh uninstall-autostart remove those three launchd jobs
#   scripts/beta.sh watchdog [pause [min]|resume|log]  one watchdog round (launchd runs it), pause/resume healing, its log
#   scripts/beta.sh logs <service>   follow one container's logs (e.g. payments-api, cloudflared, traefik)
#   scripts/beta.sh smoke            public URLs, Cloudflare Access on ops, Prometheus targets, live routing, egress hosts, Telegram
#   scripts/beta.sh routing          can live payments route? blocking reasons with a fix each (rails routing health)
#   scripts/beta.sh telegram         (re)discover the Telegram chat for alerts and send a test message
#   scripts/beta.sh ops <svc> <args> run a service's ops CLI, e.g. `ops compliance kyb-show <acct_…>`
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
# uptime (docs/beta-launch.md "Uptime"): launchd jobs, the watchdog's state and the marker `down` leaves
stopped_marker="$beta/stopped"      # present after `beta.sh down`: autostart, keep-awake and the watchdog stand still
pause_file="$beta/watchdog.paused"  # `beta.sh watchdog pause`: epoch seconds until which the watchdog only reports
wd_state="$beta/watchdog-state.json"
expected_file="$beta/expected-services" # long-running services of the last successful `up` (watchdog: what is missing)
lock_dir="$beta/run.lock"           # one `up` / autostart / watchdog round at a time
log_dir="${NP_BETA_LOG_DIR:-$HOME/Library/Logs/NearPay}"
agents_dir="$HOME/Library/LaunchAgents"
AGENTS=(money.nearpay.beta.autostart money.nearpay.beta.keepawake money.nearpay.beta.watchdog)
keepawake_label=money.nearpay.beta.keepawake

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

# ---- lock, exit hooks, notices --------------------------------------------------------------------------------------
lock_held=0
silence_id=""
on_exit() {
  if [ -n "$silence_id" ]; then
    node "$deploy/scripts/lib/alertmanager-silence.mjs" expire "http://127.0.0.1:$(envval NP_ALERTMANAGER_PORT)" "$silence_id" >/dev/null 2>&1 || true
  fi
  if [ "$lock_held" = 1 ] && [ "$(cat "$lock_dir/pid" 2>/dev/null)" = "$$" ]; then rm -rf "$lock_dir"; fi
}
trap on_exit EXIT

lock_try() { # succeeds when this process now holds the lock (stale locks of dead processes are taken over)
  [ "${NP_BETA_LOCK_HELD:-0}" = 1 ] && return 0 # a parent (watchdog/autostart) holds it for us
  mkdir -p "$beta"
  if mkdir "$lock_dir" 2>/dev/null; then echo $$ >"$lock_dir/pid"; lock_held=1; return 0; fi
  local pid
  pid="$(cat "$lock_dir/pid" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then return 1; fi
  # no pid yet: another process is between mkdir and writing it, unless the directory is older than a minute
  if [ -z "$pid" ] && [ -z "$(find "$lock_dir" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then return 1; fi
  rm -rf "$lock_dir"
  if mkdir "$lock_dir" 2>/dev/null; then echo $$ >"$lock_dir/pid"; lock_held=1; return 0; fi
  return 1
}

lock_wait() { # seconds
  local waited=0
  until lock_try; do
    [ "$waited" -ge "$1" ] && return 1
    [ "$waited" = 0 ] && say "  …    waiting for another beta.sh up / watchdog round to finish (pid $(cat "$lock_dir/pid" 2>/dev/null))"
    sleep 5
    waited=$((waited + 5))
  done
}

tg_notify() { # best effort: a Telegram message to the alert chat (no output, never fails)
  local chat
  chat="$(envval NP_TELEGRAM_CHAT_ID)"
  [ -n "$chat" ] && [ -s "$beta/telegram_bot_token" ] || return 0
  local text="${1//\"/\'}"
  telegram sendMessage "data = \"chat_id=$chat\"" "data-urlencode = \"text=NearPay beta ($(hostname -s)): ${text//\\/}\"" >/dev/null 2>&1 || true
}

# HTTP status of a URL with retries and backoff (3 s, 6 s, …) while it is not 2xx/3xx; "" = no answer
http_code() {
  local url="$1" tries="${2:-3}" i code=""
  for i in $(seq 1 "$tries"); do
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$url" 2>/dev/null || true)"
    case "$code" in 2* | 3*) break ;; esac
    [ "$i" -lt "$tries" ] && sleep $((i * 3))
  done
  [ "$code" = 000 ] && code=""
  printf '%s' "$code"
}

project_containers() { docker ps -aq --filter "label=com.docker.compose.project=$project" 2>/dev/null; }

record_expected() { # long-running services of the stack as it is now (after a successful up)
  local ids
  ids="$(project_containers)"
  [ -n "$ids" ] || return 0
  # shellcheck disable=SC2086 # one argument per container id
  docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}} {{.HostConfig.RestartPolicy.Name}}' $ids |
    awk '$2 != "no" && $2 != "" {print $1}' | LC_ALL=C sort -u >"$expected_file"
}

stack_missing() { # prints the expected services without a container (all of them = "no containers")
  local present
  present="$(docker ps -a --filter "label=com.docker.compose.project=$project" --format '{{.Label "com.docker.compose.service"}}' 2>/dev/null | LC_ALL=C sort -u)"
  if [ -z "$present" ]; then echo "(no beta containers)"; return; fi
  [ -s "$expected_file" ] || return 0
  printf '%s\n' "$present" | LC_ALL=C comm -23 "$expected_file" - | tr '\n' ' '
}

is_macos() { [ "$(uname -s)" = Darwin ]; }
agent_loaded() { is_macos && launchctl print "gui/$(id -u)/$1" >/dev/null 2>&1; }

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
  # The beta's memory reservations add up to ~6 GB (compose.beta.yaml); 10 GB leaves room for peaks and builds.
  if [ "$mem" -lt 9500000000 ]; then warn "Docker Desktop memory: ${gib} GiB (10 GB recommended: Settings > Resources > Memory)"
  else ok "Docker Desktop memory: ${gib} GiB"; fi
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
  preflight_google
  # containers run as their own users: the files must be readable inside .secrets (0700 keeps them private)
  chmod 644 "$beta"/* 2>/dev/null || true

  if [ ! -s "$beta/grafana_admin_password" ]; then
    (umask 022 && openssl rand -base64 24 | tr -d '/+=' >"$beta/grafana_admin_password")
    ok "generated .secrets/beta/grafana_admin_password (Grafana user: admin)"
  fi
  if [ ! -s "$beta/ops_attestation_roots.pem" ]; then
    # Yubico's published FIDO attestation roots (developers.yubico.com/U2F/Attestation_and_Metadata), for operators
    # with hardware keys. The beta signs in through Cloudflare Access (NP_OPS_AUTH_MODE); this keeps passkey mode's
    # hardware-key policy wired for a later switch back.
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

preflight_google() { # Continue with Google (ADR-0026), optional: docs/beta-launch.md step 13a
  local id f="$beta/google_client_secret"
  id="$(envval NP_GOOGLE_CLIENT_ID)"
  # Compose needs the secret file to exist; an empty file leaves Google sign-in off (identity starts either way)
  if [ ! -e "$f" ]; then (umask 022 && : >"$f"); fi
  if [ -z "$id" ] && [ ! -s "$f" ]; then ok "Continue with Google: off (optional, step 13a)"; return 0; fi
  if [ -z "$id" ]; then warn "Continue with Google: off — .secrets/beta/google_client_secret is set but NP_GOOGLE_CLIENT_ID is empty (put it in .secrets/beta/beta.env)"; return 0; fi
  if [ ! -s "$f" ]; then warn "Continue with Google: off — NP_GOOGLE_CLIENT_ID is set but .secrets/beta/google_client_secret is empty"; return 0; fi
  printf '%s' "$id" | grep -Eq '^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$' ||
    die "NP_GOOGLE_CLIENT_ID should look like 123456789012-abc….apps.googleusercontent.com (Google Cloud > Clients)"
  readfile "$f" | grep -Eq '^[A-Za-z0-9_-]{20,}$' ||
    die ".secrets/beta/google_client_secret does not look like a client secret (one line, usually GOCSPX-…)"
  ok "Continue with Google: on (client $id; redirect URI https://dashboard.nearpay.money/api/auth/google/callback)"
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

preflight_access() { # Cloudflare Access values identity verifies the console's JWT with (docs/beta-launch.md step 7)
  step "Cloudflare Access for the console (ops.nearpay.money)"
  local aud team
  aud="${NP_CF_ACCESS_AUD:-$(envval NP_CF_ACCESS_AUD)}"
  team="${NP_CF_ACCESS_TEAM_DOMAIN:-$(envval NP_CF_ACCESS_TEAM_DOMAIN)}"
  if [ -z "$aud" ] || [ -z "$team" ]; then
    [ -t 0 ] || die "NP_CF_ACCESS_AUD / NP_CF_ACCESS_TEAM_DOMAIN are not set: run 'scripts/beta.sh up' in a terminal (docs/beta-launch.md step 7)"
    say "  From docs/beta-launch.md step 7 (both are identifiers, not secrets):"
    [ -n "$aud" ] || read -r -p "  Application Audience (AUD) Tag of the 'NearPay console' Access app: " aud
    [ -n "$team" ] || read -r -p "  Team domain (like nearpay.cloudflareaccess.com): " team
    team="${team#https://}"
    team="${team%%/*}"
  fi
  printf '%s' "$aud" | grep -Eq '^[0-9a-f]{64}$' || die "the AUD tag should be 64 hex characters (Access > Applications > NearPay console > Overview)"
  printf '%s' "$team" | grep -Eq '^[a-z0-9-]+\.cloudflareaccess\.com$' || die "the team domain should look like <team>.cloudflareaccess.com"
  [ "$(envval NP_CF_ACCESS_AUD)" = "$aud" ] || set_owner_env NP_CF_ACCESS_AUD "$aud"
  [ "$(envval NP_CF_ACCESS_TEAM_DOMAIN)" = "$team" ] || set_owner_env NP_CF_ACCESS_TEAM_DOMAIN "$team"
  if curl -fsS --max-time 10 "https://$team/cdn-cgi/access/certs" | grep -q '"keys"'; then ok "Access team $team answers (signing keys)"
  else die "https://$team/cdn-cgi/access/certs does not answer: check the team domain (Zero Trust > Settings > Custom Pages)"; fi
  ok "AUD tag saved; console operators sign in with Google through Access (bootstrap: $(envval NP_OPS_BOOTSTRAP_EMAIL))"
}

preflight_live() {
  step "Live (mainnet) settings: compose/env/local.env and .secrets/live/"
  [ -f "$local_env" ] || die "compose/env/local.env is missing: run scripts/up.sh once (it creates it), then fill the accounts (mainnet checklist C.1)"
  local v vault missing=0
  for v in NP_TREASURY_ACCOUNT NP_RELAYER_ACCOUNT NP_NEAR_RPC_URLS; do
    if [ -n "$(envval "$v")" ]; then ok "$v=$(envval "$v")"; else bad "$v is empty in compose/env/local.env"; missing=1; fi
  done
  # The vault is optional for the first start; never an account under nearpay.near (someone else controls it, and
  # live checkout would send payers' mandate funding to whatever contract they deploy there).
  vault="$(envval NP_VAULT_CONTRACT)"
  case "$vault" in
    "") warn "NP_VAULT_CONTRACT is empty: live auto-debit is off until the vault is deployed (mainnet checklist B); then set it and run 'beta.sh up' again" ;;
    nearpay.near | *.nearpay.near)
      die "NP_VAULT_CONTRACT=$vault is under nearpay.near, which NearPay does not control: payers' mandate funding would go to someone else's contract. Set it to the account you deployed the vault to (mainnet checklist A.4/B), or leave it empty (live auto-debit off)" ;;
    *) ok "NP_VAULT_CONTRACT=$vault" ;;
  esac
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
  is_macos || return 0
  rm -f "$stopped_marker"
  if agent_loaded "$keepawake_label"; then
    launchctl kickstart "gui/$(id -u)/$keepawake_label" >/dev/null 2>&1 || true
    ok "keep-awake on (caffeinate owned by launchd, $keepawake_label); keep the Mac plugged in with the lid open"
    return
  fi
  local pidf="$beta/caffeinate.pid"
  if [ -f "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null; then ok "keep-awake already on (caffeinate pid $(cat "$pidf"))"; return; fi
  # -i idle sleep, -m disk sleep, -s system sleep (on power adapter). Closing the lid still sleeps a MacBook
  # without an external display: keep it open and plugged in.
  nohup caffeinate -ims >/dev/null 2>&1 &
  echo $! >"$pidf"
  ok "keep-awake on (caffeinate pid $!); keep the Mac plugged in with the lid open"
  warn "this caffeinate ends with a reboot or logout: run 'scripts/beta.sh install-autostart' so launchd keeps the Mac awake"
}

# ---- uptime: watchdog, launchd, status summary ----------------------------------------------------------------------
wd_paused() { # succeeds while `beta.sh watchdog pause` is in effect (an expired pause is removed)
  [ -f "$pause_file" ] || return 1
  if [ "$(date +%s)" -lt "$(cat "$pause_file" 2>/dev/null || echo 0)" ]; then return 0; fi
  rm -f "$pause_file"
  return 1
}

wd_env() { # the environment scripts/lib/watchdog.mjs reads
  local installed=0
  [ -f "$agents_dir/money.nearpay.beta.watchdog.plist" ] && installed=1
  export NP_WD_PROJECT="$project" NP_WD_STATE="$wd_state" NP_WD_LOG="$log_dir/watchdog.log" NP_WD_UP_LOG="$log_dir/watchdog-up.log" \
    NP_WD_EXPECTED="$expected_file" NP_WD_BETA_SH="$deploy/scripts/beta.sh" NP_WD_INSTALLED="$installed" \
    NP_WD_HEALTHCHECKS_URL_FILE="$beta/healthchecks_url" NP_TELEGRAM_TOKEN_FILE="$beta/telegram_bot_token" \
    NP_TELEGRAM_CHAT_ID NP_WD_HOST
  NP_TELEGRAM_CHAT_ID="$(envval NP_TELEGRAM_CHAT_ID)"
  NP_WD_HOST="$(hostname -s)"
  NP_WD_STOPPED=0; [ -e "$stopped_marker" ] && NP_WD_STOPPED=1
  NP_WD_PAUSED=0; wd_paused && NP_WD_PAUSED=1
  export NP_WD_STOPPED NP_WD_PAUSED
}

watchdog_round() { # one round; the lock keeps it out of a running `beta.sh up`
  mkdir -p "$log_dir" "$beta"
  wd_env
  NP_WD_BUSY=0
  lock_try || NP_WD_BUSY=1
  export NP_WD_BUSY
  node "$deploy/scripts/lib/watchdog.mjs" run || true
}

wait_docker() { # seconds; opens Docker Desktop on macOS while waiting
  local waited=0
  until docker info >/dev/null 2>&1; do
    if is_macos && [ $((waited % 120)) = 0 ]; then open -ga Docker 2>/dev/null || true; fi
    [ "$waited" -ge "$1" ] && return 1
    sleep 10
    waited=$((waited + 10))
  done
}

autostart() { # launchd at login (money.nearpay.beta.autostart): Docker Desktop, then the beta if anything is missing
  local was_down=0 missing rc=0
  say "$(date -u '+%Y-%m-%d %H:%M:%S UTC') autostart (login)"
  if [ -e "$stopped_marker" ]; then say "  the beta was stopped with beta.sh down: nothing to start"; return 0; fi
  docker info >/dev/null 2>&1 || was_down=1
  if ! wait_docker 900; then
    tg_notify "after login, Docker Desktop did not start within 15 minutes, so the beta is down. Open Docker Desktop on the Mac."
    die "Docker Desktop did not start within 15 minutes"
  fi
  # Docker restarts the beta's containers itself (restart: unless-stopped); give it a minute before judging
  [ "$was_down" = 1 ] && sleep 60
  lock_wait 600 || die "another beta.sh up is still running after 10 minutes"
  missing="$(stack_missing)"
  if [ -z "$missing" ]; then
    say "  every beta container exists (Docker restarted them); the watchdog starts any that are stopped"
    tg_notify "the Mac signed in again (restart or login). Docker restarted the beta; scripts/beta.sh status shows the details."
    return 0
  fi
  say "  missing: $missing → scripts/beta.sh up --no-pull"
  NP_BETA_LOCK_HELD=1 "$deploy/scripts/beta.sh" up --no-pull || rc=$?
  if [ "$rc" != 0 ]; then
    tg_notify "after login, scripts/beta.sh up failed (exit $rc). Log: ~/Library/Logs/NearPay/autostart.log. The watchdog keeps retrying every 15 minutes."
    return "$rc"
  fi
}

launchd_path() { # PATH for the launchd jobs: where node, docker, pnpm and git are now, plus the usual places
  local d out="" c
  for c in node docker pnpm git curl; do
    d="$(dirname "$(command -v "$c" 2>/dev/null || echo /usr/bin/true)")"
    case ":$out:" in *":$d:"*) ;; *) out="${out:+$out:}$d" ;; esac
  done
  for d in /opt/homebrew/bin /usr/local/bin /Applications/Docker.app/Contents/Resources/bin /usr/bin /bin /usr/sbin /sbin; do
    case ":$out:" in *":$d:"*) ;; *) out="${out:+$out:}$d" ;; esac
  done
  printf '%s' "$out"
}

install_autostart() {
  is_macos || die "install-autostart is for the owner's Mac (launchd)"
  step "launchd jobs (start at login, keep awake, watchdog every minute)"
  local uid f label
  uid="$(id -u)"
  mkdir -p "$log_dir"
  while IFS= read -r f; do
    label="$(basename "$f" .plist)"
    launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || true
    plutil -lint "$f" >/dev/null || die "$f is not a valid property list"
    launchctl enable "gui/$uid/$label" 2>/dev/null || true
    launchctl bootstrap "gui/$uid" "$f" || die "launchctl bootstrap $f failed"
    ok "$label → $f"
  done < <(node "$deploy/scripts/lib/launchd.mjs" write "$agents_dir" "$deploy" "$log_dir" "$(launchd_path)")
  say "  logs: $log_dir (watchdog.log, autostart.log)"
  say "  Next: scripts/beta.sh doctor (sleep, power, Docker Desktop and login settings)"
}

uninstall_autostart() {
  is_macos || die "uninstall-autostart is for the owner's Mac (launchd)"
  local uid label
  uid="$(id -u)"
  for label in "${AGENTS[@]}"; do
    launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || true
    rm -f "$agents_dir/$label.plist"
    ok "removed $label"
  done
  say "  The beta keeps running; it no longer starts at login, keeps the Mac awake or heals itself from the host."
}

prom_value() { # instant query → first value, or "none"
  # shellcheck disable=SC2016 # JavaScript
  curl -sS --max-time 5 --get --data-urlencode "query=$1" "http://127.0.0.1:$(envval NP_PROMETHEUS_PORT)/api/v1/query" 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s).data.result;process.stdout.write(r.length?String(r[0].value[1]):"none")}catch{process.stdout.write("none")}})' ||
    printf none
}

uptime_summary() {
  step "Uptime"
  local k t ks code
  if [ -e "$stopped_marker" ]; then warn "the beta was stopped with beta.sh down (autostart, keep-awake and watchdog stand still; beta.sh up starts it)"; fi
  if docker info >/dev/null 2>&1; then ok "Docker Desktop answers"; else bad "Docker Desktop is not answering (open it; the watchdog does too)"; fi
  wd_env
  while IFS=$'\t' read -r k t; do
    case "$k" in ok) ok "$t" ;; warn) warn "$t" ;; *) bad "$t" ;; esac
  done < <(node "$deploy/scripts/lib/watchdog.mjs" summary 2>/dev/null)
  wd_paused && warn "watchdog healing paused until $(date -r "$(cat "$pause_file")" '+%H:%M' 2>/dev/null || cat "$pause_file") (scripts/beta.sh watchdog resume)"
  code="$(http_code https://api.nearpay.money/healthz 1)"
  if [ "$code" = 200 ]; then ok "public: https://api.nearpay.money/healthz → 200"; else bad "public: https://api.nearpay.money/healthz → ${code:-no answer}"; fi
  if ! is_macos; then
    warn "keep-awake and autostart: macOS only"
  else
    if agent_loaded "$keepawake_label" && launchctl print "gui/$(id -u)/$keepawake_label" 2>/dev/null | grep -q 'state = running'; then ok "keep-awake: on (launchd owns caffeinate)"
    elif [ -f "$beta/caffeinate.pid" ] && kill -0 "$(cat "$beta/caffeinate.pid")" 2>/dev/null; then warn "keep-awake: on, but started from a terminal (ends at logout/reboot): scripts/beta.sh install-autostart"
    else bad "keep-awake: OFF (scripts/beta.sh install-autostart, or beta.sh up)"; fi
    local missing_agents=""
    for k in "${AGENTS[@]}"; do agent_loaded "$k" || missing_agents="$missing_agents ${k##*.}"; done
    if [ -z "$missing_agents" ]; then ok "autostart: installed (start at login, keep-awake, watchdog every minute)"
    else bad "autostart: not installed or not loaded:$missing_agents (scripts/beta.sh install-autostart)"; fi
  fi
  ks="$(prom_value 'max(nearpay_sentinel_kill_switch_engaged)')"
  case "$ks" in
    0) ok "kill switch: off" ;;
    1) bad "kill switch: ENGAGED (live payments stopped on purpose; console > Kill switch)" ;;
    *) warn "kill switch: unknown (Prometheus has no value)" ;;
  esac
  routing_check 1 || true
}

# ---- live routing (rails routing health via Prometheus) -------------------------------------------------------------
# Prints ok / FAIL with each blocking reason and its fix (scripts/lib/routing-health.mjs). $1 = tries (15 s apart) while
# the answer is not "ok": right after `up`, rails needs a few seconds to read the kill switch and Prometheus to scrape.
routing_check() {
  local tries="${1:-1}" n=0 out status rc port
  port="$(envval NP_PROMETHEUS_PORT)"
  local url="http://127.0.0.1:${port:-9090}"
  while :; do
    rc=0
    out="$(node "$deploy/scripts/lib/routing-health.mjs" "$url" 2>&1)" || rc=$?
    n=$((n + 1))
    [ "$rc" = 0 ] || [ "$n" -ge "$tries" ] && break
    [ "$n" = 1 ] && printf '  …    waiting for live routing health (%s)\n' "$(printf '%s' "$out" | head -1)"
    sleep 15
  done
  status="$(printf '%s\n' "$out" | head -1)"
  case "$status" in
    ok)
      ok "live payments can route (nearpay_rails_routing_available = 1)"
      printf '%s\n' "$out" | tail -n +2 | while IFS= read -r l; do [ -n "$l" ] && warn "$l"; done
      return 0 ;;
    blocked)
      bad "live payments cannot route: payers see 'Payments are temporarily unavailable'. Blocking reasons and fixes:"
      printf '%s\n' "$out" | tail -n +2 | while IFS= read -r l; do [ -n "$l" ] && printf '         %s\n' "$l"; done
      say "         details: scripts/beta.sh ops rails routing-health live"
      return 1 ;;
    *)
      bad "live routing health unknown: $(printf '%s\n' "$out" | tail -n +2 | head -1) (scripts/beta.sh logs rails-api)"
      return 1 ;;
  esac
}

# ---- smoke ----------------------------------------------------------------------------------------------------------
smoke() {
  local fail=0 h code loc i methods
  step "Public URLs (through Cloudflare)"
  for i in $(seq 1 12); do
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 https://api.nearpay.money/healthz 2>/dev/null || true)"
    [ "$code" = 200 ] && break
    [ "$i" = 1 ] && say "  waiting for https://api.nearpay.money/healthz (DNS and the tunnel can take a minute)…"
    sleep 5
  done
  if [ "$code" = 200 ]; then ok "https://api.nearpay.money/healthz → 200 (identity ready)"
  else bad "https://api.nearpay.money/healthz → ${code:-no answer} (beta.sh logs cloudflared; beta.sh logs identity-api)"; fail=1; fi
  # each URL gets 3 tries with backoff: one dropped request through the tunnel is not a failure
  for h in nearpay.money pay.nearpay.money dashboard.nearpay.money docs.nearpay.money; do
    code="$(http_code "https://$h/" 3)"
    case "$code" in 2* | 3*) ok "https://$h/ → $code" ;; *) bad "https://$h/ → ${code:-no answer}"; fail=1 ;; esac
  done
  code="$(http_code https://js.nearpay.money/v1/nearpay.js 3)"
  if [ "$code" = 200 ]; then ok "https://js.nearpay.money/v1/nearpay.js → 200"; else bad "https://js.nearpay.money/v1/nearpay.js → ${code:-no answer}"; fail=1; fi
  for i in 1 2 3; do
    loc="$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 10 https://www.nearpay.money/x 2>/dev/null || true)"
    [ "$loc" = "301 https://nearpay.money/x" ] && break
    sleep $((i * 3))
  done
  case "$loc" in "301 https://nearpay.money/x") ok "https://www.nearpay.money → https://nearpay.money" ;; *) bad "www redirect: got '$loc'"; fail=1 ;; esac

  # Continue with Google (ADR-0026): the dashboard asks identity whether to show the button
  local want=false
  [ -n "$(envval NP_GOOGLE_CLIENT_ID)" ] && [ -s "$beta/google_client_secret" ] && want=true
  for i in 1 2 3; do
    methods="$(curl -sS --max-time 10 https://dashboard.nearpay.money/api/v1/auth/methods 2>/dev/null || true)"
    case "$methods" in *'"google":'*) break ;; esac
    sleep $((i * 3))
  done
  case "$methods" in
    *"\"google\":$want"*) ok "Continue with Google: $([ "$want" = true ] && echo on || echo off) (GET /v1/auth/methods)" ;;
    *) bad "GET https://dashboard.nearpay.money/api/v1/auth/methods → '${methods:0:120}' (expected google:$want; beta.sh logs identity-api)"; fail=1 ;;
  esac

  step "Cloudflare Access in front of the console"
  for h in "https://ops.nearpay.money/" "https://ops.nearpay.money/api/ops/merchants"; do
    for i in 1 2 3; do
      loc="$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 10 "$h" 2>/dev/null || true)"
      case "$loc" in 30[23]\ https://*.cloudflareaccess.com/* | 401\ * | 403\ *) break ;; esac
      sleep $((i * 3))
    done
    case "$loc" in
      30[23]\ https://*.cloudflareaccess.com/*) ok "$h → Cloudflare Access sign-in" ;;
      401\ * | 403\ *) ok "$h → ${loc%% *} (refused at the edge)" ;;
      *) bad "$h → '$loc': Cloudflare Access is NOT protecting the console (docs/beta-launch.md step 6)"; fail=1 ;;
    esac
  done

  step "Monitoring (this Mac)"
  local pport down tries=0
  pport="$(envval NP_PROMETHEUS_PORT)"
  # Containers recreated by `up` stay "down" until Prometheus's next scrape (30 s interval): retry for up to ~2 min.
  while :; do
  # shellcheck disable=SC2016 # JavaScript template literal
  down="$(curl -sS --max-time 10 "http://127.0.0.1:${pport:-9090}/api/v1/targets?state=active" 2>/dev/null | node -e '
    let s=""; process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{
      try { const t = JSON.parse(s).data.activeTargets;
        const d = t.filter((x) => x.health !== "up").map((x) => x.labels.instance || x.scrapeUrl);
        process.stdout.write(d.length ? d.join(" ") : `ALLUP ${t.length}`); } catch { process.stdout.write("ERROR"); } });' || echo ERROR)"
  case "$down" in ALLUP*) break ;; esac
  tries=$((tries + 1)); [ "$tries" -ge 8 ] && break
  [ "$tries" -eq 1 ] && printf '  …    waiting for Prometheus to scrape restarted services (%s)\n' "$down"
  sleep 15
  done
  case "$down" in
    ALLUP*) ok "Prometheus: all ${down#ALLUP } targets up" ;;
    ERROR) bad "Prometheus does not answer on 127.0.0.1:${pport:-9090}"; fail=1 ;;
    *) bad "Prometheus targets down: $down (still down after 2 min: docker compose -p nearpay-beta ps / logs <service>)"; fail=1 ;;
  esac
  local am_ready=0
  for i in 1 2 3 4; do
    if curl -fsS --max-time 5 "http://127.0.0.1:$(envval NP_ALERTMANAGER_PORT)/-/ready" >/dev/null 2>&1; then am_ready=1; break; fi
    sleep $((i * 3))
  done
  if [ "$am_ready" = 1 ]; then ok "Alertmanager ready"; else bad "Alertmanager not ready (beta.sh logs alertmanager)"; fail=1; fi

  step "Live payments can route (rails routing health)"
  routing_check 6 || fail=1

  step "Internet hosts the services call (compose/egress/allowlist.yaml)"
  local line host port
  while IFS= read -r line; do
    host="$(printf '%s' "$line" | sed -n 's/.*host: \([^,]*\),.*/\1/p')"
    port="$(printf '%s' "$line" | sed -n 's/.*port: \([0-9]*\).*/\1/p')"
    if [ -z "$host" ] || [ -z "$port" ]; then continue; fi
    if bcompose exec -T egress-proxy nc -z -w 5 "$host" "$port" >/dev/null 2>&1 ||
      { sleep 3; bcompose exec -T egress-proxy nc -z -w 5 "$host" "$port" >/dev/null 2>&1; }; then ok "$host:$port"
    else bad "$host:$port unreachable from the stack (firewall/VPN on this Mac?)"; fail=1; fi
  done < <(grep 'beta_smoke: true' "$compose_dir/egress/allowlist.yaml")
  host="$(envval NP_CF_ACCESS_TEAM_DOMAIN)" # identity fetches the Access signing keys from here
  if [ -n "$host" ] && bcompose exec -T egress-proxy nc -z -w 5 "$host" 443 >/dev/null 2>&1; then ok "$host:443 (Access keys)"
  else bad "${host:-NP_CF_ACCESS_TEAM_DOMAIN}:443 unreachable from the stack"; fail=1; fi

  step "Telegram alert channel"
  local chat res=""
  chat="$(envval NP_TELEGRAM_CHAT_ID)"
  for i in 1 2 3; do
  [ "$res" = ok ] && break
  [ "$i" -gt 1 ] && sleep $((i * 3))
  res="$(telegram sendMessage "data = \"chat_id=$chat\"" \
    "data-urlencode = \"text=NearPay beta: smoke test from $(hostname -s) at $(date -u '+%Y-%m-%d %H:%M UTC'). Alerts arrive in this chat.\"" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j.ok?"ok":String(j.description))}catch{process.stdout.write("no answer")}})' || true)"
  done
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
    lock_wait 120 || die "another beta.sh up or watchdog round is running (pid $(cat "$lock_dir/pid" 2>/dev/null)); try again in a minute"
    rm -f "$stopped_marker" # the owner wants the beta running: autostart, keep-awake and the watchdog resume
    preflight_machine
    preflight_repos "$pull"
    preflight_secrets
    preflight_telegram
    preflight_access
    preflight_live
    preflight_config
    step "Keep this Mac awake"
    keep_awake
    step "Build and start (scripts/up.sh beta; the first run takes a while)"
    # Recreated containers miss a scrape or two: silence the availability alerts (only those) until the smoke test is
    # done (expired on exit; 30 min at most). A first start has no Alertmanager yet: nothing to silence.
    silence_id="$(node "$deploy/scripts/lib/alertmanager-silence.mjs" create "http://127.0.0.1:$(envval NP_ALERTMANAGER_PORT)" 30 \
      "scripts/beta.sh up on $(hostname -s)" 2>/dev/null || true)"
    [ -n "$silence_id" ] && say "  availability alerts silenced during the deploy (Alertmanager silence $silence_id)"
    "$deploy/scripts/up.sh" beta
    # Prometheus and Alertmanager read their files at start; Compose does not recreate them when only a mounted file
    # changed (new rules, scrape jobs, Telegram chat): reload both (SIGHUP; no restart, no gap in alerting).
    bcompose kill -s SIGHUP prometheus alertmanager >/dev/null 2>&1 || warn "could not reload Prometheus/Alertmanager (beta.sh logs prometheus)"
    record_expected
    smoke || die "the beta is running but the smoke test failed; fix the FAIL lines and run: scripts/beta.sh smoke"
    say ""
    say "Grafana: http://127.0.0.1:$(envval NP_GRAFANA_PORT)  (user admin, password in .secrets/beta/grafana_admin_password)"
    say "Next: docs/beta-launch.md step 14 (operators, live setup)."
    if is_macos && ! agent_loaded money.nearpay.beta.watchdog; then
      say "Uptime: run 'scripts/beta.sh install-autostart' once, then 'scripts/beta.sh doctor' (docs/beta-launch.md 'Uptime')."
    fi
    ;;
  down)
    # the marker first: autostart, keep-awake and the watchdog must not bring the beta back
    mkdir -p "$beta" && touch "$stopped_marker"
    lock_wait 120 || warn "a beta.sh up / watchdog round is still running; stopping anyway"
    "$deploy/scripts/down.sh" beta
    if agent_loaded "$keepawake_label"; then launchctl kill SIGTERM "gui/$(id -u)/$keepawake_label" 2>/dev/null || true; fi
    if [ -f "$beta/caffeinate.pid" ]; then kill "$(cat "$beta/caffeinate.pid")" 2>/dev/null || true; rm -f "$beta/caffeinate.pid"; fi
    say "beta stopped (data kept; 'scripts/beta.sh up' starts it again; autostart and the watchdog stay off until then)"
    ;;
  status)
    uptime_summary
    step "Containers"
    bcompose ps -a --format 'table {{.Service}}\t{{.Status}}'
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
  doctor)
    step "This Mac keeps the beta running on its own (docs/beta-launch.md 'Uptime')"
    doctor_rc=0
    while IFS=$'\t' read -r k t fix; do
      case "$k" in
        rc) doctor_rc="$t"; continue ;;
        ok) ok "$t" ;;
        warn) warn "$t" ;;
        *) bad "$t" ;;
      esac
      if [ -n "${fix:-}" ]; then printf '         %s\n' "$fix"; fi
    done < <(rc=0; node "$deploy/scripts/lib/doctor.mjs" "$deploy" || rc=$?; printf 'rc\t%s\n' "$rc")
    if [ -f "$beta/healthchecks_url" ]; then ok "dead-man's switch: the watchdog pings Healthchecks.io every round"
    else warn "no dead-man's switch (optional, free: docs/beta-launch.md 'Uptime', Healthchecks.io)"; fi
    uptime_summary || true
    exit "$doctor_rc"
    ;;
  install-autostart) install_autostart ;;
  uninstall-autostart) uninstall_autostart ;;
  autostart) autostart ;;
  watchdog)
    case "${1:-run}" in
      run) watchdog_round ;;
      pause)
        mins="${2:-60}"
        printf '%s' "$mins" | grep -Eq '^[0-9]+$' || die "usage: beta.sh watchdog pause [minutes]"
        mkdir -p "$beta" && echo $(($(date +%s) + mins * 60)) >"$pause_file"
        say "watchdog healing paused for $mins min (it still checks and alerts); resume: scripts/beta.sh watchdog resume" ;;
      resume) rm -f "$pause_file"; say "watchdog healing resumed" ;;
      log) tail -n 50 "$log_dir/watchdog.log" 2>/dev/null || say "no watchdog log yet ($log_dir/watchdog.log)" ;;
      *) die "usage: beta.sh watchdog [run|pause [minutes]|resume|log]" ;;
    esac
    ;;
  routing)
    step "Live payments can route (rails routing health)"
    routing_check 1 || { say ""; say "Runbook: docs/beta-launch.md 'Payments are temporarily unavailable'"; exit 1; }
    ;;
  telegram)
    preflight_telegram rediscover
    smoke_chat="$(envval NP_TELEGRAM_CHAT_ID)"
    telegram sendMessage "data = \"chat_id=$smoke_chat\"" "data-urlencode = \"text=NearPay beta: this chat now receives alerts.\"" >/dev/null
    say "test message sent; run 'scripts/beta.sh up' (or restart Alertmanager) to apply the chat"
    ;;
  ops)
    [ $# -ge 2 ] || die "usage: beta.sh ops <identity|compliance|payments|…> <command…> (e.g. ops compliance kyb-decide <acct_…> approved --reason …)"
    svc="$1"
    shift
    bcompose exec "$svc-api" /nodejs/bin/node dist/ops.js "$@"
    ;;
  -h | --help | "") sed -n '2,19p' "$0" ;;
  *) die "unknown command '$cmd' (beta.sh --help)" ;;
esac
