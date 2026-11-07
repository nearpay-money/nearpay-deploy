/**
 * Orchestration: status (always) → with --apply: plan, build, print, confirm, sign, send, wait FINAL.
 * Every side effect is injected (fetch, file reads, output, prompt) so tests run it end to end offline.
 */
import { baseEncode } from "@near-js/utils";
import { EXPLORER_TX } from "./constants.mjs";
import { loadInputs, parseArgs, parseEnvFile, rpcUrls, USAGE, UsageError } from "./inputs.mjs";
import { plan } from "./plan.mjs";
import { formatStatus, nextSteps } from "./report.mjs";
import { connect } from "./rpc.mjs";
import { gatherStatus } from "./status.mjs";
import { buildTransaction, describe } from "./tx.mjs";

/**
 * @param {string[]} argv
 * @param {{deployDir: string, fetch: Function, readFile: (p: string) => string, exists: (p: string) => boolean,
 *          out: (line: string) => void, prompt?: (question: string) => Promise<string>, cwd?: string}} io
 * @returns {Promise<number>} exit code
 */
export async function run(argv, io) {
  const { out } = io;
  const print = (lines) => (Array.isArray(lines) ? lines : [lines]).forEach((l) => out(l));
  let opts;
  try {
    opts = parseArgs(argv, { deployDir: io.deployDir });
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    print([`live-setup: ${e.message}`, "", USAGE]);
    return 2;
  }
  if (opts.help) {
    print(USAGE);
    return 0;
  }
  const env = io.exists(opts.envFile) ? parseEnvFile(io.readFile(opts.envFile)) : {};
  const inputs = loadInputs(opts, io);
  const rpc = await connect(rpcUrls(opts, env), { fetch: io.fetch });
  const status = await gatherStatus(rpc, inputs);
  const cwd = io.cwd ?? process.cwd();
  print(formatStatus(status, { cwd }));

  if (!opts.apply) {
    print(nextSteps(status, { env, cwd }));
    print(["", "Dry run: nothing was built, signed or sent. Add --apply to prepare the transactions."]);
    return 0;
  }

  const { txs, notes } = plan(status, { deposit: opts.deposit });
  if (notes.length) print(["", "Skipped", ...notes.map((n) => `  ${n}`)]);
  if (!txs.length) {
    print(["", "Nothing to send."]);
    print(nextSteps(status, { env, cwd }));
    return 0;
  }

  // Build every transaction first so all of them are printed before the single confirmation.
  const built = [];
  const lastNonce = new Map();
  for (const p of txs) {
    const key = inputs.accounts[p.role].key;
    const ak = await rpc.accessKey(p.signerId, key.publicKey);
    const nonce = (lastNonce.has(p.signerId) ? lastNonce.get(p.signerId) : BigInt(ak.nonce)) + 1n;
    lastNonce.set(p.signerId, nonce);
    const transaction = buildTransaction(p, { publicKey: key.publicKey, nonce, blockHash: ak.block_hash });
    built.push({ planned: p, key, transaction });
  }
  print(["", `Transactions to sign and send (${built.length})`]);
  built.forEach((b, i) => print(describe(`${i + 1}. ${b.planned.title}`, b.transaction)));

  if (!opts.yes) {
    if (!io.prompt) {
      print(["", "Not sent: stdin is not a terminal. Re-run with --yes to send without asking."]);
      return 1;
    }
    const answer = String(await io.prompt(`\nSign and send ${built.length} transaction(s) on mainnet? [y/N] `)).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      print("Not confirmed; nothing was sent.");
      return 1;
    }
  }

  for (const b of built) {
    const [hash, signed] = await b.key.sign(b.transaction);
    const txHash = baseEncode(hash);
    print(["", `Sending ${b.planned.title}`, `  ${EXPLORER_TX}${txHash}`]);
    const outcome = await rpc.sendTx(Buffer.from(signed.encode()).toString("base64"), { hash: txHash, signerId: b.planned.signerId });
    const verdict = checkOutcome(b.planned, outcome);
    print(verdict.lines.map((l) => `  ${l}`));
    if (!verdict.ok) {
      print(["", "Stopped after a failed transaction; later transactions were not sent. Re-run for a fresh status."]);
      return 1;
    }
  }

  const after = await gatherStatus(rpc, inputs);
  print(["", "Status after apply", ...formatStatus(after, { cwd }).slice(2)]);
  print(nextSteps(after, { env, cwd, applied: true }));
  return 0;
}

/** Final execution outcome → ok + lines. ft_transfer_call returns the amount the receiver kept. */
export function checkOutcome(planned, outcome) {
  const st = outcome?.status ?? {};
  const final = outcome?.final_execution_status;
  if (st.Failure) return { ok: false, lines: [`FAILED: ${JSON.stringify(st.Failure)}`] };
  if (!("SuccessValue" in st)) return { ok: false, lines: [`unexpected status ${JSON.stringify(st)} (final_execution_status ${final ?? "?"})`] };
  const failed = (outcome.receipts_outcome ?? []).filter((r) => r.outcome?.status?.Failure);
  const lines = [`final (${final ?? "FINAL"}), success`];
  if (planned.id === "agent-deposit") {
    let used = null;
    try {
      used = JSON.parse(Buffer.from(st.SuccessValue, "base64").toString("utf8"));
    } catch {}
    if (used === null || BigInt(used) !== BigInt(planned.amount))
      return { ok: false, lines: [`deposit not fully accepted: intents.near kept ${used ?? "?"} of ${planned.amount} micro-USDC (the rest was refunded)`, ...failed.map((r) => `receipt ${r.id} failed: ${JSON.stringify(r.outcome.status.Failure)}`)] };
    lines.push(`intents.near credited ${planned.amount} micro-USDC`);
  } else if (failed.length) {
    return { ok: false, lines: failed.map((r) => `receipt ${r.id} failed: ${JSON.stringify(r.outcome.status.Failure)}`) };
  }
  return { ok: true, lines };
}
