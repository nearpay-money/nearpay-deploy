#!/usr/bin/env node
// Can live payments route right now? Reads rails' routing-health gauges from Prometheus and prints the blocking
// reasons with a one-line fix each (scripts/beta.sh smoke and `scripts/beta.sh routing`; docs/beta-launch.md
// "Payments are temporarily unavailable").
//
//   node scripts/lib/routing-health.mjs [<prometheus url>] [--ops-sentinel <file>] [--ops-rails <file>]
//
// Exit 0: live payments route. 1: blocked (reasons printed). 3: no data yet (rails-api not scraped / Prometheus down).
//
// Gauges (nearpay-rails app/routing-health.ts): nearpay_rails_routing_available{livemode} (0/1),
// nearpay_rails_routing_blocked{livemode,reason} (1 per blocking reason), nearpay_rails_token_registry_age_seconds.
//
// When the kill switch blocks live routing it also prints sentinel's state and version next to rails' copy, then
// either the single-operator release walkthrough (sentinel engaged) or "rails missed the release" (sentinel released,
// rails' copy still engaged; audit 2026-11-12 RAILS-1). Versions come from `beta.sh ops sentinel kill-switch` /
// `beta.sh ops rails flags` output (--ops-* files, written by `scripts/beta.sh routing`) or else from Prometheus:
// nearpay_sentinel_kill_switch_engaged, and nearpay_sentinel_kill_switch_version / nearpay_rails_kill_switch_version
// (or …_source_version), which newer sentinel/rails images export.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** One-line fix per rails routing reason (keep in step with nearpay.yml LivePaymentsNotRouting and the runbook). */
export const FIX = {
  kill_switch_engaged:
    "the kill switch is engaged: find out why (scripts/beta.sh ops sentinel kill-switch), then release it in the console (ops.nearpay.money > Kill switch; steps below)",
  kill_switch_unknown:
    "rails cannot read sentinel's kill switch: scripts/beta.sh logs rails-api | grep 'ALERT kill_switch_unknown' (cause: auth, network or NP_SENTINEL_URL unset); check sentinel-api is up",
  treasury_unset:
    "the live fee recipient is not set: put NP_TREASURY_ACCOUNT in compose/env/local.env (mainnet checklist C.1) and run scripts/beta.sh up",
  cross_chain_paused:
    "cross-chain routes are paused: scripts/beta.sh ops rails flag-set cross_chain_enabled true 'resume after <why>'",
  settlement_price_stale:
    "1Click prices are not reaching rails: scripts/beta.sh logs rails-feeds | grep 'ALERT token_registry_refresh_failed'; scripts/beta.sh logs egress-proxy",
  settlement_price_missing:
    "a price source lacks the settlement asset: scripts/beta.sh logs rails-feeds (1Click token list, CoinGecko secondary-prices)",
  settlement_price_depeg:
    "the settlement stablecoin is off its peg (more than 2 %): nothing to fix in NearPay; wait, or settle in another asset",
  settlement_price_disagree:
    "1Click and CoinGecko disagree by more than 1.5 %: scripts/beta.sh logs rails-feeds; it usually clears by itself",
  fx_unavailable:
    "no current ECB FX rate for the peg currency: scripts/beta.sh logs rails-feeds | grep -i fx; check the egress proxy reaches www.ecb.europa.eu",
  token_registry_stale:
    "the token registry is not refreshing: scripts/beta.sh logs rails-feeds | grep 'ALERT token_registry_refresh_failed'; scripts/beta.sh logs egress-proxy",
};

export const QUERIES = {
  available: 'max(nearpay_rails_routing_available{livemode="true"})',
  blocked: 'max by (reason) (nearpay_rails_routing_blocked{livemode="true"}) == 1',
  registryAge: 'max(nearpay_rails_token_registry_age_seconds{livemode="true"})',
  sentinelEngaged: "max(nearpay_sentinel_kill_switch_engaged)",
  sentinelVersion: "max(nearpay_sentinel_kill_switch_version)",
  railsVersion: 'max({__name__=~"nearpay_rails_kill_switch_(source_)?version"})',
};

/** The single-operator release in the console (sentinel two-person.ts: 5 min delay, step-up, reason >= 20 chars). */
export const RELEASE_STEPS = [
  "release it (you are the only operator; about 6 minutes):",
  "  1. scripts/beta.sh ops sentinel kill-switch: who engaged it and why. Actor sentinel (\"systemic integrity breach\") = integrity refusals across merchants: read scripts/beta.sh ops sentinel integrity-breaches and fix the cause first",
  "  2. console (ops.nearpay.money) > Kill switch > Request release, with a reason",
  "  3. wait 5 minutes (the single-operator delay)",
  "  4. Approve release: log in to Cloudflare Access again when asked, and write a reason of at least 20 characters",
  "  5. check within a minute: scripts/beta.sh ops rails flags shows quoting_enabled true and source_version equal to sentinel's new version; scripts/beta.sh ops sentinel quarantines is empty; scripts/beta.sh routing says ok",
];

/** Sentinel released but rails' copy is still engaged: the release event never reached rails. */
export const MISSED_RELEASE_STEPS = [
  "rails missed sentinel's release event (stopped consumer, dead letter, lost NATS state): releasing again does not help",
  "  1. wait a minute and run scripts/beta.sh routing again (rails with the periodic re-sync re-reads sentinel every 60 s)",
  "  2. still engaged: scripts/beta.sh logs rails-feeds | grep -i -E 'consumer|kill.switch' (a stopped consumer fires ConsumerLagHigh, a dead-lettered event DeadLetters); a restart (docker restart nearpay-beta-rails-feeds-1) lets a stopped consumer pick up a pending event",
  "  3. emergency override: scripts/beta.sh ops rails flag-set quoting_enabled true '<reason>'. It changes only the value and keeps source_version, so the next kill-switch event from sentinel still wins",
];

