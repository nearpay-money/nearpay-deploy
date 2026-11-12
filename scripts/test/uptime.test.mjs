// Uptime of the beta on the owner's Mac (docs/beta-launch.md "Uptime"): the in-stack autoheal, the host watchdog,
// the launchd jobs, `beta.sh doctor`, the deploy silence and the wiring in Compose, Prometheus and the runbook.
//   node --test scripts/test/
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as autoheal from "../../compose/autoheal/autoheal.mjs";
import { DEPLOY_ALERTS, create, expire, silenceBody } from "../lib/alertmanager-silence.mjs";
import { checks, dockerAutoStart, parsePmset } from "../lib/doctor.mjs";
import { LABELS, jobs, plist } from "../lib/launchd.mjs";
import { MONITORING_QUERIES, OPTS, alertMessages, classifyPublic, containerFacts, decide, emptyState, monitoringFacts, monitoringProblems, summaryLines } from "../lib/watchdog.mjs";

const deploy = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(join(deploy, p), "utf8");
const MIN = 60_000;

// ---- autoheal (compose/autoheal/autoheal.mjs) ----------------------------------------------------------------------
test("autoheal: health from docker ps status", () => {
  assert.equal(autoheal.healthFromStatus("Up 5 minutes (unhealthy)"), "unhealthy");
  assert.equal(autoheal.healthFromStatus("Up 2 seconds (health: starting)"), "starting");
  assert.equal(autoheal.healthFromStatus("Up 1 hour (healthy)"), "healthy");
  assert.equal(autoheal.healthFromStatus("Up 1 hour"), null);
});

test("autoheal: restarts after the grace period, then backs off 2, 4, 8 … 30 min", () => {
  const sick = [{ name: "a", health: "unhealthy" }, { name: "b", health: "healthy" }, { name: "c", health: "healthy" }];
  let m = autoheal.emptyMemory();
  let t = 0;
  let d = autoheal.decide(sick, m, t);
  assert.deepEqual(d.restart, []); // first sighting: grace
  d = autoheal.decide(sick, d.memory, (t += 61_000));
  assert.deepEqual(d.restart, ["a"]);
  m = d.memory;
  for (const [wait, expect] of [[60_000, []], [61_000, ["a"]], [4 * MIN, ["a"]], [7 * MIN, []], [MIN, ["a"]]]) {
    d = autoheal.decide(sick, m, (t += wait));
    assert.deepEqual(d.restart, expect, `after +${wait / 1000}s`);
    if (!expect.length) assert.equal(d.held.backoff, 1);
    m = d.memory;
  }
  assert.equal(autoheal.backoffMs(10), autoheal.DEFAULTS.backoffMaxMs);
  // healthy for 10 minutes: the backoff starts over
  const healthy = sick.map((c) => ({ ...c, health: "healthy" }));
  d = autoheal.decide(healthy, m, (t += MIN));
  d = autoheal.decide(healthy, d.memory, (t += 10 * MIN));
  assert.equal(d.memory.last.a, undefined);
});

test("autoheal: at most 3 restarts per 10 minutes, opt-out label respected", () => {
  const cs = "abcdefghijklmn".split("").map((name, i) => ({ name, health: i < 3 ? "unhealthy" : "healthy" }));
  cs.push({ name: "pg", health: "unhealthy", optOut: true });
  let d = autoheal.decide(cs, autoheal.emptyMemory(), 0);
  d = autoheal.decide(cs, d.memory, 61_000);
  assert.deepEqual(d.restart, ["a", "b", "c"]);
  assert.equal(d.held.opt_out, 1);
  const more = cs.map((c) => (c.name === "d" ? { ...c, health: "unhealthy" } : c));
  d = autoheal.decide(more, d.memory, 2 * MIN);
  d = autoheal.decide(more, d.memory, 3.1 * MIN);
  assert.deepEqual(d.restart, []); // a, b, c are out of their 2 min backoff, d past its grace: all wait for the window
  assert.equal(d.held.rate_limited, 4);
  d = autoheal.decide(more, d.memory, 11.1 * MIN); // window passed: the longest-unhealthy go first, d still waits
  assert.deepEqual(d.restart, ["a", "b", "c"]);
  assert.equal(d.held.rate_limited, 1);
});

