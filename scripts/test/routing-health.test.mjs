// scripts/lib/routing-health.mjs (beta smoke "Live payments can route") and its alert rule/runbook counterparts.
//   node --test scripts/test/
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { FIX, QUERIES, readRouting, verdict } from "../lib/routing-health.mjs";

const deploy = join(dirname(fileURLToPath(import.meta.url)), "../..");
const script = join(deploy, "scripts/lib/routing-health.mjs");
const RAILS_REASONS = [
  "kill_switch_engaged",
  "kill_switch_unknown",
  "treasury_unset",
  "cross_chain_paused",
  "settlement_price_stale",
  "settlement_price_missing",
  "settlement_price_depeg",
  "settlement_price_disagree",
  "fx_unavailable",
  "token_registry_stale",
];

/** A fake Prometheus answering the three instant queries. */
async function fakePrometheus({ available, reasons = [], age = 12 }) {
  const vec = (metric, v) => ({ metric, value: [1_762_000_000, String(v)] });
  const server = createServer((req, res) => {
    const q = new URL(req.url, "http://x").searchParams.get("query");
    let result = [];
    if (q === QUERIES.available) result = available === null ? [] : [vec({}, available)];
    else if (q === QUERIES.blocked) result = reasons.map((reason) => vec({ reason }, 1));
    else if (q === QUERIES.registryAge) result = age === null ? [] : [vec({}, age)];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "success", data: { resultType: "vector", result } }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

const run = (url) =>
  promisify(execFile)(process.execPath, [script, url]).then(
    (r) => ({ code: 0, out: r.stdout }),
    (e) => ({ code: e.code, out: e.stdout }),
  );

test("a fix for every rails routing reason", () => {
  assert.deepEqual(Object.keys(FIX).sort(), [...RAILS_REASONS].sort());
});

test("verdict: ok, blocked with a fix per reason, no data", () => {
  assert.deepEqual(verdict({ available: 1, reasons: [], registryAgeS: 10 }), { status: "ok", lines: [] });
  assert.match(verdict({ available: 1, reasons: [], registryAgeS: 900 }).lines[0], /^warning token_registry_stale/);
  const b = verdict({ available: 0, reasons: ["kill_switch_engaged", "treasury_unset"], registryAgeS: 10 });
  assert.equal(b.status, "blocked");
  assert.match(b.lines[0], /^kill_switch_engaged: .*console/);
  assert.match(b.lines[1], /^treasury_unset: .*NP_TREASURY_ACCOUNT/);
  const stale = verdict({ available: 0, reasons: ["settlement_price_stale"], registryAgeS: Number.POSITIVE_INFINITY });
  assert.match(stale.lines[1], /^token_registry_stale \(registry never refreshed\)/);
  assert.match(verdict({ available: 0, reasons: [], registryAgeS: null }).lines[0], /^unknown: /);
  assert.equal(verdict({ available: null, reasons: [], registryAgeS: null }).status, "no_data");
});

test("reads the gauges from Prometheus (+Inf registry age)", async () => {
  const p = await fakePrometheus({ available: 0, reasons: ["treasury_unset", "cross_chain_paused"], age: "+Inf" });
  try {
    assert.deepEqual(await readRouting(p.url), {
      available: 0,
      reasons: ["cross_chain_paused", "treasury_unset"],
      registryAgeS: Number.POSITIVE_INFINITY,
    });
  } finally {
    await p.close();
  }
});

test("CLI exit codes: 0 routes, 1 blocked (reasons + fixes), 3 no data / Prometheus down", async () => {
  for (const [state, code, first] of [
    [{ available: 1 }, 0, "ok"],
    [{ available: 0, reasons: ["cross_chain_paused"] }, 1, "blocked"],
    [{ available: null }, 3, "no_data"],
  ]) {
    const p = await fakePrometheus(state);
    try {
      const r = await run(p.url);
      assert.equal(r.code, code);
      assert.equal(r.out.split("\n")[0], first);
      if (code === 1) assert.match(r.out, /cross_chain_paused: .*flag-set cross_chain_enabled true/);
    } finally {
      await p.close();
    }
  }
  const down = await run("http://127.0.0.1:9");
  assert.equal(down.code, 3);
});

test("the alert rules and the runbook cover every reason", () => {
  const rules = readFileSync(join(deploy, "compose/monitoring/prometheus/rules/nearpay.yml"), "utf8");
  assert.match(rules, /alert: LivePaymentsNotRouting\n\s+expr: max\(nearpay_rails_routing_available\{livemode="true"\}\) == 0\n\s+for: 2m\n\s+labels: \{ severity: critical \}/);
  assert.match(rules, /alert: TokenRegistryStale\n\s+expr: max by \(livemode\) \(nearpay_rails_token_registry_age_seconds\) > 300\n\s+for: 2m/);
  const runbook = readFileSync(join(deploy, "docs/beta-launch.md"), "utf8");
  for (const r of RAILS_REASONS) {
    if (r !== "token_registry_stale") assert.ok(rules.includes(`"${r}"`), `nearpay.yml has no fix for ${r}`);
    assert.ok(runbook.includes(`\`${r}\``), `docs/beta-launch.md has no entry for ${r}`);
  }
});

test("integrity containment alerts (ADR-0028): breach and quarantine are warnings, the kill switch stays critical", () => {
  const rules = readFileSync(join(deploy, "compose/monitoring/prometheus/rules/nearpay.yml"), "utf8");
  assert.match(rules, /alert: KillSwitchEngaged\n\s+expr: max\(nearpay_sentinel_kill_switch_engaged\) == 1\n\s+labels: \{ severity: critical \}/);
  assert.match(
    rules,
    /alert: IntegrityBreachRefused\n\s+expr: sum by \(rule\) \(increase\(nearpay_sentinel_integrity_refusals_total\{address="genuine", evidence="pipeline"\}\[15m\]\)\) > 0\n\s+labels: \{ severity: warning \}/,
  );
  assert.match(rules, /alert: AccountQuarantined\n\s+expr: max\(nearpay_sentinel_quarantines_active\) > 0\n\s+labels: \{ severity: warning \}/);
  const runbook = readFileSync(join(deploy, "docs/beta-launch.md"), "utf8");
  for (const a of ["KillSwitchEngaged", "IntegrityBreachRefused", "AccountQuarantined"]) assert.ok(runbook.includes(`| ${a}`), a);
  assert.ok(runbook.includes("quarantine-clear"));
});

test("critical and warning alerts reach the owner's Telegram receiver", () => {
  const am = readFileSync(join(deploy, "compose/monitoring/alertmanager/alertmanager.yml.tmpl"), "utf8");
  assert.match(am, /^route:\n {2}receiver: owner-telegram\n/m);
  assert.match(am, /- matchers: \[severity="warning"\]\n\s+receiver: owner-telegram\n/);
  assert.doesNotMatch(am, /LivePaymentsNotRouting|TokenRegistryStale/); // not routed or inhibited elsewhere
});
