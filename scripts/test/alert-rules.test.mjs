// Resilience alerts (audit 2026-11-12 DEPLOY-1..4): rule shape, runbook coverage, and the promtool rule unit tests
// (scripts/test/promtool/*.test.yml) when promtool is available ($PROMTOOL, or promtool on PATH; CI downloads 3.5.3,
// the version of the beta's Prometheus image).
//   node --test scripts/test/
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const deploy = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(join(deploy, p), "utf8");
const RULES = "compose/monitoring/prometheus/rules/nearpay.yml";

const RESILIENCE = {
  AttestationsFailing: "critical",
  KillSwitchCopyDiverged: "critical",
  IntegrityDriftSuspected: "critical",
  FeeConfigSkew: "critical",
  TrackerLagging: "warning",
  OneClickKeyExpiring: "warning",
  ConsumerLagHigh: "critical",
  HttpBreakerOpen: "critical",
};

/** The rule block of one alert (up to the next rule or group). */
function block(rules, name) {
  const start = rules.indexOf(`- alert: ${name}\n`);
  assert.ok(start >= 0, `${name} is not an alert rule`);
  const rest = rules.slice(start + 1);
  const end = rest.search(/\n {6}(?:#|- alert:)|\n {2}- name:/);
  return rest.slice(0, end < 0 ? undefined : end);
}

test("resilience alerts: severity, summary, description and a runbook hint each; covered by the runbook", () => {
  const rules = read(RULES);
  const runbook = read("docs/beta-launch.md");
  for (const [name, severity] of Object.entries(RESILIENCE)) {
    const b = block(rules, name);
    assert.match(b, new RegExp(`labels: \\{ severity: ${severity} \\}`), `${name} severity`);
    for (const a of ["summary", "description", "runbook"]) assert.match(b, new RegExp(`\\n\\s+${a}: `), `${name} ${a}`);
    assert.ok(runbook.includes(`| ${name}`), `docs/beta-launch.md "When an alert fires" has no row for ${name}`);
  }
});

test("resilience alerts: expressions on the audited metrics; assumed metrics only as extra arms", () => {
  const rules = read(RULES);
  const expr = (n) => block(rules, n).split(/\n\s+labels:/)[0];
  assert.match(expr("AttestationsFailing"), /nearpay_sentinel_attestations_total\{result="unavailable"\}\[10m\]\)\) >= 3\n\s+unless on\(\) sum\(increase\(nearpay_sentinel_attestations_total\{result="signed", reason="ok"\}/);
  assert.match(expr("KillSwitchCopyDiverged"), /max\(nearpay_sentinel_kill_switch_engaged\) == 0\n\s+and on\(\) max\(nearpay_rails_routing_blocked\{livemode="true", reason="kill_switch_engaged"\}\) == 1/);
  assert.match(expr("KillSwitchCopyDiverged"), /max by \(service\) \(\{__name__=~"nearpay_\(rails\|payments\)_kill_switch_diverged"\}\) == 1/);
  assert.match(block(rules, "KillSwitchCopyDiverged"), /for: 3m/);
  assert.match(expr("TrackerLagging"), /max by \(tracker\) \(nearpay_rails_tracker_lag_blocks\) > 200\n\s+for: 10m/);
  assert.match(expr("ConsumerLagHigh"), /nearpay_\.\+_consumer_lag_messages"\}\) > 0/);
  assert.match(expr("HttpBreakerOpen"), /nearpay_\.\+_http_breaker_open/);
  assert.match(expr("HttpBreakerOpen"), /nearpay_\.\+_external_calls_total", outcome="breaker_open"/);
  assert.match(expr("OneClickKeyExpiring"), /oneclick_key_expiry_seconds"\}\) - time\(\) < 7 \* 86400/);
  assert.match(expr("IntegrityDriftSuspected"), /sum by \(source, rules\) \(increase\(nearpay_sentinel_integrity_drift_total\[15m\]\)\) > 0/);
  assert.match(expr("FeeConfigSkew"), /count\(count by \(hash\) \(\{__name__=~"nearpay_\(sentinel\|rails\)_fee_config_info"\} == 1\)\) > 1/);
  // absent() only to gate the drift fallback to older sentinels; a metric an older image lacks must never page by itself
  for (const n of Object.keys(RESILIENCE)) {
    if (n === "IntegrityDriftSuspected") assert.match(expr(n), /absent\(nearpay_sentinel_integrity_drift_total\)\n\s+and on\(\)/);
    else assert.doesNotMatch(expr(n), /absent\(/, n);
  }
  // a metric no branch exports yet is marked, so it can be reconciled
  const comments = rules.match(/(?:^[ \t]*#.*\n)+/gm) ?? []; // runs of consecutive comment lines
  assert.ok(comments.some((c) => c.includes("fee_config_info") && c.includes("ASSUMED NAME")), "rails fee_config_info is not marked ASSUMED NAME");
});

test("kill-switch hints: the console release with its single-operator steps, never the CLI release", () => {
  const rules = read(RULES);
  assert.match(block(rules, "KillSwitchEngaged"), /Request release, wait 5 min, Approve release \(new Access login, reason of 20\+ characters\)/);
  assert.match(block(rules, "LivePaymentsNotRouting"), /query `max\(nearpay_sentinel_kill_switch_engaged\) == 0`.*rails missed the release/);
  assert.doesNotMatch(rules, /kill-switch-release/);
  const runbook = read("docs/beta-launch.md");
  const release = runbook.slice(runbook.indexOf("### Releasing the kill switch"), runbook.indexOf("### Rails missed the release"));
  for (const step of ["Request release", "Wait 5 minutes", "Approve release", "at least 20 characters", "`scripts/beta.sh ops rails flags`", "`source_version`", "`scripts/beta.sh ops sentinel quarantines` is empty"])
    assert.ok(release.includes(step), `release section lacks ${step}`);
  assert.doesNotMatch(release, /kill-switch-release/);
  const from = runbook.indexOf("### Rails missed the release");
  const missed = runbook.slice(from, runbook.indexOf("\n## ", from));
  assert.match(missed, /flag-set quoting_enabled true/);
  assert.match(missed, /keeps `source_version`, so the next real kill-switch event from sentinel still wins/);
});

test("NEAR RPC order: FastNEAR first, the deprecated near.org endpoint last; every default host is allow-listed", () => {
  const compose = read("compose/compose.yaml");
  const defaults = [...compose.matchAll(/NP_NEAR_RPC_URLS: \$\{NP_NEAR_RPC_URLS:-([^}]+)\}/g)].map((m) => m[1]);
  assert.ok(defaults.length >= 4);
  for (const d of defaults) {
    const urls = d.split(",");
    assert.equal(urls[0], "https://free.rpc.fastnear.com");
    assert.equal(urls.at(-1), "https://rpc.mainnet.near.org");
    assert.ok(urls.length >= 3);
  }
  assert.match(read("compose/env/local.env.example"), /^NP_NEAR_RPC_URLS=https:\/\/free\.rpc\.fastnear\.com,/m);
  const allow = read("compose/egress/allowlist.yaml");
  for (const host of new Set(defaults.flatMap((d) => d.split(",")).map((u) => new URL(u).host)))
    assert.equal(allow.split(`host: ${host},`).length - 1, 6, `${host} must be allow-listed for every NEAR-calling service`);
  assert.match(read("scripts/beta.sh"), /NP_NEAR_RPC_URLS starts with rpc\.mainnet\.near\.org/);
});

test("watchdog gets the Prometheus and Alertmanager URLs (dead man's switch for alerting)", () => {
  const beta = read("scripts/beta.sh");
  assert.match(beta, /NP_WD_PROMETHEUS_URL="http:\/\/127\.0\.0\.1:\$\(envval NP_PROMETHEUS_PORT\)"/);
  assert.match(beta, /NP_WD_ALERTMANAGER_URL="http:\/\/127\.0\.0\.1:\$\(envval NP_ALERTMANAGER_PORT\)"/);
  assert.match(read("docs/beta-launch.md"), /\| watchdog: alerting is broken \|/);
});

function promtool() {
  for (const bin of [process.env.PROMTOOL, "promtool"].filter(Boolean)) {
    const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return bin;
  }
  return null;
}
const bin = promtool();

test("promtool: rule files check and the rule unit tests pass", { skip: bin ? false : "promtool not found (set PROMTOOL or put promtool 3.5.x on PATH)" }, () => {
  const dir = join(deploy, "compose/monitoring/prometheus/rules");
  const files = readdirSync(dir).filter((f) => f.endsWith(".yml")).map((f) => join(dir, f));
  let r = spawnSync(bin, ["check", "rules", ...files], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const tdir = join(deploy, "scripts/test/promtool");
  const tests = readdirSync(tdir).filter((f) => f.endsWith(".test.yml")).map((f) => join(tdir, f));
  assert.ok(tests.length > 0);
  r = spawnSync(bin, ["test", "rules", ...tests], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