test("autoheal: many unhealthy at once = overloaded machine → hold, restart nothing", () => {
  const cs = Array.from({ length: 8 }, (_, i) => ({ name: `s${i}`, health: i < 4 ? "unhealthy" : "healthy" }));
  let d = autoheal.decide(cs, autoheal.emptyMemory(), 0);
  d = autoheal.decide(cs, d.memory, 5 * MIN);
  assert.deepEqual(d.restart, []);
  assert.equal(d.held.mass_unhealthy, 1);
  assert.equal(d.unhealthy.length, 4);
});

test("autoheal: metrics text", () => {
  const t = autoheal.renderMetrics({ restarts: { "nearpay-beta-x-1": 2 }, failures: {}, unhealthy: ["nearpay-beta-y-1"], byHealth: { healthy: 3 }, held: { backoff: 1 }, dockerErrors: 0, lastLoop: 1_000_000 });
  assert.match(t, /^nearpay_autoheal_restarts_total\{container="nearpay-beta-x-1"\} 2$/m);
  assert.match(t, /^nearpay_autoheal_unhealthy\{container="nearpay-beta-y-1"\} 1$/m);
  assert.match(t, /^nearpay_autoheal_held\{reason="backoff"\} 1$/m);
  assert.match(t, /^nearpay_autoheal_held\{reason="mass_unhealthy"\} 0$/m);
  assert.match(t, /^nearpay_autoheal_last_loop_timestamp_seconds 1000$/m);
});

// ---- host watchdog (scripts/lib/watchdog.mjs) ----------------------------------------------------------------------
const c = (service, extra = {}) => ({ container: `nearpay-beta-${service}-1`, service, state: "running", health: "healthy", restartPolicy: "unless-stopped", oneoff: false, ...extra });
const STACK = () => [c("postgres"), c("identity-api"), c("cloudflared"), c("autoheal"), c("migrate-identity", { state: "exited", health: null, restartPolicy: "no" })];
const OK_PUBLIC = [{ url: "https://api.nearpay.money/healthz", expect: "200", code: 200 }, { url: "https://nearpay.money/", expect: "2xx3xx", code: 301 }];
const facts = (over = {}) => ({ now: 10 * 60 * MIN, docker: true, containers: STACK(), expected: ["autoheal", "cloudflared", "identity-api", "postgres"], internet: true, public: OK_PUBLIC, ...over });

test("watchdog: all well → no action, nothing firing", () => {
  const d = decide(facts(), emptyState());
  assert.deepEqual(d.actions, []);
  assert.deepEqual(d.firing, {});
  assert.match(d.summary, /^ok: 4\/4 running \(4 healthy\), public URLs ok$/);
});

test("watchdog: beta.sh down marker and a running beta.sh up keep it still", () => {
  assert.deepEqual(decide(facts({ stopped: true, docker: false }), emptyState()).actions, []);
  assert.match(decide(facts({ busy: true, containers: [] }), emptyState()).summary, /^waiting/);
});

test("watchdog: Docker Desktop down → open it (every 5 min), alert from the 2nd round", () => {
  let d = decide(facts({ docker: false }), emptyState());
  assert.deepEqual(d.actions, [{ type: "open_docker" }]);
  assert.deepEqual(Object.keys(d.firing), []);
  d = decide(facts({ docker: false, now: facts().now + MIN }), d.state);
  assert.deepEqual(d.actions, []); // opened a minute ago
  assert.ok(d.firing.docker_down);
  d = decide(facts({ docker: false, now: facts().now + 6 * MIN }), d.state);
  assert.deepEqual(d.actions, [{ type: "open_docker" }]);
});

