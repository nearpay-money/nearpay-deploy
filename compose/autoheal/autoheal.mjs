// Autoheal for the beta stack (compose.beta.yaml `autoheal`): Docker marks a container "unhealthy" when its
// HEALTHCHECK keeps failing but never restarts it. This loop restarts containers of its own Compose project that stay
// unhealthy, with a per-container backoff and a global rate limit, and exports Prometheus metrics so every restart
// reaches Telegram (rules/uptime.yml: ContainerAutoHealed, ContainerUnhealthy, AutohealHeld).
//
// Liveness only: Docker's health status comes from each image's liveness check (NearPay services: GET /healthz, which
// does not look at dependencies). A Postgres or NATS outage makes services *not ready* (/readyz), never unhealthy, so
// it cannot trigger a restart storm. When many containers turn unhealthy at once the machine itself is overloaded
// (health checks time out on a saturated CPU, lld/platform.md §1.4 "Health checks"): restarting would make it worse,
// so autoheal holds and alerts instead.
//
// Runs on the distroless Node image the services are built on (no extra image, no npm dependencies). It talks to the
// Docker API over the socket: list containers, inspect itself, restart. Opt a container out with the label
// money.nearpay.autoheal=false (Postgres: restarted only by Docker's restart policy or by hand).
import http from "node:http";
import { hostname } from "node:os";
import { pathToFileURL } from "node:url";

export const DEFAULTS = Object.freeze({
  intervalMs: 15_000,
  graceMs: 60_000, // unhealthy this long (on top of Docker's own retries) before the first restart
  backoffBaseMs: 120_000, // per container: 2, 4, 8, 16, 30 min between restarts of the same container
  backoffMaxMs: 1_800_000,
  resetAfterMs: 600_000, // healthy for 10 min: the container's backoff starts over
  windowMs: 600_000, // at most maxRestartsPerWindow restarts in any 10 min, all containers together
  maxRestartsPerWindow: 3,
  massMin: 4, // this many unhealthy at once, and at least massFraction of all checked containers:
  massFraction: 0.5, // the machine is the problem, not the containers → hold
});

export const OPT_OUT_LABEL = "money.nearpay.autoheal";

export function emptyMemory() {
  return { seen: {}, last: {}, healthySince: {}, recent: [] };
}

export function backoffMs(restarts, o = DEFAULTS) {
  if (restarts <= 0) return 0;
  return Math.min(o.backoffBaseMs * 2 ** (restarts - 1), o.backoffMaxMs);
}

/** "Up 5 minutes (unhealthy)" → "unhealthy"; no health check → null. */
export function healthFromStatus(status) {
  const m = /\((healthy|unhealthy|health: starting)\)/.exec(status ?? "");
  if (!m) return null;
  return m[1] === "health: starting" ? "starting" : m[1];
}

/**
 * Which containers to restart now.
 * containers: [{ name, health: "healthy" | "unhealthy" | "starting" | null, optOut: boolean }] (running ones)
 * Returns { restart: [name], held: { reason: count }, unhealthy: [name], memory } — memory is the next state.
 */
export function decide(containers, memory, now, o = DEFAULTS) {
  const next = {
    seen: {},
    last: { ...memory.last },
    healthySince: {},
    recent: memory.recent.filter((t) => now - t < o.windowMs),
  };
  const checked = containers.filter((c) => c.health);
  const unhealthy = checked.filter((c) => c.health === "unhealthy");
  for (const c of checked) {
    if (c.health === "unhealthy") next.seen[c.name] = memory.seen[c.name] ?? now;
    if (c.health === "healthy") {
      next.healthySince[c.name] = memory.healthySince[c.name] ?? now;
      if (now - next.healthySince[c.name] >= o.resetAfterMs) delete next.last[c.name];
    }
  }
  const held = {};
  const restart = [];
  const names = unhealthy.map((c) => c.name).sort();
  if (unhealthy.length >= o.massMin && unhealthy.length >= checked.length * o.massFraction) {
    held.mass_unhealthy = 1;
    return { restart, held, unhealthy: names, memory: next };
  }
  for (const c of [...unhealthy].sort((a, b) => next.seen[a.name] - next.seen[b.name] || a.name.localeCompare(b.name))) {
    if (c.optOut) { held.opt_out = (held.opt_out ?? 0) + 1; continue; }
    if (now - next.seen[c.name] < o.graceMs) continue;
    const last = next.last[c.name];
    if (last && now - last.at < backoffMs(last.count, o)) { held.backoff = (held.backoff ?? 0) + 1; continue; }
    if (next.recent.length >= o.maxRestartsPerWindow) { held.rate_limited = (held.rate_limited ?? 0) + 1; continue; }
    restart.push(c.name);
    next.recent.push(now);
    next.last[c.name] = { at: now, count: (last?.count ?? 0) + 1 };
  }
  return { restart, held, unhealthy: names, memory: next };
}

