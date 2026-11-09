#!/usr/bin/env node
// Checks the hand-written gateway routers (compose/traefik/dynamic/routes.yaml) against the spec's PUBLIC_ROUTES
// (lld/platform.md §1 "Traefik routing"): every public route, on api.<domain> and under /api on pay.<domain> and
// dashboard.<domain>, must reach the service that owns it (the matching router with the highest priority wins, as in
// Traefik), and the anonymous routes the gateway limits per IP (GATEWAY_LIMITED: hosted payment-link and invoice pages,
// CLI login start/poll, sentinel attestations) must hit a router with a rate-limit middleware.
//
//   node scripts/lib/public-routes.mjs [<@nearpay/spec public entry>]
//
// The entry defaults to ../nearpay-spec/packages/spec-public/dist/public-entry.js (a built spec checkout). Exits 1 and
// lists the routes that would be misrouted. Only the rule matchers routes.yaml uses are understood (Host, Path,
// PathPrefix, PathRegexp, Method, &&, ||, parentheses).
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const deploy = resolve(here, "../..");
const entry = resolve(
  process.argv[2] ?? join(deploy, "../nearpay-spec/packages/spec-public/dist/public-entry.js"),
);
const spec = await import(pathToFileURL(entry).href);
const domain = "nearpay.localhost";

// ---- a minimal reader for the routers block of routes.yaml (one router = name + entryPoints/rule/priority/…) ----
const text = readFileSync(join(deploy, "compose/traefik/dynamic/routes.yaml"), "utf8");
const routersBlock = text.split(/^ {2}routers:\n/m)[1].split(/^ {2}middlewares:\n/m)[0];
const routers = [];
let cur = null;
for (const line of routersBlock.split("\n")) {
  const name = line.match(/^ {4}([a-z0-9-]+):\s*$/);
  if (name) {
    cur = { name: name[1], priority: 0, middlewares: [] };
    routers.push(cur);
    continue;
  }
  const kv = line.match(/^ {6}([a-zA-Z]+):\s*(.*)$/);
  if (!cur || !kv) continue;
  const [, k, v] = kv;
  if (k === "rule") cur.rule = v.replace(/^'|'$/g, "").replaceAll("{{ $d }}", domain);
  if (k === "priority") cur.priority = Number(v);
  if (k === "service") cur.service = v.trim();
  if (k === "middlewares") cur.middlewares = v.replace(/[[\]\s]/g, "").split(",").filter(Boolean);
  if (k === "entryPoints") cur.entryPoints = v.replace(/[[\]\s]/g, "").split(",");
}

// gateway service → the NearPay service behind it (`url: http://<svc>-api:8080`)
const owners = new Map();
let svc = null;
for (const line of text.split(/^ {2}services:\n/m)[1].split("\n")) {
  const name = line.match(/^ {4}([a-z0-9-]+):\s*$/);
  if (name) svc = name[1];
  const url = line.match(/url: http:\/\/([a-z0-9]+)-api:8080/);
  if (svc && url) owners.set(svc, url[1]);
}
for (const r of routers) r.owner = owners.get(r.service) ?? r.service;

// ---- rule evaluation: translate matchers into JS calls on the request ----
function compile(rule) {
  const js = rule.replace(/(Host|PathPrefix|PathRegexp|Path|Method)\(`([^`]*)`\)/g, (_, fn, arg) => `m.${fn}(${JSON.stringify(arg)})`);
  if (/[^\sm.()&|!"\w,:/\\^$[\]+*?{}<>.-]/.test(js.replace(/"(?:[^"\\]|\\.)*"/g, '""'))) throw new Error(`unsupported rule: ${rule}`);
  return new Function("m", `return (${js});`);
}
for (const r of routers) r.match = r.rule ? compile(r.rule) : () => false;

const route = (req) => {
  const m = {
    Host: (h) => req.host === h,
    Path: (p) => req.path === p,
    PathPrefix: (p) => req.path.startsWith(p),
    PathRegexp: (re) => new RegExp(re).test(req.path),
    Method: (x) => req.method === x,
  };
  const hits = routers.filter((r) => (r.entryPoints ?? ["websecure"]).includes("websecure") && r.match(m));
  // Traefik: highest priority wins; equal priorities fall back to the longer rule
  hits.sort((a, b) => b.priority - a.priority || b.rule.length - a.rule.length);
  return hits[0] ?? null;
};

const sample = (path) => path.replace(/\{[a-z_]+\}/g, (p) => (p === "{code}" ? "ABCD-EFGH" : "x_1"));
const anonymous = new Set(spec.PUBLIC_ANONYMOUS_ROUTES.map((r) => `${r.method} ${r.path}`));
const GATEWAY_LIMITED = [/^\/v1\/payment_links\/\{id\}\/public/, /^\/v1\/invoices\/\{id\}\/public/, /^\/v1\/cli\/logins/, /^\/v1\/attestations\//];
const limited = (r) => anonymous.has(`${r.method} ${r.path}`) && GATEWAY_LIMITED.some((re) => re.test(r.path));
const problems = [];
let checked = 0;
for (const r of spec.PUBLIC_ROUTES) {
  const path = sample(r.path);
  for (const [host, p] of [
    [`api.${domain}`, path],
    [`pay.${domain}`, `/api${path}`],
    [`dashboard.${domain}`, `/api${path}`],
  ]) {
    checked++;
    const hit = route({ host, path: p, method: r.method });
    if (!hit) problems.push(`${r.method} ${host}${p} (${r.id}): no router (owner ${r.service})`);
    else if (hit.owner !== r.service)
      problems.push(`${r.method} ${host}${p} (${r.id}): router ${hit.name} → ${hit.owner}, owner ${r.service}`);
    else if (limited(r) && !hit.middlewares.some((x) => x.endsWith("ratelimit")))
      problems.push(`${r.method} ${host}${p} (${r.id}): anonymous route without a per-IP limit (router ${hit.name})`);
  }
}
const version = JSON.parse(readFileSync(join(dirname(entry), "../package.json"), "utf8")).version;
if (problems.length) {
  for (const p of problems) console.error(`public-routes: ${p}`);
  console.error(`public-routes: ${problems.length} problem(s) against @nearpay/spec ${version}`);
  process.exit(1);
}
console.log(`public-routes: ${spec.PUBLIC_ROUTES.length} routes × 3 hosts (${checked}) routed to their owners (@nearpay/spec ${version})`);