test("watchdog: stopped long-running container → docker start; one-shots never; crash loop alert", () => {
  const cs = STACK().map((x) => (x.service === "identity-api" ? { ...x, state: "exited", health: null } : x));
  let d = decide(facts({ containers: cs }), emptyState());
  assert.deepEqual(d.actions, [{ type: "start", container: "nearpay-beta-identity-api-1", service: "identity-api" }]);
  let t = facts().now;
  d = decide(facts({ containers: cs, now: (t += MIN) }), d.state);
  assert.deepEqual(d.actions, []); // 2 min between starts
  d = decide(facts({ containers: cs, now: (t += 2 * MIN) }), d.state);
  assert.equal(d.actions.length, 1);
  assert.equal(d.firing.crash_loop, undefined);
  d = decide(facts({ containers: cs, now: (t += 2 * MIN) }), d.state);
  assert.match(d.firing.crash_loop, /identity-api/);
  const restarting = STACK().map((x) => (x.service === "identity-api" ? { ...x, state: "restarting" } : x));
  let s = emptyState();
  for (let i = 0; i < OPTS.restartingRuns; i++) s = decide(facts({ containers: restarting }), s).state;
  assert.match(decide(facts({ containers: restarting }), s).firing.crash_loop, /identity-api/);
});

test("watchdog: missing containers → beta.sh up --no-pull, at most every 15 min", () => {
  const cs = STACK().filter((x) => x.service !== "cloudflared");
  let d = decide(facts({ containers: cs }), emptyState());
  assert.deepEqual(d.actions, [{ type: "up", why: "missing: cloudflared" }]);
  assert.ok(d.firing.stack_missing);
  d = decide(facts({ containers: cs, now: facts().now + 5 * MIN }), d.state);
  assert.deepEqual(d.actions, []);
  d = decide(facts({ containers: cs, now: facts().now + 16 * MIN }), d.state);
  assert.equal(d.actions[0].type, "up");
  assert.deepEqual(decide(facts({ containers: [] }), emptyState()).actions, [{ type: "up", why: "no beta containers exist" }]);
});

test("watchdog: unhealthy → alert after 5 min; restarts only when autoheal is not running", () => {
  const sick = (ah = "healthy") => STACK().map((x) => (x.service === "identity-api" ? { ...x, health: "unhealthy" } : x.service === "autoheal" ? { ...x, health: ah } : x));
  let d = decide(facts({ containers: sick() }), emptyState());
  assert.deepEqual(d.firing, {});
  d = decide(facts({ containers: sick(), now: facts().now + 5 * MIN }), d.state);
  assert.match(d.firing.unhealthy, /identity-api.*autoheal is retrying/);
  assert.deepEqual(d.actions, []);
  d = decide(facts({ containers: sick("unhealthy"), now: facts().now + 6 * MIN }), d.state);
  assert.deepEqual(d.actions.map((a) => [a.type, a.service]), [["restart", "identity-api"]]);
});

test("watchdog: tunnel errors restart cloudflared; origin errors and no internet do not", () => {
  const tunnel = OK_PUBLIC.map((p) => ({ ...p, code: 530 }));
  let d = decide(facts({ public: tunnel }), emptyState());
  assert.deepEqual(d.actions, []); // one round can be a blip
  d = decide(facts({ public: tunnel, now: facts().now + MIN }), d.state);
  assert.deepEqual(d.actions.map((a) => [a.type, a.service]), [["restart", "cloudflared"]]);
  assert.match(d.firing.public_down, /530/);
  d = decide(facts({ public: tunnel, now: facts().now + 2 * MIN }), d.state);
  assert.deepEqual(d.actions, []); // 10 min between tunnel restarts
  const origin = [{ ...OK_PUBLIC[0], code: 503 }, OK_PUBLIC[1]];
  d = decide(facts({ public: origin }), decide(facts({ public: origin }), emptyState()).state);
  assert.deepEqual(d.actions, []);
  assert.ok(d.firing.public_down);
  d = decide(facts({ internet: false, public: undefined }), emptyState());
  assert.deepEqual(d.actions, []);
  assert.ok(d.firing.internet_down);
  assert.equal(classifyPublic({ code: 0, expect: "200" }), "tunnel");
  assert.equal(classifyPublic({ code: 302, expect: "2xx3xx" }), "ok");
  assert.equal(classifyPublic({ code: 302, expect: "200" }), "origin");
});

