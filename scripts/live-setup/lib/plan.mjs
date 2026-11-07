/**
 * Which transactions --apply would send, from the status alone (pure; no RPC, no keys used).
 *
 *  (a) relayer: one transaction from the relayer's full-access key adding every missing relayer_key_N as a
 *      function-call key (receiver intents.near, methods [execute_intents], allowance 5 NEAR).
 *  (b) agent, with --deposit: ft_transfer_call of native USDC to intents.near crediting the agent's own
 *      Intents account (preceded by storage_deposit when intents.near is not registered on the token).
 *  (c) agent / merchant: intents.near add_public_key, only when has_public_key is false. Implicit accounts
 *      own their implicit key by default, so for them this is normally skipped (see below).
 */
import {
  ADD_PUBLIC_KEY_GAS,
  FT_TRANSFER_CALL_GAS,
  INTENTS_CONTRACT,
  ONE_YOCTO,
  RELAYER_KEY_ALLOWANCE,
  RELAYER_KEY_METHODS,
  RELAYER_KEY_RECEIVER,
  STORAGE_DEPOSIT_GAS,
  USDC_CONTRACT,
} from "./constants.mjs";

export function relayerKeyAction(publicKey) {
  return {
    type: "AddKey",
    publicKey,
    permission: { receiverId: RELAYER_KEY_RECEIVER, methodNames: [...RELAYER_KEY_METHODS], allowance: RELAYER_KEY_ALLOWANCE },
  };
}

/**
 * intents.near deposit message. The Verifier's ft_on_transfer parses `msg` as a DepositMessage: empty →
 * credit sender_id; a string not starting with "{" → an AccountId to credit; "{...}" → JSON
 * {receiver_id, execute_intents?, refund_if_fails?}. Sources:
 *   - https://docs.near-intents.org/integration/verifier-contract/deposits-and-withdrawals/deposits
 *     ("Specify an account ID to assign ownership to a different account"; 1 yoctoNEAR; "100 TGas is
 *     sufficient for a simple deposit")
 *   - github.com/near/intents @ 32cd1f9 contracts/defuse/src/contract/tokens/nep141/deposit.rs (ft_on_transfer)
 *     and contracts/defuse/src/tokens/mod.rs (`impl FromStr for DepositMessage`).
 * We pass the agent's own account id explicitly rather than "" so the credited account is visible in the
 * printed transaction.
 */
export function depositArgs(agentId, amount) {
  return { receiver_id: INTENTS_CONTRACT, amount: BigInt(amount).toString(), msg: agentId };
}

export function plan(status, opts = {}) {
  const txs = [];
  const notes = [];
  const acc = status.accounts;

  // (a) relayer keys
  const r = status.relayer;
  const missing = r ? r.keys.filter((k) => k.state === "missing") : [];
  if (r && missing.length) {
    if (!acc.relayer.exists) notes.push("(a) relayer keys: skipped, the relayer account does not exist on chain yet (fund it first)");
    else if (!r.fullAccess) notes.push("(a) relayer keys: skipped, accounts/relayer.json is not a full-access key of the relayer on chain");
    else
      txs.push({
        id: "relayer-keys",
        role: "relayer",
        title: `(a) add ${missing.map((k) => `relayer_key_${k.n}`).join(", ")} to the relayer`,
        signerId: r.accountId,
        receiverId: r.accountId,
        actions: missing.map((k) => relayerKeyAction(k.publicKey)),
      });
  }

  // (b) agent deposit into intents.near
  if (opts.deposit) {
    const a = status.agent;
    const native = a?.usdc ?? null;
    if (!a) notes.push("(b) deposit: skipped, no agent account file");
    else if (native === null) notes.push("(b) deposit: skipped, could not read the agent's native USDC balance");
    else if (native === 0n) notes.push("(b) deposit: skipped, the agent holds no native USDC");
    else if (!acc.agent.exists || acc.agent.balance === 0n) notes.push("(b) deposit: skipped, the agent has no NEAR for gas (fund it first)");
    else if (status.usdc?.intentsRegistered == null) notes.push("(b) deposit: skipped, could not check intents.near's storage on the USDC contract");
    else if (status.usdc.intentsRegistered === false && status.usdc.storageMin == null)
      notes.push("(b) deposit: skipped, intents.near is not registered on USDC and storage_balance_bounds is unknown");
    else {
      const amount = opts.deposit.all ? native : opts.deposit.amount;
      if (amount > native) notes.push(`(b) deposit: skipped, ${amount} micro-USDC requested but the agent holds ${native}`);
      else {
        const actions = [];
        if (status.usdc.intentsRegistered === false)
          actions.push({
            type: "FunctionCall",
            methodName: "storage_deposit",
            args: { account_id: INTENTS_CONTRACT, registration_only: true },
            gas: STORAGE_DEPOSIT_GAS,
            deposit: status.usdc.storageMin,
          });
        actions.push({
          type: "FunctionCall",
          methodName: "ft_transfer_call",
          args: depositArgs(a.accountId, amount),
          gas: FT_TRANSFER_CALL_GAS,
          deposit: ONE_YOCTO,
        });
        txs.push({
          id: "agent-deposit",
          role: "agent",
          title: `(b) deposit ${formatUsdc(amount)} USDC from the agent into its NEAR Intents account`,
          signerId: a.accountId,
          receiverId: USDC_CONTRACT,
          actions,
          amount,
        });
      }
    }
  }

  // (c) intents.near add_public_key — only when the Verifier does not already know the key. For an implicit
  // account the Verifier treats the key whose hex is the account id as registered unless it was explicitly
  // removed (github.com/near/intents @ 32cd1f9 contracts/defuse/src/contract/intents/state.rs
  // `has_public_key`: unknown account → `account_id == public_key.to_implicit_account_id()`;
  // contracts/defuse/src/contract/accounts/account/mod.rs `has_public_key`; docs.near-intents.org
  // account-abstraction: "Implicit accounts skip this step"). So has_public_key is true for our implicit
  // accounts and this step is skipped; it runs only if a key was removed or the account is a named one.
  for (const role of ["agent", "merchant"]) {
    const s = status[role];
    if (!s || s.hasPublicKey !== false) continue;
    const a = acc[role];
    if (!a.exists || a.balance === 0n) {
      notes.push(`(c) ${role} add_public_key: skipped, the ${role} has no NEAR for gas (fund it first)`);
      continue;
    }
    txs.push({
      id: `${role}-add-public-key`,
      role,
      title: `(c) register the ${role}'s public key on intents.near`,
      signerId: a.accountId,
      receiverId: INTENTS_CONTRACT,
      actions: [{ type: "FunctionCall", methodName: "add_public_key", args: { public_key: a.publicKey }, gas: ADD_PUBLIC_KEY_GAS, deposit: ONE_YOCTO }],
    });
  }
  return { txs, notes };
}

export function formatUsdc(micro) {
  if (micro == null) return "?";
  const v = BigInt(micro);
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
