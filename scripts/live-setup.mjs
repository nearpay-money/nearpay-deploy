#!/usr/bin/env node
/**
 * One-time mainnet on-chain setup for the NearPay live demo (step 1.5). Dry run by default: prints each
 * account's on-chain state, the relayer's function-call keys, the agent's USDC and NEAR Intents balances and
 * the next steps. With --apply it prints every transaction, asks (or takes --yes), signs with the owner's key
 * files from .secrets/ and waits for FINAL. Private keys are never printed.
 *
 *   pnpm -C scripts/live-setup install --frozen-lockfile   # once (pinned @near-js/* 2.5.1)
 *   node scripts/live-setup.mjs --help
 *
 * Code and tests: scripts/live-setup/ (README "Live on-chain setup").
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "live-setup");
if (!existsSync(join(pkg, "node_modules", "@near-js", "transactions"))) {
  console.error("live-setup: dependencies are not installed. Run once:\n  pnpm -C scripts/live-setup install --frozen-lockfile");
  process.exit(2);
}
const { run } = await import("./live-setup/lib/main.mjs");

const prompt = process.stdin.isTTY
  ? async (q) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(q);
      } finally {
        rl.close();
      }
    }
  : undefined;

try {
  process.exitCode = await run(process.argv.slice(2), {
    deployDir: resolve(here, ".."),
    fetch: globalThis.fetch,
    readFile: (p) => readFileSync(p, "utf8"),
    exists: (p) => existsSync(p),
    out: (line) => console.log(line),
    prompt,
  });
} catch (e) {
  console.error(`live-setup: ${e.message}`);
  process.exitCode = 1;
}