test("watchdog: broken alerting (dead man's switch) → Telegram directly after 3 rounds, resolved when it works", () => {
  const ok = { prometheus: true, alertmanager: true, alertmanagersDiscovered: 1, deliveryErrors: 0, ruleFailures: 0, telegramFailures: 0 };
  assert.deepEqual(monitoringProblems(ok), []);
  assert.deepEqual(monitoringProblems(undefined), []);
  // unknown counters (no data yet) are not problems
  assert.deepEqual(monitoringProblems({ prometheus: true, alertmanager: true, alertmanagersDiscovered: null, telegramFailures: null }), []);
  assert.match(monitoringProblems({ ...ok, telegramFailures: 2 })[0], /Telegram messages fail: bot token/);
  assert.match(monitoringProblems({ ...ok, alertmanagersDiscovered: 0 })[0], /cannot send alerts to Alertmanager/);
  assert.match(monitoringProblems({ ...ok, deliveryErrors: 3 })[0], /cannot send alerts to Alertmanager/);
  assert.match(monitoringProblems({ ...ok, ruleFailures: 1 })[0], /rules fail to evaluate/);
  assert.equal(monitoringProblems({ prometheus: false, alertmanager: false }).length, 2);

  const broken = { ...ok, alertmanager: false };
  let t = facts().now;
  let d = decide(facts({ monitoring: broken }), emptyState());
  assert.deepEqual(d.firing, {});
  assert.match(d.summary, /^degraded: .*alerting: Alertmanager does not answer$/);
  assert.deepEqual(d.actions, []); // alert only, never heals the monitoring containers itself
  for (let i = 1; i < OPTS.monitoringFailRuns; i++) d = decide(facts({ monitoring: broken, now: (t += MIN) }), d.state);
  assert.match(d.firing.monitoring_down, /^Alerting is broken on the beta Mac.*Alertmanager does not answer \(scripts\/beta\.sh logs alertmanager\)/);
  let m = alertMessages({}, d.firing, t);
  assert.match(m.messages[0], /^ALERT: Alerting is broken/);
  d = decide(facts({ monitoring: ok, now: (t += MIN) }), d.state);
  assert.deepEqual(d.firing, {});
  assert.equal(d.state.monitoringFail, 0);
  m = alertMessages(m.alerts, d.firing, t);
  assert.match(m.messages[0], /^RESOLVED: alerting works again/);
  // a blip (Prometheus restarting for a round) does not alert
  d = decide(facts({ monitoring: { ...ok, prometheus: false } }), emptyState());
  d = decide(facts({ monitoring: ok, now: facts().now + MIN }), d.state);
  d = decide(facts({ monitoring: { ...ok, prometheus: false }, now: facts().now + 2 * MIN }), d.state);
  assert.deepEqual(d.firing, {});
});

test("watchdog: monitoring facts from Prometheus /-/ready, Alertmanager /api/v2/status and the delivery counters", async () => {
  const values = { [MONITORING_QUERIES.alertmanagersDiscovered]: "1", [MONITORING_QUERIES.telegramFailures]: "4" };
  const prom = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/-/ready") return res.writeHead(200).end("ready");
    const v = values[u.searchParams.get("query")];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "success", data: { resultType: "vector", result: v === undefined ? [] : [{ metric: {}, value: [0, v] }] } }));
  });
  await new Promise((r) => prom.listen(0, "127.0.0.1", r));
  const promUrl = `http://127.0.0.1:${prom.address().port}`;
  try {
    const m = await monitoringFacts(promUrl, "http://127.0.0.1:9");
    assert.deepEqual(m, { prometheus: true, alertmanager: false, alertmanagersDiscovered: 1, deliveryErrors: null, ruleFailures: null, telegramFailures: 4 });
    assert.equal(monitoringProblems(m).length, 2);
    const down = await monitoringFacts("http://127.0.0.1:9", "http://127.0.0.1:9");
    assert.deepEqual(down, { prometheus: false, alertmanager: false });
  } finally {
    await new Promise((r) => prom.close(r));
  }
});

