// Host watchdog for the beta on the owner's Mac (scripts/beta.sh watchdog; launchd runs it every minute once
// `scripts/beta.sh install-autostart` is done). It looks at what the in-stack autoheal cannot see — Docker Desktop
// itself, containers that are stopped or missing, the public URLs through Cloudflare — and heals only in safe ways:
//
//   Docker Desktop not answering        open it (`open -ga Docker`), alert after 2 minutes
//   beta containers missing             `scripts/beta.sh up --no-pull` (idempotent; at most every 15 min)
//   long-running container stopped      `docker start <container>` (never a one-shot like migrate-* or postgres-init)
//   container unhealthy for 5 min       alert; restart it only when the autoheal container itself is not running
//   public URLs fail with tunnel errors  restart cloudflared (530 / no answer while the internet works; every 10 min)
//
// It never recreates containers itself (`docker compose up` without beta.sh's environment would remount the static
// sites from placeholders) and never touches data. `scripts/beta.sh down` leaves a marker that turns it off; while
// `beta.sh up` runs it waits (shared lock in beta.sh). Alerts go straight to Telegram (the bot token is read from its
// file, never logged), once when a problem starts, every 6 h while it lasts, and once when it clears.
//
//   node scripts/lib/watchdog.mjs run        one round (beta.sh watchdog sets the NP_WD_* environment)
//   node scripts/lib/watchdog.mjs summary    the lines `scripts/beta.sh status` prints
import { execFile, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

export const OPTS = Object.freeze({
  dockerDownRuns: 2, // alert once Docker has not answered for this many rounds
  openDockerGapMs: 5 * 60_000,
  upGapMs: 15 * 60_000,
  startGapMs: 2 * 60_000, // per container
  crashLoopStarts: 3, // starts of one container within crashLoopWindowMs → alert "keeps stopping"
  crashLoopWindowMs: 30 * 60_000,
  restartingRuns: 5, // Docker's own restart loop seen this many rounds in a row → alert
  unhealthyMs: 5 * 60_000,
  unhealthyRestartGapMs: 15 * 60_000,
  publicFailRuns: 2,
  tunnelRestartGapMs: 10 * 60_000,
  repeatMs: 6 * 60 * 60_000,
  keepActionsMs: 60 * 60_000,
});

export const LONG_RUNNING = new Set(["always", "unless-stopped", "on-failure"]);
const STOPPED = new Set(["exited", "dead", "created"]);

export function emptyState() {
  return { lastRun: 0, lastSummary: "", dockerDown: 0, publicFail: 0, unhealthySince: {}, restarting: {}, actions: {}, alerts: {} };
}

/** Public URL result → "ok" | "origin" (the stack answered with an error) | "tunnel" (530 / no answer) */
export function classifyPublic({ code, expect }) {
  if (expect === "200" ? code === 200 : code >= 200 && code < 400) return "ok";
  if (!code || code === 530) return "tunnel";
  return "origin";
}

function recent(state, key, now, o) {
  return (state.actions[key] ?? []).filter((t) => now - t < o.keepActionsMs);
}
function allowed(state, key, now, gapMs, o) {
  const r = recent(state, key, now, o);
  return !r.length || now - r[r.length - 1] >= gapMs;
}
function record(state, key, now, o) {
  state.actions[key] = [...recent(state, key, now, o), now];
}

/**
 * One round's decisions. facts:
 *   now, stopped (beta.sh down marker), busy (beta.sh up holds the lock), docker (boolean),
 *   containers [{ container, service, state, health, restartPolicy, oneoff }], expected [service] (from the last good
 *   `beta.sh up`; empty = unknown), internet (boolean), public [{ url, code, expect: "200" | "2xx3xx" }]
 * Returns { actions, firing: { key: text }, summary, state } — state is a new object.
 */
export function decide(facts, prev, o = OPTS) {
  const now = facts.now;
  const state = structuredClone(prev ?? emptyState());
  state.lastRun = now;
  const actions = [];
  const firing = {};
  const done = (summary) => {
    state.lastSummary = summary;
    return { actions, firing, summary, state };
  };

  if (facts.stopped) {
    Object.assign(state, { dockerDown: 0, publicFail: 0, unhealthySince: {}, restarting: {} });
    return done("idle: the beta was stopped with beta.sh down (beta.sh up starts it again)");
  }
  if (facts.busy) return done("waiting: beta.sh up is running");

  if (!facts.docker) {
    state.dockerDown += 1;
    if (facts.canOpenDocker !== false && allowed(state, "open_docker", now, o.openDockerGapMs, o)) {
      actions.push({ type: "open_docker" });
      record(state, "open_docker", now, o);
    }
    if (state.dockerDown >= o.dockerDownRuns) {
      firing.docker_down = "Docker Desktop is not answering on the beta Mac: every NearPay service is down. The watchdog is opening it; if it does not come back, open Docker Desktop by hand (and check the Mac is awake and signed in).";
    }
    return done(`unhealthy: Docker Desktop not answering (round ${state.dockerDown})`);
  }
  state.dockerDown = 0;

  const all = facts.containers ?? [];
  const running = all.filter((c) => !c.oneoff && LONG_RUNNING.has(c.restartPolicy));
  const present = new Set(all.map((c) => c.service));
  const missing = (facts.expected ?? []).filter((s) => !present.has(s));
  const parts = [];

  // 1. missing containers (or no stack at all): beta.sh up recreates them with the right environment
  if (all.length === 0 || missing.length) {
    const what = all.length === 0 ? "no beta containers exist" : `missing: ${missing.join(", ")}`;
    if (allowed(state, "up", now, o.upGapMs, o)) {
      actions.push({ type: "up", why: what });
      record(state, "up", now, o);
    }
    firing.stack_missing = `Beta containers are missing (${what}). The watchdog runs scripts/beta.sh up --no-pull (at most every 15 min); its output is in the watchdog-up log.`;
    parts.push(what);
  }

  // 2. stopped long-running containers: docker start (no recreation)
  const loops = [];
  for (const c of running.filter((x) => STOPPED.has(x.state))) {
    const key = `start:${c.service}`;
    if (allowed(state, key, now, o.startGapMs, o)) {
      actions.push({ type: "start", container: c.container, service: c.service });
      record(state, key, now, o);
    }
    if (recent(state, key, now, o).filter((t) => now - t < o.crashLoopWindowMs).length >= o.crashLoopStarts) loops.push(c.service);
  }
  const stoppedNow = running.filter((x) => STOPPED.has(x.state)).map((x) => x.service);
  if (stoppedNow.length) parts.push(`stopped: ${stoppedNow.join(", ")}`);

  // Docker's own restart loop (the process keeps exiting)
  const restartingNow = new Set(running.filter((c) => c.state === "restarting").map((c) => c.service));
  for (const s of Object.keys(state.restarting)) if (!restartingNow.has(s)) delete state.restarting[s];
  for (const s of restartingNow) {
    state.restarting[s] = (state.restarting[s] ?? 0) + 1;
    if (state.restarting[s] >= o.restartingRuns) loops.push(s);
  }
  if (restartingNow.size) parts.push(`restarting: ${[...restartingNow].join(", ")}`);
  if (loops.length) {
    firing.crash_loop = `These beta containers keep stopping: ${[...new Set(loops)].sort().join(", ")}. Run scripts/beta.sh logs <name> to see why (a missing secret, a database or config error).`;
  }

  // 3. unhealthy: autoheal restarts them; the watchdog alerts if that does not help, and heals only without autoheal
  const autoheal = running.find((c) => c.service === "autoheal");
  const autohealUp = autoheal && autoheal.state === "running" && autoheal.health !== "unhealthy";
  const unhealthy = running.filter((c) => c.state === "running" && c.health === "unhealthy");
  const since = {};
  for (const c of unhealthy) since[c.service] = state.unhealthySince[c.service] ?? now;
  state.unhealthySince = since;
  const longUnhealthy = unhealthy.filter((c) => now - since[c.service] >= o.unhealthyMs);
  for (const c of longUnhealthy) {
    const key = `restart:${c.service}`;
    if (!autohealUp && allowed(state, key, now, o.unhealthyRestartGapMs, o)) {
      actions.push({ type: "restart", container: c.container, service: c.service, why: "unhealthy for 5 min and autoheal is not running" });
      record(state, key, now, o);
    }
  }
  if (longUnhealthy.length) {
    firing.unhealthy = `Unhealthy for more than 5 minutes: ${longUnhealthy.map((c) => c.service).sort().join(", ")}${autohealUp ? " (autoheal is retrying with backoff)" : " (autoheal is not running: the watchdog restarts them)"}. Look at scripts/beta.sh logs <name>.`;
  }
  if (unhealthy.length) parts.push(`unhealthy: ${unhealthy.map((c) => c.service).join(", ")}`);
  if (!autohealUp && running.length) parts.push("autoheal not running");

  // 4. public URLs through Cloudflare
  if (facts.internet === false) {
    state.publicFail = 0;
    parts.push("this Mac has no internet");
    firing.internet_down = "The beta Mac cannot reach the internet: the site is unreachable until the connection is back (router, Wi-Fi, ISP).";
  } else if (facts.public?.length) {
    const results = facts.public.map((p) => ({ ...p, kind: classifyPublic(p) }));
    const failed = results.filter((r) => r.kind !== "ok");
    state.publicFail = failed.length ? state.publicFail + 1 : 0;
    if (failed.length) parts.push(`public: ${failed.map((r) => `${r.url.replace(/^https:\/\//, "")} ${r.code || "no answer"}`).join(", ")}`);
    if (failed.length && state.publicFail >= o.publicFailRuns) {
      firing.public_down = `Public URLs fail from the beta Mac: ${failed.map((r) => `${r.url} → ${r.code || "no answer"}`).join("; ")}.`;
      const tunnel = results.every((r) => r.kind === "tunnel");
      const cloudflared = running.find((c) => c.service === "cloudflared" && c.state === "running");
      if (tunnel && cloudflared && allowed(state, "restart:cloudflared", now, o.tunnelRestartGapMs, o)) {
        actions.push({ type: "restart", container: cloudflared.container, service: "cloudflared", why: "every public URL fails with a tunnel error" });
        record(state, "restart:cloudflared", now, o);
      }
    }
  }

  const healthy = running.filter((c) => c.health === "healthy").length;
  const head = `${running.filter((c) => c.state === "running").length}/${running.length} running (${healthy} healthy)`;
  if (!parts.length) return done(`ok: ${head}, public URLs ok`);
  return done(`${actions.length ? "healing" : "degraded"}: ${head}; ${parts.join("; ")}`);
}

/**
 * Telegram messages for this round: new problems, reminders every repeatMs, and resolved ones.
 * Returns { messages: [text], alerts } — alerts is the next state.alerts.
 */
export function alertMessages(prev, firing, now, o = OPTS) {
  const alerts = {};
  const messages = [];
  for (const [key, text] of Object.entries(firing)) {
    const p = prev[key];
    if (!p) {
      messages.push(`ALERT: ${text}`);
      alerts[key] = { since: now, sent: now };
    } else if (now - p.sent >= o.repeatMs) {
      messages.push(`STILL FAILING (since ${new Date(p.since).toISOString().slice(0, 16).replace("T", " ")} UTC): ${text}`);
      alerts[key] = { since: p.since, sent: now };
    } else {
      alerts[key] = p;
    }
  }
  for (const [key, p] of Object.entries(prev)) {
    if (!firing[key]) messages.push(`RESOLVED: ${RESOLVED[key] ?? key} (after ${Math.max(1, Math.round((now - p.since) / 60_000))} min)`);
  }
  return { messages, alerts };
}

const RESOLVED = {
  docker_down: "Docker Desktop answers again",
  stack_missing: "all beta containers exist again",
  crash_loop: "no beta container keeps stopping",
  unhealthy: "no beta container is unhealthy",
  public_down: "the public URLs answer again",
  internet_down: "the beta Mac is back online",
};

// ---- facts ----------------------------------------------------------------------------------------------------------
const run = promisify(execFile);

async function dockerOk() {
  try {
    await run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

export function containerFacts(inspect) {
  return inspect.map((c) => ({
    container: c.Name.replace(/^\//, ""),
    service: c.Config?.Labels?.["com.docker.compose.service"] ?? c.Name.replace(/^\//, ""),
    state: c.State?.Status ?? "unknown",
    health: c.State?.Health?.Status ?? null,
    restartPolicy: c.HostConfig?.RestartPolicy?.Name ?? "no",
    oneoff: c.Config?.Labels?.["com.docker.compose.oneoff"] === "True",
  }));
}

export async function containers(project) {
  const { stdout } = await run("docker", ["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`], { timeout: 30_000 });
  const ids = stdout.split("\n").filter(Boolean);
  if (!ids.length) return [];
  const r = await run("docker", ["inspect", ...ids], { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  return containerFacts(JSON.parse(r.stdout));
}

async function httpCode(url, timeoutMs = 10_000) {
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "nearpay-beta-watchdog" } });
    await res.arrayBuffer().catch(() => {});
    return res.status;
  } catch {
    return 0;
  }
}

export const PUBLIC = [
  { url: "https://api.nearpay.money/healthz", expect: "200" },
  { url: "https://nearpay.money/", expect: "2xx3xx" },
  { url: "https://pay.nearpay.money/", expect: "2xx3xx" },
  { url: "https://dashboard.nearpay.money/", expect: "2xx3xx" },
  { url: "https://docs.nearpay.money/", expect: "2xx3xx" },
];

/** One retry per failing URL (a single dropped request must not count as an outage). */
async function publicFacts(list) {
  return Promise.all(
    list.map(async (p) => {
      let code = await httpCode(p.url);
      if (classifyPublic({ code, expect: p.expect }) !== "ok") {
        await new Promise((r) => setTimeout(r, 3_000));
        code = await httpCode(p.url);
      }
      return { ...p, code };
    }),
  );
}

async function internetOk() {
  // two independent hosts: the Mac is online if either answers at all
  for (const u of ["https://1.1.1.1/cdn-cgi/trace", "https://www.google.com/generate_204"]) if ((await httpCode(u, 8_000)) > 0) return true;
  return false;
}

// ---- side effects ---------------------------------------------------------------------------------------------------
function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; }
}

function logLine(file, line) {
  if (!file) return process.stdout.write(`${line}\n`);
  mkdirSync(dirname(file), { recursive: true });
  try { if (statSync(file).size > 5 * 1024 * 1024) renameSync(file, `${file}.1`); } catch { /* new file */ }
  appendFileSync(file, `${line}\n`);
}

async function telegram(text, env) {
  const chat = env.NP_TELEGRAM_CHAT_ID;
  const tokenFile = env.NP_TELEGRAM_TOKEN_FILE;
  if (!chat || !tokenFile || !existsSync(tokenFile)) return "no Telegram chat configured";
  const token = readFileSync(tokenFile, "utf8").trim();
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: `NearPay beta watchdog (${env.NP_WD_HOST ?? "Mac"}): ${text}`, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15_000),
    });
    const j = await res.json().catch(() => ({}));
    return j.ok ? "sent" : `Telegram refused: ${j.description ?? res.status}`;
  } catch (e) {
    return `Telegram unreachable (${e.cause?.code ?? e.name})`; // never the URL: it carries the token
  }
}

async function healthchecksPing(env, failing, summary) {
  const f = env.NP_WD_HEALTHCHECKS_URL_FILE;
  if (!f || !existsSync(f)) return;
  const url = readFileSync(f, "utf8").trim();
  if (!/^https:\/\//.test(url)) return;
  try {
    await fetch(failing ? `${url.replace(/\/$/, "")}/fail` : url, { method: "POST", body: summary, signal: AbortSignal.timeout(10_000) });
  } catch { /* the ping is best effort; a missing ping is what makes it alert */ }
}

async function execute(action, env, log) {
  const sh = (cmd, args, timeout) =>
    run(cmd, args, { timeout }).then(
      () => "ok",
      (e) => `failed (${(e.stderr || e.message || "").toString().trim().split("\n").pop().slice(0, 200)})`,
    );
  switch (action.type) {
    case "open_docker":
      return process.platform === "darwin" ? sh("open", ["-ga", "Docker"], 30_000) : "skipped (not macOS)";
    case "start":
      return sh("docker", ["start", action.container], 120_000);
    case "restart":
      return sh("docker", ["restart", action.container], 180_000);
    case "up": {
      const out = env.NP_WD_UP_LOG;
      log(`running ${env.NP_WD_BETA_SH} up --no-pull (output: ${out})`);
      const r = spawnSync("/bin/bash", [env.NP_WD_BETA_SH, "up", "--no-pull"], {
        env: { ...process.env, NP_BETA_LOCK_HELD: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 45 * 60_000,
        maxBuffer: 64 * 1024 * 1024,
      });
      if (out) {
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, `${new Date().toISOString()} beta.sh up --no-pull (watchdog)\n${r.stdout ?? ""}${r.stderr ?? ""}`);
      }
      return r.status === 0 ? "ok" : `failed (exit ${r.status ?? r.signal}; see ${out})`;
    }
    default:
      return "unknown action";
  }
}

export async function runOnce(env = process.env) {
  const now = Date.now();
  const stateFile = env.NP_WD_STATE;
  const log = (line) => logLine(env.NP_WD_LOG, `${new Date().toISOString()} ${line}`);
  const prev = { ...emptyState(), ...readJson(stateFile, {}) };
  const project = env.NP_WD_PROJECT ?? "nearpay-beta";
  const facts = { now, stopped: env.NP_WD_STOPPED === "1", busy: env.NP_WD_BUSY === "1", canOpenDocker: process.platform === "darwin" };
  if (!facts.stopped && !facts.busy) {
    facts.docker = await dockerOk();
    if (facts.docker) {
      try { facts.containers = await containers(project); } catch (e) { facts.docker = false; log(`docker ps/inspect failed: ${e.message.split("\n")[0]}`); }
    }
    facts.expected = (env.NP_WD_EXPECTED && existsSync(env.NP_WD_EXPECTED) ? readFileSync(env.NP_WD_EXPECTED, "utf8") : "").split(/\s+/).filter(Boolean);
    facts.internet = await internetOk();
    if (facts.internet) facts.public = await publicFacts(PUBLIC);
  }
  const d = decide(facts, prev);
  const paused = env.NP_WD_PAUSED === "1";
  log(`${paused ? "[paused] " : ""}${d.summary}`);
  for (const a of d.actions) {
    const what = `${a.type}${a.container ? ` ${a.container}` : ""}${a.why ? ` (${a.why})` : ""}`;
    if (paused) { log(`  would ${what} (paused: scripts/beta.sh watchdog resume)`); continue; }
    log(`  ${what}: ${await execute(a, env, log)}`);
  }
  const { messages, alerts } = alertMessages(prev.alerts ?? {}, d.firing, now);
  d.state.alerts = alerts;
  for (const m of messages) log(`  telegram: ${await telegram(paused ? `${m} (healing paused)` : m, env)}`);
  if (!facts.stopped && !facts.busy) await healthchecksPing(env, Object.keys(d.firing).length > 0, d.summary);
  if (stateFile) {
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, `${JSON.stringify(d.state, null, 1)}\n`);
  }
  return d;
}

/** `beta.sh status` lines: containers, tunnel, last watchdog round. */
export function summaryLines(cs, state, now, opts = {}) {
  const lines = [];
  const running = cs.filter((c) => !c.oneoff && LONG_RUNNING.has(c.restartPolicy));
  if (!cs.length) lines.push(["FAIL", "containers: none (scripts/beta.sh up)"]);
  else {
    const up = running.filter((c) => c.state === "running");
    const bad = running.filter((c) => c.state !== "running" || c.health === "unhealthy");
    const starting = running.filter((c) => c.health === "starting").map((c) => c.service);
    const healthy = up.filter((c) => c.health === "healthy").length;
    const none = up.filter((c) => !c.health).length;
    const desc = `${up.length}/${running.length} running, ${healthy} healthy${none ? `, ${none} without a health check` : ""}`;
    if (bad.length) lines.push(["FAIL", `containers: ${desc}; problems: ${bad.map((c) => `${c.service} (${c.state === "running" ? c.health : c.state})`).join(", ")}`]);
    else lines.push([starting.length ? "warn" : "ok", `containers: ${desc}${starting.length ? `; starting: ${starting.join(", ")}` : ""}`]);
  }
  const cf = running.find((c) => c.service === "cloudflared");
  if (!cf) lines.push(["FAIL", "tunnel: no cloudflared container"]);
  else if (cf.state !== "running") lines.push(["FAIL", `tunnel: cloudflared is ${cf.state}`]);
  else if (cf.health === "healthy") lines.push(["ok", "tunnel: cloudflared connected to Cloudflare (healthy)"]);
  else lines.push([cf.health === "starting" ? "warn" : "FAIL", `tunnel: cloudflared ${cf.health ?? "running (no health check yet: run beta.sh up)"}`]);
  const ah = running.find((c) => c.service === "autoheal");
  if (!ah) lines.push(["warn", "autoheal: not running (scripts/beta.sh up starts it)"]);
  else lines.push([ah.state === "running" && ah.health !== "unhealthy" ? "ok" : "FAIL", `autoheal: ${ah.state}${ah.health ? ` (${ah.health})` : ""}`]);
  if (!state?.lastRun) lines.push(["warn", `watchdog: has not run yet${opts.installed ? "" : " (scripts/beta.sh install-autostart)"}`]);
  else {
    const age = Math.round((now - state.lastRun) / 1000);
    const ago = age < 120 ? `${age} s ago` : `${Math.round(age / 60)} min ago`;
    const stale = opts.installed && age > 300;
    const ok = !stale && /^(ok|idle|waiting)/.test(state.lastSummary ?? "");
    lines.push([ok ? "ok" : stale ? "FAIL" : "warn", `watchdog: last round ${new Date(state.lastRun).toISOString().slice(0, 16).replace("T", " ")} UTC (${ago})${stale ? " — launchd has stopped running it" : ""}: ${state.lastSummary}`]);
  }
  return lines;
}

async function summary(env = process.env) {
  let cs = [];
  try { cs = await containers(env.NP_WD_PROJECT ?? "nearpay-beta"); } catch { /* Docker down: reported as no containers */ }
  const state = readJson(env.NP_WD_STATE, null);
  for (const [k, t] of summaryLines(cs, state, Date.now(), { installed: env.NP_WD_INSTALLED === "1" })) process.stdout.write(`${k}\t${t}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cmd = process.argv[2];
  const p = cmd === "run" ? runOnce().then((d) => process.exit(Object.keys(d.firing).length ? 1 : 0)) : cmd === "summary" ? summary() : null;
  if (!p) {
    process.stderr.write("usage: watchdog.mjs run|summary (normally through scripts/beta.sh watchdog / status)\n");
    process.exit(2);
  }
  p.catch((e) => {
    process.stderr.write(`watchdog: ${e.message}\n`);
    process.exit(3);
  });
}