// ---- metrics ------------------------------------------------------------------------------------------------------
export function renderMetrics(m) {
  const esc = (v) => String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
  const out = [
    "# HELP nearpay_autoheal_restarts_total Containers autoheal restarted because they stayed unhealthy.",
    "# TYPE nearpay_autoheal_restarts_total counter",
  ];
  for (const [c, n] of Object.entries(m.restarts)) out.push(`nearpay_autoheal_restarts_total{container="${esc(c)}"} ${n}`);
  out.push("# HELP nearpay_autoheal_restart_failures_total Restarts the Docker API refused or that timed out.");
  out.push("# TYPE nearpay_autoheal_restart_failures_total counter");
  for (const [c, n] of Object.entries(m.failures)) out.push(`nearpay_autoheal_restart_failures_total{container="${esc(c)}"} ${n}`);
  out.push("# HELP nearpay_autoheal_unhealthy 1 for each container Docker currently marks unhealthy.");
  out.push("# TYPE nearpay_autoheal_unhealthy gauge");
  for (const c of m.unhealthy) out.push(`nearpay_autoheal_unhealthy{container="${esc(c)}"} 1`);
  out.push("# HELP nearpay_autoheal_containers Running containers of the project by health status.");
  out.push("# TYPE nearpay_autoheal_containers gauge");
  for (const [h, n] of Object.entries(m.byHealth)) out.push(`nearpay_autoheal_containers{health="${esc(h)}"} ${n}`);
  out.push("# HELP nearpay_autoheal_held 1 while autoheal holds back a restart (mass_unhealthy, rate_limited, backoff, opt_out).");
  out.push("# TYPE nearpay_autoheal_held gauge");
  for (const r of ["mass_unhealthy", "rate_limited", "backoff", "opt_out"]) out.push(`nearpay_autoheal_held{reason="${r}"} ${m.held[r] ? 1 : 0}`);
  out.push("# HELP nearpay_autoheal_docker_errors_total Docker API errors while listing containers.");
  out.push("# TYPE nearpay_autoheal_docker_errors_total counter");
  out.push(`nearpay_autoheal_docker_errors_total ${m.dockerErrors}`);
  out.push("# HELP nearpay_autoheal_last_loop_timestamp_seconds When the last loop finished.");
  out.push("# TYPE nearpay_autoheal_last_loop_timestamp_seconds gauge");
  out.push(`nearpay_autoheal_last_loop_timestamp_seconds ${Math.floor(m.lastLoop / 1000)}`);
  return `${out.join("\n")}\n`;
}

// ---- Docker API over the socket -----------------------------------------------------------------------------------
function dockerApi(socketPath, method, path, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path, method, timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        if (res.statusCode >= 300) return reject(new Error(`docker ${method} ${path.split("?")[0]}: HTTP ${res.statusCode}`));
        try { resolve(body ? JSON.parse(body) : null); } catch { resolve(null); }
      });
    });
    req.on("timeout", () => req.destroy(new Error(`docker ${method} ${path.split("?")[0]}: timeout`)));
    req.on("error", reject);
    req.end();
  });
}