test("watchdog: Telegram once per problem, a reminder every 6 h, and a resolved message", () => {
  let r = alertMessages({}, { public_down: "Public URLs fail" }, 0);
  assert.deepEqual(r.messages, ["ALERT: Public URLs fail"]);
  r = alertMessages(r.alerts, { public_down: "Public URLs fail" }, 60 * MIN);
  assert.deepEqual(r.messages, []);
  r = alertMessages(r.alerts, { public_down: "Public URLs fail" }, 6 * 60 * MIN);
  assert.match(r.messages[0], /^STILL FAILING \(since 1970-01-01 00:00 UTC\): Public URLs fail$/);
  r = alertMessages(r.alerts, {}, 6 * 60 * MIN + 5 * MIN);
  assert.deepEqual(r.messages, ["RESOLVED: the public URLs answer again (after 365 min)"]);
  assert.deepEqual(r.alerts, {});
});

test("watchdog: docker inspect → facts, status summary lines", () => {
  const f = containerFacts([
    { Name: "/nearpay-beta-cloudflared-1", Config: { Labels: { "com.docker.compose.service": "cloudflared" } }, State: { Status: "running", Health: { Status: "healthy" } }, HostConfig: { RestartPolicy: { Name: "unless-stopped" } } },
    { Name: "/nearpay-beta-migrate-identity-1", Config: { Labels: { "com.docker.compose.service": "migrate-identity" } }, State: { Status: "exited" }, HostConfig: { RestartPolicy: { Name: "no" } } },
  ]);
  assert.deepEqual(f[0], { container: "nearpay-beta-cloudflared-1", service: "cloudflared", state: "running", health: "healthy", restartPolicy: "unless-stopped", oneoff: false });
  const lines = summaryLines([...f, c("autoheal")], { lastRun: 1_000, lastSummary: "ok: 2/2 running" }, 61_000, { installed: true });
  assert.deepEqual(lines.map((l) => l[0]), ["ok", "ok", "ok", "ok"]);
  assert.match(lines[0][1], /^containers: 2\/2 running, 2 healthy$/);
  const stale = summaryLines([...f, c("autoheal")], { lastRun: 1_000, lastSummary: "ok" }, 20 * MIN, { installed: true });
  assert.equal(stale[3][0], "FAIL");
  assert.equal(summaryLines([], null, 0)[0][0], "FAIL");
});

// ---- launchd (scripts/lib/launchd.mjs) -----------------------------------------------------------------------------
test("launchd: three jobs with the right programs, schedule and keep-alive", () => {
  const js = jobs({ deploy: "/Users/a b/work/nearpay-deploy", logDir: "/Users/a b/Library/Logs/NearPay", path: "/opt/homebrew/bin:/usr/bin:/bin" });
  assert.deepEqual(js.map((j) => j.label), [LABELS.autostart, LABELS.keepawake, LABELS.watchdog]);
  const [auto, awake, wd] = js.map((j) => j.job);
  assert.deepEqual(auto.ProgramArguments, ["/bin/bash", "/Users/a b/work/nearpay-deploy/scripts/beta.sh", "autostart"]);
  assert.equal(auto.RunAtLoad, true);
  assert.equal(auto.EnvironmentVariables.PATH, "/opt/homebrew/bin:/usr/bin:/bin");
  assert.deepEqual(wd.ProgramArguments.slice(-1), ["watchdog"]);
  assert.equal(wd.StartInterval, 60);
  assert.deepEqual(awake.KeepAlive, { SuccessfulExit: false });
  assert.equal(awake.ProgramArguments.at(-1), "/Users/a b/work/nearpay-deploy/.secrets/beta/stopped");
  assert.match(awake.ProgramArguments[2], /exec \/usr\/bin\/caffeinate -ims$/);
  // the keep-awake program: exits 0 (launchd leaves it down) while the marker exists
  const dir = mkdtempSync(join(tmpdir(), "np-ka-"));
  writeFileSync(join(dir, "stopped"), "");
  const r = spawnSync(awake.ProgramArguments[0], [...awake.ProgramArguments.slice(1, -1), join(dir, "stopped")]);
  assert.equal(r.status, 0);
});

