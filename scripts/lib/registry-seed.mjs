#!/usr/bin/env node
/**
 * Seeds the local package registry with the exact @nearpay/* and @nearpay-internal/* tarballs that the repos'
 * lockfiles were resolved against (`registry-seed/`, checked by SHA512SUMS).
 *
 * Why: the repos pin older contract versions too (nearpay-kit 0.1.2 depends on spec 0.1.1), and lockfiles record
 * each tarball's sha512. Rebuilding packages from source on a fresh machine cannot publish old versions, and a
 * rebuilt tarball's bytes need not match the recorded integrity, so `pnpm install --frozen-lockfile` fails. Publishing
 * the recorded tarballs as-is (npm uploads a tarball byte for byte) makes a clean checkout install.
 *
 * Usage: node scripts/lib/registry-seed.mjs <registry-url> <seed-dir> <password-file>
 * A version already in the registry with different bytes (e.g. built locally before this seed existed) is
 * unpublished and replaced by the seed tarball. Only a local registry is accepted.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [registry, seedDir, passwordFile] = process.argv.slice(2);
if (!registry || !seedDir || !passwordFile) {
  console.error("usage: registry-seed.mjs <registry-url> <seed-dir> <password-file>");
  process.exit(2);
}
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(registry)) {
  console.error(`refusing to seed ${registry}: only a local registry (127.0.0.1/localhost) is allowed`);
  process.exit(2);
}
const user = process.env.NP_REGISTRY_USER ?? "nearpay-local";
const password = readFileSync(passwordFile, "utf8").trim();
const npmEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_config_/i.test(k)));

async function token() {
  const url = `${registry}/-/user/org.couchdb.user:${encodeURIComponent(user)}`;
  const body = JSON.stringify({ name: user, password });
  const headers = { "content-type": "application/json" };
  let res = await fetch(url, { method: "PUT", headers, body });
  if (res.status === 409) {
    const basic = Buffer.from(`${user}:${password}`).toString("base64");
    res = await fetch(url, { method: "PUT", headers: { ...headers, authorization: `Basic ${basic}` }, body });
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.token) throw new Error(`registry login failed (${res.status})`);
  return json.token;
}

function seedEntries() {
  return readFileSync(join(seedDir, "SHA512SUMS"), "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const [hex, rel] = line.trim().split(/\s+/);
      const m = rel.match(/^\.\/(@[^/]+\/[^/]+)\/[^/]+-(\d+\.\d+\.\d+)\.tgz$/);
      if (!m) throw new Error(`unexpected seed entry: ${rel}`);
      const bytes = readFileSync(join(seedDir, rel));
      if (createHash("sha512").update(bytes).digest("hex") !== hex) throw new Error(`${rel}: sha512 does not match SHA512SUMS`);
      return { file: join(seedDir, rel), name: m[1], version: m[2], integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
    });
}

async function published(name) {
  const res = await fetch(`${registry}/${name.replace("/", "%2f")}`);
  if (res.status === 404) return {};
  if (!res.ok) throw new Error(`registry lookup ${name}: ${res.status}`);
  return (await res.json()).versions ?? {};
}

async function main() {
  const entries = seedEntries();
  const work = mkdtempSync(join(tmpdir(), "nearpay-seed-"));
  try {
    const npmrc = join(work, ".npmrc");
    writeFileSync(npmrc, `registry=${registry}/\n${registry.replace(/^https?:/, "")}/:_authToken=${await token()}\n`);
    const npm = (args) =>
      execFileSync("npm", [...args, "--userconfig", npmrc, "--registry", `${registry}/`], { env: npmEnv, stdio: "pipe" });
    // npm 11 refuses to publish a version below the current "latest" without an explicit tag, so publish in
    // ascending order and tag explicitly: the highest seeded version of each package is "latest".
    const semver = (v) => v.split(".").map(Number);
    const cmp = (a, b) => {
      const [x, y] = [semver(a), semver(b)];
      for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
      return 0;
    };
    entries.sort((a, b) => (a.name === b.name ? cmp(a.version, b.version) : a.name < b.name ? -1 : 1));
    const highest = new Map();
    for (const e of entries) highest.set(e.name, e.version);
    let added = 0;
    let replaced = 0;
    for (const e of entries) {
      const have = (await published(e.name))[e.version];
      if (have?.dist?.integrity === e.integrity) continue;
      if (have) {
        npm(["unpublish", `${e.name}@${e.version}`, "--force"]);
        replaced++;
      }
      const tag = highest.get(e.name) === e.version ? "latest" : `seed-${e.version}`;
      npm(["publish", e.file, "--access", "public", "--tag", tag]);
      added++;
    }
    console.log(`registry seed: ${entries.length} tarballs, ${added - replaced} published, ${replaced} replaced`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`registry seed failed: ${err.message}`);
  process.exit(1);
});
