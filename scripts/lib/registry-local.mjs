#!/usr/bin/env node
/**
 * Helpers of scripts/registry.sh, the Docker-free local package registry (Verdaccio run with Node only).
 * Everything here is Node built-ins, so the script needs nothing but Node 22.
 *
 *   registry-local.mjs ping <registry-url>                    exit 0 when the registry answers /-/ping
 *   registry-local.mjs config <compose-config> <out-file>     the Compose config with paths next to <out-file>
 *   registry-local.mjs password <file>                        create the registry password unless it exists
 *   registry-local.mjs status <registry-url> <seed-dir>       prints "<packages> <versions> <missing> <total>"
 *   registry-local.mjs spawn <log-file> <cwd> <cmd> [args…]   start a detached process, print its pid
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** Only this machine's registry is ever probed or seeded (same rule as registry-seed.mjs). */
export function localRegistry(url) {
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url ?? "")) {
    throw new Error(`${url}: only a local registry (http://127.0.0.1:<port>) is allowed`);
  }
  return url;
}

/**
 * The Compose registry's config (compose/registry/config.yaml) for a Verdaccio that runs on the host: the container
 * paths under /verdaccio/ become paths relative to the config file (Verdaccio resolves them against its directory),
 * so storage, htpasswd and plugins live next to it. Every other line (scopes, access rules) stays as it is.
 */
export function deriveConfig(text) {
  const wanted = { storage: "./storage/data", plugins: "./plugins", file: "./storage/htpasswd" };
  const seen = new Set();
  const out = text
    .split("\n")
    .map((line) => {
      const m = line.match(/^(\s*)(storage|plugins|file):\s*\/verdaccio\/(\S+)\s*$/);
      if (!m) return line;
      const [, indent, key, rest] = m;
      const value = `./${rest}`;
      if (value !== wanted[key]) throw new Error(`unexpected ${key} path /verdaccio/${rest} in the registry config`);
      seen.add(key);
      return `${indent}${key}: ${value}`;
    })
    .join("\n");
  for (const key of Object.keys(wanted)) {
    if (!seen.has(key)) throw new Error(`the registry config has no "${key}: /verdaccio/…" line to rewrite`);
  }
  if (out.includes("/verdaccio/")) throw new Error("the registry config still names a container path (/verdaccio/…)");
  return out;
}

/**
 * The registry password: created like `scripts/seed.sh keys` does (seed-keys.mjs: 24 random bytes as hex, file 0644
 * in a 0700 directory) and never overwritten, so either script can run first. Returns true when it wrote the file.
 */
export function ensurePassword(file) {
  if (existsSync(file) && readFileSync(file, "utf8").trim() !== "") return false;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, randomBytes(24).toString("hex"));
  chmodSync(file, 0o644);
  return true;
}

/** SHA512SUMS lines → { name, version, integrity } (the integrity string npm and the lockfiles record). */
export function seedEntries(sums) {
  return sums
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [hex, rel] = line.split(/\s+/);
      const m = rel?.match(/^\.\/(@[^/]+\/[^/]+)\/[^/]+-(\d+\.\d+\.\d+)\.tgz$/);
      if (!m || !/^[0-9a-f]{128}$/.test(hex)) throw new Error(`unexpected seed entry: ${line}`);
      return { name: m[1], version: m[2], integrity: `sha512-${Buffer.from(hex, "hex").toString("base64")}` };
    });
}

/**
 * Compares the seed with what the registry serves. `packuments` maps a package name to its registry document
 * (or undefined when the registry does not have it). A version counts only with the seed's exact bytes.
 */
export function compareSeed(entries, packuments) {
  const names = new Set(entries.map((e) => e.name));
  const missing = entries.filter((e) => packuments[e.name]?.versions?.[e.version]?.dist?.integrity !== e.integrity);
  const incomplete = new Set(missing.map((e) => e.name));
  return {
    packages: names.size - incomplete.size,
    versions: entries.length - missing.length,
    missing: missing.length,
    total: entries.length,
  };
}

async function packument(registry, name) {
  const res = await fetch(`${registry}/${name.replace("/", "%2f")}`, { signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`registry lookup ${name}: HTTP ${res.status}`);
  return res.json();
}

export async function seedStatus(registry, seedDir) {
  const entries = seedEntries(readFileSync(join(seedDir, "SHA512SUMS"), "utf8"));
  const names = [...new Set(entries.map((e) => e.name))];
  const docs = await Promise.all(names.map((name) => packument(registry, name)));
  return compareSeed(entries, Object.fromEntries(names.map((name, i) => [name, docs[i]])));
}

export async function ping(registry) {
  try {
    const res = await fetch(`${registry}/-/ping`, { signal: AbortSignal.timeout(3_000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Starts a process in its own session (it outlives the calling shell on Linux and macOS alike). */
export function spawnDetached(logFile, cwd, cmd, args) {
  const log = openSync(logFile, "a");
  const child = spawn(cmd, args, { cwd, detached: true, stdio: ["ignore", log, log] });
  child.unref();
  return child.pid;
}

async function main([cmd, ...args]) {
  switch (cmd) {
    case "ping":
      process.exitCode = (await ping(localRegistry(args[0]))) ? 0 : 1;
      return;
    case "config":
      writeFileSync(args[1], deriveConfig(readFileSync(args[0], "utf8")));
      return;
    case "password":
      ensurePassword(args[0]);
      return;
    case "status": {
      const s = await seedStatus(localRegistry(args[0]), args[1]);
      console.log(`${s.packages} ${s.versions} ${s.missing} ${s.total}`);
      return;
    }
    case "spawn": {
      const [logFile, cwd, bin, ...rest] = args;
      if (!bin) throw new Error("usage: registry-local.mjs spawn <log-file> <cwd> <cmd> [args…]");
      console.log(spawnDetached(logFile, cwd, bin, rest));
      return;
    }
    default:
      throw new Error("usage: registry-local.mjs ping|config|password|status|spawn … (see the file header)");
  }
}

// Run as a program (not imported by a test). Node resolves symlinks for import.meta.url but not for argv[1], so
// compare real paths: a checkout under a symlinked directory (macOS /tmp) must not turn every command into a no-op.
const invoked = process.argv[1] && existsSync(process.argv[1]) ? pathToFileURL(realpathSync(process.argv[1])).href : "";
if (import.meta.url === invoked) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`registry: ${err.message}`);
    process.exit(1);
  });
}