const fmtVersion = (v) => (v === null || v === undefined ? "version unknown" : `version ${v}`);

/** Kill-switch lines when kill_switch_engaged blocks routing. ks: { sentinelEngaged, sentinelVersion, railsVersion }. */
export function killSwitchLines(ks = {}) {
  const st = ks.sentinelEngaged === true || ks.sentinelEngaged === 1 ? "engaged" : ks.sentinelEngaged === false || ks.sentinelEngaged === 0 ? "released" : "state unknown";
  const lines = [`kill switch: sentinel ${st} (${fmtVersion(ks.sentinelVersion)}); rails' copy engaged (${fmtVersion(ks.railsVersion)})`];
  if (ks.sentinelVersion == null || ks.railsVersion == null)
    lines.push("  (versions: scripts/beta.sh routing reads them with ops sentinel kill-switch and ops rails flags)");
  if (st === "released") lines.push(...MISSED_RELEASE_STEPS);
  else lines.push(...RELEASE_STEPS);
  return lines;
}

/** `ops sentinel kill-switch` and `ops rails flags` JSON → the kill-switch facts (null fields when unreadable). */
export function killSwitchFromOps(sentinelText, railsText) {
  const parse = (t) => {
    try {
      return t ? JSON.parse(t) : null;
    } catch {
      return null;
    }
  };
  const s = parse(sentinelText);
  const flags = parse(railsText);
  const q = Array.isArray(flags) ? flags.find((f) => f?.name === "quoting_enabled") : null;
  const n = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    sentinelEngaged: typeof s?.engaged === "boolean" ? s.engaged : null,
    sentinelVersion: n(s?.version),
    railsVersion: n(q?.source_version),
  };
}

/** Prometheus instant-query results → the verdict and the lines to print. */
export function verdict({ available, reasons, registryAgeS, killSwitch }) {
  if (available === null || available === undefined)
    return {
      status: "no_data",
      lines: [
        "no routing-health data from rails yet (rails-api not scraped, or an older rails image without nearpay_rails_routing_available)",
      ],
    };
  const lines = [];
  const stale = registryAgeS !== null && registryAgeS !== undefined && !(registryAgeS <= 300);
  if (available >= 1) {
    if (stale) lines.push(`warning token_registry_stale: ${FIX.token_registry_stale}`);
    return { status: "ok", lines };
  }
  const list = reasons.length ? reasons : ["unknown"];
  for (const r of list) lines.push(`${r}: ${FIX[r] ?? "see scripts/beta.sh ops rails routing-health live"}`);
  if (stale && !list.includes("token_registry_stale"))
    lines.push(
      `token_registry_stale (registry ${Number.isFinite(registryAgeS) ? `${Math.round(registryAgeS)} s old` : "never refreshed"}): ${FIX.token_registry_stale}`,
    );
  if (list.includes("kill_switch_engaged")) lines.push(...killSwitchLines(killSwitch));
  return { status: "blocked", reasons: list, lines };
}

async function query(base, q, fetchImpl) {
  const res = await fetchImpl(`${base}/api/v1/query?query=${encodeURIComponent(q)}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Prometheus answered ${res.status}`);
  const body = await res.json();
  if (body.status !== "success") throw new Error(`Prometheus: ${body.error ?? "query failed"}`);
  return body.data.result;
}

const num = (v) => (v === "+Inf" ? Number.POSITIVE_INFINITY : Number(v));

/** Reads the gauges from Prometheus at `base`. */
export async function readRouting(base, fetchImpl = fetch) {
  const [a, b, g, se, sv, rv] = await Promise.all([
    query(base, QUERIES.available, fetchImpl),
    query(base, QUERIES.blocked, fetchImpl),
    query(base, QUERIES.registryAge, fetchImpl),
    ...[QUERIES.sentinelEngaged, QUERIES.sentinelVersion, QUERIES.railsVersion].map((q) =>
      query(base, q, fetchImpl).catch(() => []),
    ),
  ]);
  const first = (r) => (r.length ? num(r[0].value[1]) : null);
  return {
    available: first(a),
    reasons: b.map((x) => x.metric.reason).sort(),
    registryAgeS: first(g),
    killSwitch: { sentinelEngaged: first(se), sentinelVersion: first(sv), railsVersion: first(rv) },
  };
}

/** Facts from the ops CLIs win over Prometheus, field by field. */
export function mergeKillSwitch(prom = {}, ops = {}) {
  const out = { ...prom };
  for (const [k, v] of Object.entries(ops)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { "ops-sentinel": { type: "string" }, "ops-rails": { type: "string" } },
  });
  const base = (positionals[0] ?? "http://127.0.0.1:9090").replace(/\/$/, "");
  const readOpt = (f) => {
    try {
      return f ? readFileSync(f, "utf8") : "";
    } catch {
      return "";
    }
  };
  const ops = killSwitchFromOps(readOpt(values["ops-sentinel"]), readOpt(values["ops-rails"]));
  let v;
  try {
    const r = await readRouting(base);
    v = verdict({ ...r, killSwitch: mergeKillSwitch(r.killSwitch, ops) });
  } catch (e) {
    v = { status: "no_data", lines: [`Prometheus at ${base} did not answer: ${e instanceof Error ? e.message : e}`] };
  }
  process.stdout.write(`${v.status}\n${v.lines.join("\n")}${v.lines.length ? "\n" : ""}`);
  process.exit(v.status === "ok" ? 0 : v.status === "blocked" ? 1 : 3);
}
