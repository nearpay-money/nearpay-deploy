#!/usr/bin/env node
// Can live payments route right now? Reads rails' routing-health gauges from Prometheus and prints the blocking
// reasons with a one-line fix each (scripts/beta.sh smoke and `scripts/beta.sh routing`; docs/beta-launch.md
// "Payments are temporarily unavailable").
//
//   node scripts/lib/routing-health.mjs [<prometheus url>]     default http://127.0.0.1:9090
//
// Exit 0: live payments route. 1: blocked (reasons printed). 3: no data yet (rails-api not scraped / Prometheus down).
//
// Gauges (nearpay-rails app/routing-health.ts): nearpay_rails_routing_available{livemode} (0/1),
// nearpay_rails_routing_blocked{livemode,reason} (1 per blocking reason), nearpay_rails_token_registry_age_seconds.
import { pathToFileURL } from "node:url";

/** One-line fix per rails routing reason (keep in step with nearpay.yml LivePaymentsNotRouting and the runbook). */
export const FIX = {
  kill_switch_engaged:
    "the kill switch is engaged: find out why (scripts/beta.sh logs sentinel-api), then release it in the console (ops.nearpay.money > Kill switch)",
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
};

/** Prometheus instant-query results → the verdict and the lines to print. */
export function verdict({ available, reasons, registryAgeS }) {
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
  const [a, b, g] = await Promise.all([
    query(base, QUERIES.available, fetchImpl),
    query(base, QUERIES.blocked, fetchImpl),
    query(base, QUERIES.registryAge, fetchImpl),
  ]);
  return {
    available: a.length ? num(a[0].value[1]) : null,
    reasons: b.map((x) => x.metric.reason).sort(),
    registryAgeS: g.length ? num(g[0].value[1]) : null,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const base = (process.argv[2] ?? "http://127.0.0.1:9090").replace(/\/$/, "");
  let v;
  try {
    v = verdict(await readRouting(base));
  } catch (e) {
    v = { status: "no_data", lines: [`Prometheus at ${base} did not answer: ${e instanceof Error ? e.message : e}`] };
  }
  process.stdout.write(`${v.status}\n${v.lines.join("\n")}${v.lines.length ? "\n" : ""}`);
  process.exit(v.status === "ok" ? 0 : v.status === "blocked" ? 1 : 3);
}