test("launchd: plist XML is escaped and parses as a property list", () => {
  const xml = plist({ Label: "x", ProgramArguments: ["/bin/sh", "-c", 'a && b <c> "d"'], RunAtLoad: true, StartInterval: 60, KeepAlive: { SuccessfulExit: false } });
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<!DOCTYPE plist/);
  assert.match(xml, /<string>a &amp;&amp; b &lt;c&gt; &quot;d&quot;<\/string>/);
  assert.match(xml, /<key>RunAtLoad<\/key>\n\s+<true\/>/);
  assert.match(xml, /<key>StartInterval<\/key>\n\s+<integer>60<\/integer>/);
  const dir = mkdtempSync(join(tmpdir(), "np-plist-"));
  for (const { label, job } of jobs({ deploy: "/d&d", logDir: "/l", path: "/usr/bin" })) {
    const f = join(dir, `${label}.plist`);
    writeFileSync(f, plist(job));
    for (const [cmd, args] of [["plutil", ["-lint", f]], ["python3", ["-c", "import plistlib,sys; plistlib.load(open(sys.argv[1],'rb'))", f]]]) {
      const p = spawnSync(cmd, args, { encoding: "utf8" });
      if (p.error) continue; // tool not on this machine
      assert.equal(p.status, 0, `${cmd} rejects ${label}: ${p.stderr}`);
    }
  }
});

// ---- doctor (scripts/lib/doctor.mjs) -------------------------------------------------------------------------------
const PMSET_BAD = `Battery Power:
 sleep                1
 disksleep            10
AC Power:
 sleep                10 (sleep prevented by caffeinate)
 disksleep            10
 womp                 0
`;
const goodMac = {
  platform: "darwin",
  pmset: parsePmset("AC Power:\n sleep 0\n disksleep 0\n autorestart 1\n womp 1\n"),
  onBattery: false,
  hasBattery: false,
  fileVault: true,
  autoLoginUser: null,
  dockerAutoStart: true,
  dockerMemBytes: 10.4e9,
  autoMacosUpdates: false,
  agents: Object.fromEntries(Object.values(LABELS).map((l) => [l, { installed: true, loaded: true }])),
};

test("doctor: pmset and Docker Desktop settings parsing", () => {
  assert.deepEqual(parsePmset(PMSET_BAD), { battery: { sleep: 1, disksleep: 10 }, ac: { sleep: 10, disksleep: 10, womp: 0 } });
  assert.deepEqual(parsePmset(" sleep 0\n autorestart 1\n"), { ac: { sleep: 0, autorestart: 1 } });
  assert.equal(dockerAutoStart({ AutoStart: true }), true);
  assert.equal(dockerAutoStart({ autoStart: false }), false);
  assert.equal(dockerAutoStart({}), null);
});

test("doctor: a well set-up Mac has no FAIL; FileVault explains the login trade-off", () => {
  const r = checks(goodMac);
  assert.deepEqual(r.filter((x) => x.status === "FAIL"), []);
  assert.match(r.find((x) => /FileVault/.test(x.text)).fix, /sudo fdesetup authrestart/);
});

test("doctor: each problem has its exact fix", () => {
  const r = checks({ ...goodMac, pmset: parsePmset(PMSET_BAD), onBattery: true, dockerAutoStart: false, dockerMemBytes: 8.2e9, fileVault: false, autoMacosUpdates: true, agents: {} });
  const fix = (re) => r.find((x) => re.test(x.text))?.fix;
  assert.equal(fix(/system sleep/), "sudo pmset -c sleep 0");
  assert.equal(fix(/disk sleep/), "sudo pmset -c disksleep 0");
  assert.equal(fix(/power failure/), "sudo pmset -a autorestart 1");
  assert.equal(fix(/wake for network/), "sudo pmset -c womp 1");
  assert.match(fix(/battery/), /plug in/);
  assert.match(fix(/Docker Desktop does not start/), /Start Docker Desktop when you sign in/);
  assert.match(fix(/Docker Desktop memory/), /10 GB/);
  assert.match(fix(/automatic login is off/), /Automatically log in as/);
  assert.match(fix(/installs updates/), /Install macOS updates/);
  assert.equal(r.filter((x) => /^launchd/.test(x.text) && x.fix === "scripts/beta.sh install-autostart").length, 3);
  assert.ok(r.filter((x) => x.status === "FAIL").length >= 5);
  assert.equal(checks({ platform: "linux" })[0].status, "warn");
});

