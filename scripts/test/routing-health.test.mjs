// scripts/lib/routing-health.mjs (beta smoke "Live payments can route") and its alert rule/runbook counterparts.
//   node --test scripts/test/
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  FIX,
  MISSED_RELEASE_STEPS,
  QUERIES,
  RELEASE_STEPS,
  killSwitchFromOps,
  killSwitchLines,
  mergeKillSwitch,
  readRouting,
  verdict,
} from "../lib/routing-health.mjs";

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

/** A fake Prometheus answering the instant queries (unknown queries: empty vector). */
async function fakePrometheus({ available, reasons = [], age = 12, ks = {} }) {
  const vec = (metric, v) => ({ metric, value: [1_762_000_000, String(v)] });
  const server = createServer((req, res) => {
    const q = new URL(req.url, "http://x").searchParams.get("query");
    let result = [];
    if (q === QUERIES.available) result = available === null ? [] : [vec({}, available)];
    else if (q === QUERIES.blocked) result = reasons.map((reason) => vec({ reason }, 1));
    else if (q === QUERIES.registryAge) result = age === null ? [] : [vec({}, age)];
    else if (q === QUERIES.sentinelEngaged && ks.engaged !== undefined) result = [vec({}, ks.engaged)];
    else if (q === QUERIES.sentinelVersion && ks.sentinel !== undefined) result = [vec({}, ks.sentinel)];
    else if (q === QUERIES.railsVersion && ks.rails !== undefined) result = [vec({}, ks.rails)];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "success", data: { resultType: "vector", result } }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

const run = (url, ...extra) =>
  promisify(execFile)(process.execPath, [script, url, ...extra]).then(
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
      killSwitch: { sentinelEngaged: null, sentinelVersion: null, railsVersion: null },
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

test("kill switch engaged: versions, then the single-operator release walkthrough (never the CLI release)", () => {
  const v = verdict({
    available: 0,
    reasons: ["kill_switch_engaged"],
    registryAgeS: 5,
    killSwitch: { sentinelEngaged: 1, sentinelVersion: 7, railsVersion: 7 },
  });
  assert.equal(v.lines[0].split(":")[0], "kill_switch_engaged");
  assert.equal(v.lines[1], "kill switch: sentinel engaged (version 7); rails' copy engaged (version 7)");
  assert.deepEqual(v.lines.slice(2), RELEASE_STEPS);
  const text = RELEASE_STEPS.join("\n");
  assert.match(text, /Request release/);
  assert.match(text, /wait 5 minutes/);
  assert.match(text, /log in to Cloudflare Access again/);
  assert.match(text, /at least 20 characters/);
  assert.match(text, /ops rails flags shows quoting_enabled true and source_version/);
  assert.match(text, /ops sentinel quarantines is empty/);
  assert.doesNotMatch(text, /kill-switch-release/); // refused on the server (two_person_required)
  // unknown versions: says where to read them
  assert.match(killSwitchLines({}).join("\n"), /state unknown \(version unknown\).*\n.*ops sentinel kill-switch and ops rails flags/);
});

test("kill switch: sentinel released but rails still engaged = missed release, not 'release again'", () => {
  const v = verdict({
    available: 0,
    reasons: ["kill_switch_engaged"],
    registryAgeS: 5,
    killSwitch: { sentinelEngaged: false, sentinelVersion: 8, railsVersion: 7 },
  });
  assert.equal(v.lines[1], "kill switch: sentinel released (version 8); rails' copy engaged (version 7)");
  assert.deepEqual(v.lines.slice(2), MISSED_RELEASE_STEPS);
  assert.match(MISSED_RELEASE_STEPS.join("\n"), /flag-set quoting_enabled true .*keeps source_version/);
  assert.doesNotMatch(MISSED_RELEASE_STEPS.join("\n"), /Request release|kill-switch-release/);
  // other reasons: no kill-switch lines
  assert.deepEqual(verdict({ available: 0, reasons: ["treasury_unset"], registryAgeS: 5 }).lines.length, 1);
});

test("kill switch facts from the ops CLIs win over Prometheus", () => {
  const sentinel = JSON.stringify({ engaged: false, version: 12, reason: "x", actor: "ops", log: [] }, null, 2);
  const rails = JSON.stringify([
    { name: "cross_chain_enabled", value: true, source_version: null },
    { name: "quoting_enabled", value: false, source_version: "11", known: true },
  ]);
  const ops = killSwitchFromOps(sentinel, rails);
  assert.deepEqual(ops, { sentinelEngaged: false, sentinelVersion: 12, railsVersion: 11 });
  assert.deepEqual(killSwitchFromOps("not json", ""), { sentinelEngaged: null, sentinelVersion: null, railsVersion: null });
  assert.deepEqual(mergeKillSwitch({ sentinelEngaged: 1, sentinelVersion: null, railsVersion: 11 }, { sentinelEngaged: false, sentinelVersion: 12, railsVersion: null }), {
    sentinelEngaged: false,
    sentinelVersion: 12,
    railsVersion: 11,
  });
});

test("CLI: kill-switch versions from Prometheus, overridden by --ops-* files", async () => {
  const p = await fakePrometheus({ available: 0, reasons: ["kill_switch_engaged"], ks: { engaged: 1, sentinel: 4, rails: 4 } });
  const dir = mkdtempSync(join(tmpdir(), "rh-"));
  try {
    let r = await run(p.url);
    assert.equal(r.code, 1);
    assert.match(r.out, /kill switch: sentinel engaged \(version 4\); rails' copy engaged \(version 4\)/);
    assert.match(r.out, /Request release/);
    writeFileSync(join(dir, "s.json"), JSON.stringify({ engaged: false, version: 5 }));
    writeFileSync(join(dir, "r.json"), JSON.stringify([{ name: "quoting_enabled", value: false, source_version: 4 }]));
    r = await run(p.url, "--ops-sentinel", join(dir, "s.json"), "--ops-rails", join(dir, "r.json"));
    assert.match(r.out, /kill switch: sentinel released \(version 5\); rails' copy engaged \(version 4\)/);
    assert.match(r.out, /rails missed sentinel's release event/);
  } finally {
    await p.close();
    rmSync(dir, { recursive: true, force: true });
  }
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
