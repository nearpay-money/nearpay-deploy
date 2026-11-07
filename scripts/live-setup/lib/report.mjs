/** Status report and next steps (text only; no key material ever reaches these functions' output). */
import { relative } from "node:path";
import { FUNDING, ROLES, USDC_CONTRACT } from "./constants.mjs";
import { isImplicit } from "./keys.mjs";
import { formatUsdc } from "./plan.mjs";
import { near } from "./tx.mjs";

const perm = (p) =>
  !p
    ? "?"
    : p.type === "FullAccess"
      ? "FullAccess"
      : p.type === "FunctionCall"
        ? `function-call ${p.receiverId} [${p.methodNames.join(", ")}] allowance ${p.allowance === null ? "unlimited" : near(p.allowance)}`
        : p.type;
const yesNo = (v) => (v === null || v === undefined ? "unknown (read failed)" : v ? "yes" : "no");

export function formatStatus(status, { cwd = process.cwd() } = {}) {
  const rel = (f) => relative(cwd, f) || f;
  const out = [`NearPay live setup: mainnet status (RPC ${status.rpc})`, "", "Accounts"];
  for (const role of ROLES) {
    const a = status.accounts[role];
    if (!a.accountId) {
      out.push(`  ${role.padEnd(9)} ${rel(a.file)}: ${a.error}`);
      continue;
    }
    const state = a.exists === null ? "unknown (read failed)" : a.exists ? `exists, ${near(a.balance)}` : "does not exist on chain (not funded yet)";
    out.push(`  ${role.padEnd(9)} ${a.accountId}${isImplicit(a.accountId) ? "" : " (named)"}  ${state}`);
  }
  out.push("  (the relayer and the agent need NEAR for gas; treasury and merchant only need to exist on chain to withdraw)");
  if (status.relayer) {
    const r = status.relayer;
    out.push("", `Relayer access keys (${r.keyCount} on chain)`);
    out.push(`  accounts/relayer.json  ${status.accounts.relayer.publicKey}  ${r.ownKeyPermission ? perm(r.ownKeyPermission) : "not on chain"}`);
    for (const k of r.keys) {
      const name = `relayer_key_${k.n}`.padEnd(21);
      switch (k.state) {
        case "present":
          out.push(`  ${name}  ${k.publicKey}  present: ${perm(k.permission)}`);
          break;
        case "wrong-permission":
          out.push(`  ${name}  ${k.publicKey}  present with a DIFFERENT permission: ${perm(k.permission)}`);
          break;
        case "missing":
          out.push(`  ${name}  ${k.publicKey}  missing`);
          break;
        case "duplicate":
          out.push(`  ${name}  ${k.publicKey}  same key as another relayer_key file`);
          break;
        case "is-full-access-key":
          out.push(`  ${name}  ${k.publicKey}  is the relayer's full-access key (must be a separate key)`);
          break;
        default:
          out.push(`  ${name}  ${rel(k.file)}: ${k.error}`);
      }
    }
  }
  if (status.agent) {
    out.push("", "Agent");
    out.push(`  native USDC (${USDC_CONTRACT.slice(0, 8)}…)            ${status.agent.usdc === null ? "unknown (read failed)" : formatUsdc(status.agent.usdc)}`);
    out.push(`  NEAR Intents USDC (intents.near)   ${status.agent.intentsUsdc === null ? "unknown (read failed)" : formatUsdc(status.agent.intentsUsdc)}`);
    out.push(`  intents.near has_public_key        ${yesNo(status.agent.hasPublicKey)}`);
  }
  if (status.merchant) {
    out.push("", "Merchant", `  intents.near has_public_key        ${yesNo(status.merchant.hasPublicKey)}`);
  }
  if (status.usdc) out.push("", "USDC contract", `  intents.near storage registered    ${yesNo(status.usdc.intentsRegistered)}`);
  if (status.errors.length) out.push("", "Read errors", ...status.errors.map((e) => `  ${e}`));
  return out;
}