// ---- deploy silence (scripts/lib/alertmanager-silence.mjs) ---------------------------------------------------------
test("deploy silence: availability alerts only, created and expired through the Alertmanager API", async () => {
  const body = silenceBody(0, 30, "deploy");
  assert.equal(body.endsAt, "1970-01-01T00:30:00.000Z");
  assert.equal(body.matchers[0].value, DEPLOY_ALERTS.join("|"));
  for (const money of ["KillSwitchEngaged", "LivePaymentsNotRouting", "ReconciliationDifference", "QuoteIntegrityFailure", "FinalityRecheckFailed", "AutohealHeld"]) {
    assert.ok(!DEPLOY_ALERTS.includes(money), `${money} must never be silenced by a deploy`);
  }
  const rules = read("compose/monitoring/prometheus/rules/nearpay.yml") + read("compose/monitoring/prometheus/rules/uptime.yml");
  for (const a of DEPLOY_ALERTS) assert.match(rules, new RegExp(`alert: ${a}\\n`), `${a} is not an alert rule`);
  const seen = [];
  const server = createServer((req, res) => {
    let s = "";
    req.on("data", (d) => (s += d)).on("end", () => {
      seen.push([req.method, req.url, s && JSON.parse(s)]);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(req.method === "POST" ? JSON.stringify({ silenceID: "abc-123" }) : "");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(await create(url, 30, "deploy", 0), "abc-123");
    await expire(url, "abc-123");
    assert.deepEqual(seen.map((s) => [s[0], s[1]]), [["POST", "/api/v2/silences"], ["DELETE", "/api/v2/silence/abc-123"]]);
    assert.equal(seen[0][2].createdBy, "scripts/beta.sh up");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ---- wiring: Compose, Prometheus, beta.sh, runbook -----------------------------------------------------------------
test("Prometheus scrapes autoheal; uptime rules route to Telegram with the right severities", () => {
  assert.match(read("compose/monitoring/prometheus/prometheus.yml"), /job_name: autoheal\n\s+static_configs: \[\{ targets: \["autoheal:9464"\] \}\]/);
  const rules = read("compose/monitoring/prometheus/rules/uptime.yml");
  assert.match(rules, /alert: ContainerAutoHealed\n\s+expr: sum by \(container\) \(increase\(nearpay_autoheal_restarts_total\[10m\]\)\) > 0\n\s+labels: \{ severity: warning \}/);
  assert.match(rules, /alert: ContainerUnhealthy\n\s+expr: max by \(container\) \(nearpay_autoheal_unhealthy\) == 1\n\s+for: 10m\n\s+labels: \{ severity: critical \}/);
  assert.match(rules, /alert: AutohealHeld\n[\s\S]*?severity: critical/);
  assert.match(rules, /alert: AutohealDown\n/);
});

test("beta.sh: uptime commands, lock, marker and deploy silence are wired", () => {
  const sh = read("scripts/beta.sh");
  for (const cmd of ["install-autostart", "uninstall-autostart", "autostart", "doctor", "watchdog"]) assert.match(sh, new RegExp(`\\n  ${cmd}\\)`), `beta.sh has no '${cmd}' command`);
  assert.match(sh, /touch "\$stopped_marker"/); // down
  assert.match(sh, /rm -f "\$stopped_marker"/); // up
  assert.match(sh, /alertmanager-silence\.mjs" create/);
  assert.match(sh, /record_expected/);
  assert.match(sh, /lock_wait 120 \|\| die/);
});

test("runbook: the Uptime section covers the owner's one-time steps and every uptime alert", () => {
  const doc = read("docs/beta-launch.md");
  assert.match(doc, /\n## Uptime\n/);
  for (const s of ["scripts/beta.sh install-autostart", "scripts/beta.sh doctor", "sudo pmset autorestart 1", "sudo pmset -c sleep 0 disksleep 0", "Start Docker Desktop when you sign in", "UptimeRobot", "sudo fdesetup authrestart", "scripts/beta.sh watchdog pause"]) {
    assert.ok(doc.includes(s), `docs/beta-launch.md does not mention ${s}`);
  }
  for (const a of ["ContainerAutoHealed", "ContainerUnhealthy", "AutohealHeld", "AutohealDown"]) assert.ok(doc.includes(a), `runbook has no entry for ${a}`);
  for (const h of ["nearpay.money", "api.nearpay.money/healthz", "pay.nearpay.money", "dashboard.nearpay.money", "docs.nearpay.money"]) assert.ok(doc.includes(h));
});

// The merged beta configuration (needs `scripts/seed.sh keys`, the beta placeholders and docker; CI runs it after the
// "Compose configuration (beta overlay)" step): every long-running service restarts, has a health check, rotates its
// logs, and every NearPay process has a memory limit.
const keys = join(deploy, ".secrets/public/keys.env");
const live = join(deploy, ".secrets/live/compose.live.yaml");
const canConfig = existsSync(keys) && existsSync(live) && existsSync(join(deploy, ".secrets/beta/alertmanager.yml")) && existsSync(join(deploy, "compose/env/local.env")) && spawnSync("docker", ["compose", "version"]).status === 0;
test("beta config: restart, health check, log rotation and memory limits everywhere", { skip: canConfig ? false : "needs seed.sh keys, seed.sh live, the beta placeholders and docker compose" }, () => {
  const out = execFileSync("docker", ["compose", "--project-name", "nearpay-beta", "--project-directory", "compose", "-f", "compose/compose.yaml", "-f", "compose/compose.local.yaml", "-f", live, "-f", "compose/compose.beta.yaml", "--env-file", "compose/env/local.env", "--env-file", "compose/env/beta.env", "--env-file", keys, "--profile", "*", "config", "--format", "json"], {
    cwd: deploy,
    encoding: "utf8",
    env: { ...process.env, NP_CF_ACCESS_AUD: "placeholder", NP_CF_ACCESS_TEAM_DOMAIN: "placeholder.cloudflareaccess.com" },
    maxBuffer: 64 * 1024 * 1024,
  });
  const services = JSON.parse(out).services;
  const IMAGE_HEALTHCHECK = new Set(["console"]); // HEALTHCHECK in nearpay-console's Dockerfile
  const LOCAL_ONLY = new Set(["mailpit", "merchant-demo"]);
  for (const [name, s] of Object.entries(services)) {
    assert.equal(s.logging?.options?.["max-size"], "10m", `${name}: no log rotation`);
    if (LOCAL_ONLY.has(name) || s.restart === "no") continue;
    assert.equal(s.restart, "unless-stopped", `${name}: restart`);
    // NearPay images bring their own HEALTHCHECK test (`node dist/main.js healthcheck`); Compose sets the cadence
    const own = s.image?.startsWith("nearpay/") ? s.healthcheck && !s.healthcheck.disable : s.healthcheck?.test?.length;
    if (!IMAGE_HEALTHCHECK.has(name)) assert.ok(own, `${name}: no health check`);
    if (s.image?.startsWith("nearpay/") && name !== "console" && name !== "egress-proxy") {
      assert.equal(s.mem_limit, String(1024 ** 3), `${name}: memory limit`);
    }
  }
  assert.equal(services.postgres.mem_limit, undefined); // never OOM-capped
  assert.equal(services.postgres.labels[autoheal.OPT_OUT_LABEL], "false");
  assert.ok(services.postgres.oom_score_adj < (services["payments-api"].oom_score_adj ?? 0));
  assert.deepEqual(services.cloudflared.healthcheck.test, ["CMD", "/usr/local/bin/cloudflared", "tunnel", "--metrics", "127.0.0.1:20241", "ready"]);
  assert.ok(services.cloudflared.command.includes("127.0.0.1:20241"));
  assert.ok(services.autoheal.volumes.some((v) => v.source === "/var/run/docker.sock" && v.read_only));
  assert.deepEqual(services.autoheal.cap_drop, ["ALL"]);
});