const log = (msg, fields = {}) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), msg, ...fields })}\n`);

async function main() {
  const socketPath = process.env.NP_AUTOHEAL_DOCKER_SOCKET ?? "/var/run/docker.sock";
  const port = Number(process.env.NP_AUTOHEAL_PORT ?? 9464);
  const o = { ...DEFAULTS };
  for (const [k, env] of [["intervalMs", "NP_AUTOHEAL_INTERVAL_MS"], ["graceMs", "NP_AUTOHEAL_GRACE_MS"]]) {
    if (process.env[env]) o[k] = Number(process.env[env]);
  }
  let self = hostname();
  let project = process.env.NP_AUTOHEAL_PROJECT ?? "";
  try {
    const me = await dockerApi(socketPath, "GET", `/containers/${encodeURIComponent(self)}/json`);
    self = me.Name.replace(/^\//, "");
    project ||= me.Config.Labels["com.docker.compose.project"] ?? "";
  } catch (e) {
    log("self-inspect failed", { error: e.message });
  }
  project ||= "nearpay-beta";
  log("autoheal started", { project, interval_s: o.intervalMs / 1000, grace_s: o.graceMs / 1000 });

  const metrics = { restarts: {}, failures: {}, unhealthy: [], byHealth: {}, held: {}, dockerErrors: 0, lastLoop: 0 };
  let lastOk = 0;
  http
    .createServer((req, res) => {
      if (req.url === "/metrics") {
        res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
        return res.end(renderMetrics(metrics));
      }
      if (req.url === "/healthz") {
        const ok = Date.now() - lastOk < o.intervalMs * 4 + 60_000;
        res.writeHead(ok ? 200 : 503, { "content-type": "text/plain" });
        return res.end(ok ? "ok\n" : "loop stalled\n");
      }
      res.writeHead(404).end();
    })
    .listen(port, "0.0.0.0");

  let memory = emptyMemory();
  let lastHeld = "";
  const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${project}`], status: ["running"] }));
  for (;;) {
    const started = Date.now();
    try {
      const list = await dockerApi(socketPath, "GET", `/containers/json?filters=${filters}`, 30_000);
      const containers = list
        .map((c) => ({
          id: c.Id,
          name: (c.Names?.[0] ?? c.Id).replace(/^\//, ""),
          health: healthFromStatus(c.Status),
          optOut: c.Labels?.[OPT_OUT_LABEL] === "false",
        }))
        .filter((c) => c.name !== self);
      // counters start at 0 for every container, so the first restart is an increase Prometheus can see
      for (const c of containers) if (c.health) metrics.restarts[c.name] ??= 0;
      const d = decide(containers, memory, Date.now(), o);
      memory = d.memory;
      metrics.unhealthy = d.unhealthy;
      metrics.held = d.held;
      metrics.byHealth = {};
      for (const c of containers) metrics.byHealth[c.health ?? "none"] = (metrics.byHealth[c.health ?? "none"] ?? 0) + 1;
      const heldKey = Object.keys(d.held).sort().join(",");
      if (heldKey !== lastHeld) {
        if (heldKey) log("holding restarts", { held: d.held, unhealthy: d.unhealthy });
        lastHeld = heldKey;
      }
      for (const name of d.restart) {
        const c = containers.find((x) => x.name === name);
        const attempt = memory.last[name]?.count;
        log("restarting unhealthy container", { container: name, unhealthy_for_s: Math.round((Date.now() - memory.seen[name]) / 1000), attempt });
        try {
          // no ?t=: Docker uses the container's own stop timeout (35 s for NearPay services, which drain first)
          await dockerApi(socketPath, "POST", `/containers/${c.id}/restart`, 120_000);
          metrics.restarts[name] = (metrics.restarts[name] ?? 0) + 1;
          log("restarted", { container: name, attempt });
        } catch (e) {
          metrics.failures[name] = (metrics.failures[name] ?? 0) + 1;
          log("restart failed", { container: name, error: e.message });
        }
      }
      lastOk = Date.now();
    } catch (e) {
      metrics.dockerErrors += 1;
      log("docker API error", { error: e.message });
    }
    metrics.lastLoop = Date.now();
    await new Promise((r) => setTimeout(r, Math.max(1_000, o.intervalMs - (Date.now() - started))));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    log("autoheal crashed", { error: e.message });
    process.exit(1);
  });
}