export function nextSteps(status, { env = {}, applied = false, cwd = process.cwd() } = {}) {
  const rel = (f) => relative(cwd, f) || f;
  const steps = [];
  const acc = status.accounts;
  for (const role of ROLES) if (!acc[role].accountId) steps.push(`Provide ${rel(acc[role].file)} (near-cli JSON {account_id, public_key, private_key}): ${acc[role].error}.`);

  const relayer = acc.relayer;
  if (relayer.accountId) {
    if (relayer.exists === false)
      steps.push(`Fund the relayer: send at least ${near(FUNDING.relayerMin)} to ${relayer.accountId} (it pays gas for every execute_intents batch; the implicit account is created by its first transfer).`);
    else if (relayer.exists && relayer.balance < FUNDING.relayerMin)
      steps.push(`Top up the relayer ${relayer.accountId} to at least ${near(FUNDING.relayerMin)} (now ${near(relayer.balance)}).`);
    const r = status.relayer;
    if (relayer.exists && r && !r.fullAccess)
      steps.push(`accounts/relayer.json (${relayer.publicKey}) is not a full-access key of ${relayer.accountId} on chain; use the account's full-access key file.`);
    for (const k of r?.keys ?? []) {
      if (k.state === "file-problem") steps.push(`Provide ${rel(k.file)} (near-cli JSON with account_id ${relayer.accountId}, or ed25519:<base58>): ${k.error}.`);
      if (k.state === "duplicate" || k.state === "is-full-access-key")
        steps.push(`relayer_key_${k.n} must be its own new key pair (near generate-key / near account add-key creates one).`);
      if (k.state === "wrong-permission")
        steps.push(`relayer_key_${k.n} is on chain with another permission; delete that key from the relayer (near account delete-keys) and re-run with --apply, or use a fresh key pair.`);
    }
    const missing = (r?.keys ?? []).filter((k) => k.state === "missing");
    if (missing.length && !applied)
      steps.push(`Run with --apply to add ${missing.map((k) => `relayer_key_${k.n}`).join(", ")} (one transaction signed by the relayer's full-access key).`);
  }

  const agent = acc.agent;
  if (agent.accountId) {
    if (agent.exists === false || (agent.exists && agent.balance < FUNDING.agentMin))
      steps.push(`Fund the agent with ${near(FUNDING.agentMin)}: send it to ${agent.accountId} (gas for its own deposit transaction).`);
    const s = status.agent;
    if (s && s.intentsUsdc !== null && s.intentsUsdc < FUNDING.agentUsdc) {
      if (s.usdc && s.usdc > 0n)
        steps.push(`Run with --apply --deposit all to move the agent's ${formatUsdc(s.usdc)} native USDC into its NEAR Intents balance (now ${formatUsdc(s.intentsUsdc)}; the demo needs about ${formatUsdc(FUNDING.agentUsdc)}).`);
      else
        steps.push(
          `Fund the agent with USDC: send at least ${formatUsdc(FUNDING.agentUsdc)} native USDC on NEAR (token ${USDC_CONTRACT}) to ${agent.accountId}, then run with --apply --deposit all. (Alternatively deposit USDC into intents.near for that account via near-intents.org.)`,
        );
    } else if (s?.usdc && s.usdc > 0n && !applied)
      steps.push(`Optional: the agent also holds ${formatUsdc(s.usdc)} native USDC; --apply --deposit all moves it into NEAR Intents.`);
  }
  for (const role of ["agent", "merchant"]) {
    const s = status[role];
    if (s?.hasPublicKey === false) {
      const a = acc[role];
      if (!a.exists || a.balance < FUNDING.merchantMin) steps.push(`Send ${near(FUNDING.merchantMin)} to the ${role} ${a.accountId} so it can call intents.near add_public_key.`);
      if (!applied) steps.push(`Run with --apply to register the ${role}'s key on intents.near (add_public_key, 1 yoctoNEAR).`);
    }
  }

  const want = { NP_RELAYER_ACCOUNT: relayer.accountId, NP_TREASURY_ACCOUNT: acc.treasury.accountId };
  for (const [k, v] of Object.entries(want))
    if (v && env[k] !== v) steps.push(`Set ${k}=${v} in compose/env/local.env (now ${env[k] ? env[k] : "empty"}).`);

  if (status.errors.length) steps.push("Some reads failed (see above); re-run, or pass another RPC with --rpc.");
  if (!steps.length)
    steps.push("On-chain setup is complete. Next: scripts/seed.sh live && scripts/up.sh local, then the testbed README \"Mainnet demo\".");
  return ["", "Next steps", ...steps.map((s, i) => `  ${i + 1}. ${s}`)];
}
