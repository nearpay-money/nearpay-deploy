// scripts/lib/registry-local.mjs, the helpers of scripts/registry.sh (the Docker-free local package registry).
//   node --test scripts/test/        (the start → install → stop run is scripts/test/registry-integration.sh)
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  compareSeed,
  deriveConfig,
  ensurePassword,
  localRegistry,
  ping,
  seedEntries,
  seedStatus,
  spawnDetached,
} from "../lib/registry-local.mjs";

const deploy = join(dirname(fileURLToPath(import.meta.url)), "../..");
const lib = join(deploy, "scripts/lib/registry-local.mjs");
const run = promisify(execFile);
const tmp = mkdtempSync(join(tmpdir(), "nearpay-registry-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const SUMS = readFileSync(join(deploy, "registry-seed/SHA512SUMS"), "utf8");

/** A stand-in registry: /-/ping and one document per package, built from the seed minus `drop` (name@version). */
async function fakeRegistry(entries, drop = []) {
  const docs = {};
  for (const e of entries) {
    if (drop.includes(`${e.name}@${e.version}`)) continue;
    docs[e.name] ??= { name: e.name, versions: {} };
    docs[e.name].versions[e.version] = { dist: { integrity: e.integrity } };
  }
  const server = createServer((req, res) => {
    const doc = docs[decodeURIComponent(req.url.slice(1))];
    if (req.url === "/-/ping") return res.end("{}");
    if (!doc) return res.writeHead(404).end("{}");
    res.end(JSON.stringify(doc));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test("the derived config is the Compose config with paths next to the config file", () => {
  const source = readFileSync(join(deploy, "compose/registry/config.yaml"), "utf8");
  const derived = deriveConfig(source);
  const changed = source.split("\n").flatMap((line, i) => (line === derived.split("\n")[i] ? [] : [derived.split("\n")[i].trim()]));
  assert.deepEqual(changed, ["storage: ./storage/data", "plugins: ./plugins", "file: ./storage/htpasswd"]);
  assert.equal(derived.split("\n").length, source.split("\n").length);
  // the access rules are untouched: NearPay scopes local-only, publishing needs a login, no uplink
  assert.match(derived, /"@nearpay-money\/\*":\n\s+access: \$all\n\s+publish: \$authenticated/);
  assert.doesNotMatch(derived, /^uplinks:|^\s+proxy:/m);
});

test("a config with an unknown container path, or without one of the three, is refused", () => {
  assert.throws(() => deriveConfig("storage: /verdaccio/elsewhere\nplugins: /verdaccio/plugins\n"), /unexpected storage path/);
  assert.throws(() => deriveConfig("storage: /verdaccio/storage/data\nplugins: /verdaccio/plugins\n"), /no "file:/);
  const ok = "storage: /verdaccio/storage/data\nplugins: /verdaccio/plugins\nauth:\n  htpasswd:\n    file: /verdaccio/storage/htpasswd\n";
  assert.throws(() => deriveConfig(`${ok}extra: [/verdaccio/x]\n`), /still names a container path/);
});

test("registry.sh pins the Verdaccio version of the Compose service", () => {
  const image = readFileSync(join(deploy, "compose/compose.local.yaml"), "utf8").match(/image: verdaccio\/verdaccio:(\S+)/)[1];
  const pinned = readFileSync(join(deploy, "scripts/registry.sh"), "utf8").match(/^VERDACCIO_VERSION=(\S+)/m)[1];
  assert.equal(pinned, image);
});

test("the composite action runs this repository's scripts/registry.sh", () => {
  const action = readFileSync(join(deploy, ".github/actions/registry/action.yml"), "utf8");
  assert.match(action, /using: composite/);
  const rel = action.match(/\$GITHUB_ACTION_PATH\/(\S+?registry\.sh)/)[1];
  assert.equal(join(deploy, ".github/actions/registry", rel), join(deploy, "scripts/registry.sh"));
  assert.ok(statSync(join(deploy, "scripts/registry.sh")).mode & 0o111, "scripts/registry.sh is executable");
});

test("the password is created like seed.sh keys creates it and never overwritten", () => {
  const file = join(tmp, "secrets/registry_password");
  assert.equal(ensurePassword(file), true);
  const first = readFileSync(file, "utf8");
  assert.match(first, /^[0-9a-f]{48}$/);
  assert.equal(statSync(dirname(file)).mode & 0o777, 0o700);
  assert.equal(ensurePassword(file), false);
  assert.equal(readFileSync(file, "utf8"), first);
});

test("seed entries carry the integrity the lockfiles record", () => {
  const entries = seedEntries(SUMS);
  assert.equal(entries.length, SUMS.trim().split("\n").length);
  const spec = entries.find((e) => e.name === "@nearpay-money/spec" && e.version === "0.5.0");
  const bytes = readFileSync(join(deploy, "registry-seed/@nearpay-money/spec/spec-0.5.0.tgz"));
  assert.equal(spec.integrity, `sha512-${createHash("sha512").update(bytes).digest("base64")}`);
  assert.throws(() => seedEntries("abc  ./@nearpay-money/spec/spec-0.5.0.tgz\n"), /unexpected seed entry/);
  assert.throws(() => seedEntries(`${"a".repeat(128)}  ./spec-0.5.0.tgz\n`), /unexpected seed entry/);
});

test("a version counts only with the seed's bytes; a package only when all its versions are there", () => {
  const entries = [
    { name: "@a/x", version: "1.0.0", integrity: "sha512-one" },
    { name: "@a/x", version: "1.1.0", integrity: "sha512-two" },
    { name: "@a/y", version: "1.0.0", integrity: "sha512-three" },
  ];
  const doc = (versions) => ({ versions: Object.fromEntries(versions.map(([v, i]) => [v, { dist: { integrity: i } }])) });
  const x = doc([["1.0.0", "sha512-one"], ["1.1.0", "sha512-two"]]);
  assert.deepEqual(compareSeed(entries, { "@a/x": x, "@a/y": doc([["1.0.0", "sha512-three"]]) }), { packages: 2, versions: 3, missing: 0, total: 3 });
  assert.deepEqual(compareSeed(entries, { "@a/x": x }), { packages: 1, versions: 2, missing: 1, total: 3 });
  // same version, other bytes (built locally): missing, so `start` runs the seed, which replaces it
  assert.deepEqual(compareSeed(entries, { "@a/x": x, "@a/y": doc([["1.0.0", "sha512-other"]]) }), { packages: 1, versions: 2, missing: 1, total: 3 });
  assert.deepEqual(compareSeed(entries, {}), { packages: 0, versions: 0, missing: 3, total: 3 });
});

test("status reads a registry: complete, then with one version missing", async () => {
  const entries = seedEntries(SUMS);
  const names = new Set(entries.map((e) => e.name)).size;
  const full = await fakeRegistry(entries);
  assert.equal(await ping(full), true);
  assert.deepEqual(await seedStatus(full, join(deploy, "registry-seed")), { packages: names, versions: entries.length, missing: 0, total: entries.length });
  const { stdout } = await run(process.execPath, [lib, "status", full, join(deploy, "registry-seed")]);
  assert.equal(stdout, `${names} ${entries.length} 0 ${entries.length}\n`);

  const partial = await fakeRegistry(entries, ["@nearpay-money/spec@0.5.0"]);
  assert.deepEqual(await seedStatus(partial, join(deploy, "registry-seed")), {
    packages: names - 1,
    versions: entries.length - 1,
    missing: 1,
    total: entries.length,
  });
});

test("ping fails on a closed port and the CLI refuses a registry that is not local", async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await ping(`http://127.0.0.1:${port}`), false);
  await assert.rejects(run(process.execPath, [lib, "ping", `http://127.0.0.1:${port}`]), (err) => err.code === 1);
  assert.throws(() => localRegistry("https://registry.npmjs.org"), /only a local registry/);
  assert.equal(localRegistry("http://127.0.0.1:4873"), "http://127.0.0.1:4873");
  await assert.rejects(run(process.execPath, [lib, "status", "https://registry.npmjs.org", join(deploy, "registry-seed")]), /only a local registry/);
});

test("spawn starts a process that outlives its parent and logs to the file", async () => {
  const log = join(tmp, "spawn.log");
  const done = join(tmp, "spawn.done");
  const child = `setTimeout(() => { console.log("hello from the child"); require("node:fs").writeFileSync(${JSON.stringify(done)}, String(process.pid)); }, 300)`;
  // through the CLI: that process has exited long before the child writes its file
  const { stdout } = await run(process.execPath, [lib, "spawn", log, tmp, process.execPath, "-e", child]);
  const pid = Number(stdout.trim());
  assert.ok(pid > 0);
  for (let i = 0; i < 50 && !readFileSync(log, "utf8").includes("hello"); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(readFileSync(done, "utf8"), String(pid));
  assert.match(readFileSync(log, "utf8"), /hello from the child/);
  writeFileSync(log, "");
  assert.ok(spawnDetached(log, tmp, process.execPath, ["-e", ""]) > 0);
});
