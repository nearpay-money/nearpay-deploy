#!/usr/bin/env node
/**
 * Live (mainnet) credentials → a Compose overlay with only what the owner provided (ADR-0015/0016:
 * credentials are human-provided; nothing here creates or signs anything). Reads .secrets/live/:
 *
 *   oneclick_api_key        1Click JWT (rails + sentinel; without it 1Click quotes carry its unauthenticated fee)
 *   explorer_token          NEAR Intents Explorer JWT (rails Explorer feed; also set NP_EXPLORER_ENABLED=true)
 *   relayer_key_1 … _4      function-call keys of NP_RELAYER_ACCOUNT on intents.near (agentpay batcher):
 *                           near-cli JSON ({"account_id","public_key","private_key"}) or "ed25519:<base58>"
 *   keeper_key              Stage 4: function-call key of NP_KEEPER_ACCOUNT for the subscription vault (billing worker,
 *                           gas only; billing refuses a full-access key), same formats as the relayer keys
 *   sentinel_solana_rpc_urls, sentinel_bitcoin_esplora_urls
 *                           Stage 4: sentinel's own Solana RPC / Esplora provider accounts (comma-separated https URLs,
 *                           one line; they carry API keys). Without them sentinel uses NP_SOLANA_RPC_URLS /
 *                           NP_BITCOIN_ESPLORA_URLS from local.env, else audits on that chain are `unverifiable`.
 *
 * Writes .secrets/live/compose.live.yaml (secrets + *_FILE variables); `up.sh`/`down.sh` include it
 * when present. Validates formats and prints a summary without echoing secret material.
 */
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir || !existsSync(dir)) {
  console.error(`live-overlay: ${dir ?? "<dir>"} does not exist`);
  process.exit(2);
}
const read = (f) => readFileSync(join(dir, f), "utf8").trim();
const problems = [];
const secrets = {};
const services = {};
const add = (svc, env, name) => {
  secrets[name] = { file: `../.secrets/live/${name}` };
  services[svc] ??= { environment: {}, secrets: [] };
  if (env) services[svc].environment[env] = `/run/secrets/${name}`;
  services[svc].secrets.push(name);
};

const summary = [];
if (existsSync(join(dir, "oneclick_api_key"))) {
  const v = read("oneclick_api_key");
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v)) problems.push("oneclick_api_key: expected a JWT (three base64url parts)");
  // sentinel looks up deposit addresses on 1Click itself (lld/sentinel.md §9), with the same partner key here
  for (const s of ["rails-api", "rails-tracker", "rails-feeds", "sentinel-api", "sentinel-auditor"]) add(s, "NP_ONECLICK_API_KEY_FILE", "oneclick_api_key");
  summary.push("1Click API key: present (rails + sentinel)");
} else summary.push("1Click API key: absent (quotes use 1Click's unauthenticated fee)");

if (existsSync(join(dir, "explorer_token"))) {
  const v = read("explorer_token");
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v)) problems.push("explorer_token: expected a JWT");
  for (const s of ["rails-api", "rails-tracker", "rails-feeds"]) add(s, "NP_EXPLORER_TOKEN_FILE", "explorer_token");
  summary.push("Explorer token: present (set NP_EXPLORER_ENABLED=true in local.env to use it)");
} else summary.push("Explorer token: absent (Explorer feed off; provider status polling only)");

function nearKeyOk(v) {
  if (/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,90}$/.test(v)) return true;
  try {
    const j = JSON.parse(v);
    return typeof j.private_key === "string" && j.private_key.startsWith("ed25519:");
  } catch {
    return false;
  }
}

const relayer = readdirSync(dir).filter((f) => /^relayer_key_[1-9]$/.test(f)).sort();
for (const f of relayer) {
  const v = read(f);
  if (!nearKeyOk(v)) problems.push(`${f}: expected near-cli JSON with private_key "ed25519:…" or "ed25519:<base58>"`);
  add("agentpay-batcher", null, f);
}
if (relayer.length) {
  services["agentpay-batcher"].environment.NP_RELAYER_KEY_FILES = "/run/secrets/relayer_key_*";
  summary.push(`relayer keys: ${relayer.length} (agentpay batcher submits live intents)`);
} else summary.push("relayer keys: none (live agent payments and checkout Intents relays stay off)");

// Stage 4: the vault keeper (billing worker) and sentinel's own Solana/Bitcoin providers
if (existsSync(join(dir, "keeper_key"))) {
  if (!nearKeyOk(read("keeper_key"))) problems.push(`keeper_key: expected near-cli JSON with private_key "ed25519:…" or "ed25519:<base58>"`);
  add("billing-worker", "NP_KEEPER_KEY_FILE", "keeper_key");
  summary.push("keeper key: present (billing collects live mandates; set NP_KEEPER_ACCOUNT in local.env)");
} else summary.push("keeper key: absent (live auto-debit mandates are not collected)");

for (const [file, env, label] of [
  ["sentinel_solana_rpc_urls", "NP_SENTINEL_SOLANA_RPC_URLS_FILE", "Solana RPC"],
  ["sentinel_bitcoin_esplora_urls", "NP_SENTINEL_BITCOIN_ESPLORA_URLS_FILE", "Bitcoin Esplora"],
]) {
  if (!existsSync(join(dir, file))) {
    summary.push(`sentinel ${label} accounts: absent (shared pool from local.env, if any)`);
    continue;
  }
  const urls = read(file).split(",").map((u) => u.trim());
  if (/\n/.test(read(file)) || !urls.length || urls.some((u) => !/^https:\/\/[^\s,]+$/.test(u)))
    problems.push(`${file}: expected comma-separated https URLs on one line`);
  for (const s of ["sentinel-api", "sentinel-auditor"]) add(s, env, file);
  summary.push(`sentinel ${label} accounts: ${urls.length} URL(s)`);
}

if (problems.length) {
  for (const p of problems) console.error(`live-overlay: ${p}`);
  process.exit(1);
}
const yaml = [
  "# Generated by scripts/seed.sh live from .secrets/live/ — do not edit; re-run after changing files.",
  "services:",
  ...Object.entries(services).flatMap(([svc, s]) => [
    `  ${svc}:`,
    ...(Object.keys(s.environment).length
      ? ["    environment:", ...Object.entries(s.environment).map(([k, v]) => `      ${k}: ${JSON.stringify(v)}`)]
      : []),
    `    secrets: [${[...new Set(s.secrets)].join(", ")}]`,
  ]),
  ...(Object.keys(secrets).length
    ? ["secrets:", ...Object.entries(secrets).map(([k, v]) => `  ${k}: { file: ${JSON.stringify(v.file)} }`)]
    : []),
  "",
].join("\n");
const out = join(dir, "compose.live.yaml");
writeFileSync(out, Object.keys(services).length ? yaml : "# no live credentials\n");
chmodSync(out, 0o600);
for (const l of summary) console.log(`  ${l}`);
