/**
 * On-chain status: read-only RPC queries (view_account, view_access_key_list, view calls). Nothing here
 * signs or sends.
 */
import {
  INTENTS_CONTRACT,
  RELAYER_KEY_ALLOWANCE,
  RELAYER_KEY_METHODS,
  RELAYER_KEY_RECEIVER,
  ROLES,
  USDC_CONTRACT,
  USDC_INTENTS_TOKEN_ID,
} from "./constants.mjs";

/** RPC permission (`"FullAccess"` | `{FunctionCall: {...}}`) → `{type, receiverId, methodNames, allowance}`. */
export function normalizePermission(p) {
  if (p === "FullAccess") return { type: "FullAccess" };
  const fc = p?.FunctionCall;
  if (!fc) return { type: "unknown" };
  return {
    type: "FunctionCall",
    receiverId: fc.receiver_id,
    methodNames: [...(fc.method_names ?? [])],
    allowance: fc.allowance == null ? null : BigInt(fc.allowance),
  };
}

/**
 * Whether an on-chain relayer key has the agentpay policy: function call on intents.near, exactly
 * [execute_intents], a finite allowance of at most 5 NEAR (it shrinks as gas is spent).
 */
export function matchesRelayerPolicy(perm) {
  return (
    perm.type === "FunctionCall" &&
    perm.receiverId === RELAYER_KEY_RECEIVER &&
    perm.methodNames.length === RELAYER_KEY_METHODS.length &&
    perm.methodNames.every((m, i) => m === RELAYER_KEY_METHODS[i]) &&
    perm.allowance !== null &&
    perm.allowance <= RELAYER_KEY_ALLOWANCE
  );
}

const big = (v) => (v == null ? 0n : BigInt(v));

export async function gatherStatus(rpc, inputs) {
  const { accounts, relayerKeys } = inputs;
  const status = { rpc: rpc.url, accounts: {}, relayer: null, agent: null, merchant: null, usdc: null, errors: [] };
  const guard = async (what, fn, fallback = null) => {
    try {
      return await fn();
    } catch (e) {
      status.errors.push(`${what}: ${e.message}`);
      return fallback;
    }
  };

  for (const role of ROLES) {
    const a = accounts[role];
    if (!a.accountId) {
      status.accounts[role] = { role, file: a.file, error: a.error };
      continue;
    }
    const view = await guard(`${role} view_account`, () => rpc.viewAccount(a.accountId), undefined);
    status.accounts[role] = {
      role,
      file: a.file,
      accountId: a.accountId,
      publicKey: a.publicKey,
      exists: view === undefined ? null : view !== null,
      balance: view ? big(view.amount) : 0n,
      locked: view ? big(view.locked) : 0n,
    };
  }

  // Relayer access keys.
  const relayer = status.accounts.relayer;
  if (relayer.accountId) {
    const list = relayer.exists ? await guard("relayer view_access_key_list", () => rpc.accessKeyList(relayer.accountId), []) : [];
    const onChain = new Map(list.map((k) => [k.public_key, normalizePermission(k.access_key.permission)]));
    const own = onChain.get(relayer.publicKey);
    const seen = new Set();
    const keys = relayerKeys.map((k) => {
      if (!k.publicKey) return { n: k.n, file: k.file, state: "file-problem", error: k.error };
      if (seen.has(k.publicKey)) return { n: k.n, file: k.file, publicKey: k.publicKey, state: "duplicate" };
      seen.add(k.publicKey);
      if (k.publicKey === relayer.publicKey) return { n: k.n, file: k.file, publicKey: k.publicKey, state: "is-full-access-key" };
      const perm = onChain.get(k.publicKey);
      if (!perm) return { n: k.n, file: k.file, publicKey: k.publicKey, state: "missing" };
      return { n: k.n, file: k.file, publicKey: k.publicKey, state: matchesRelayerPolicy(perm) ? "present" : "wrong-permission", permission: perm };
    });
    status.relayer = {
      accountId: relayer.accountId,
      fullAccess: own?.type === "FullAccess",
      ownKeyPermission: own ?? null,
      keyCount: onChain.size,
      keys,
    };
  }

  // Agent token balances (view calls work for accounts that do not exist yet: they return 0).
  const agent = status.accounts.agent;
  if (agent.accountId) {
    const usdc = await guard("agent ft_balance_of", () => rpc.view(USDC_CONTRACT, "ft_balance_of", { account_id: agent.accountId }));
    const intents = await guard("agent mt_balance_of", () =>
      rpc.view(INTENTS_CONTRACT, "mt_balance_of", { account_id: agent.accountId, token_id: USDC_INTENTS_TOKEN_ID }),
    );
    const hasKey = await guard("agent has_public_key", () =>
      rpc.view(INTENTS_CONTRACT, "has_public_key", { account_id: agent.accountId, public_key: agent.publicKey }),
    );
    status.agent = {
      accountId: agent.accountId,
      usdc: usdc == null ? null : BigInt(usdc),
      intentsUsdc: intents == null ? null : BigInt(intents),
      hasPublicKey: hasKey == null ? null : hasKey === true,
    };
  }
  const merchant = status.accounts.merchant;
  if (merchant.accountId) {
    const hasKey = await guard("merchant has_public_key", () =>
      rpc.view(INTENTS_CONTRACT, "has_public_key", { account_id: merchant.accountId, public_key: merchant.publicKey }),
    );
    status.merchant = { accountId: merchant.accountId, hasPublicKey: hasKey == null ? null : hasKey === true };
  }

  // NEP-145 storage of intents.near on the USDC contract (ft_transfer_call needs the receiver registered).
  const reg = await guard(
    "USDC storage_balance_of(intents.near)",
    () => rpc.view(USDC_CONTRACT, "storage_balance_of", { account_id: INTENTS_CONTRACT }),
    undefined,
  );
  status.usdc = { intentsRegistered: reg === undefined ? null : reg !== null, storageMin: null };
  if (reg === null) {
    const bounds = await guard("USDC storage_balance_bounds", () => rpc.view(USDC_CONTRACT, "storage_balance_bounds", {}));
    status.usdc.storageMin = bounds?.min == null ? null : BigInt(bounds.min);
  }
  return status;
}
