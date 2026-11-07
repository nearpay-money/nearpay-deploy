/**
 * Test fixtures: deterministic throwaway ed25519 keys (sha256 of a label; never used on any network) written
 * in the owner's .secrets layout, and a fake NEAR RPC behind an injected fetch.
 */
import { createHash, createPrivateKey, createPublicKey, verify } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseDecode, baseEncode } from "@near-js/utils";
import { encodeTransaction, decodeSignedTransaction } from "@near-js/transactions";
import { decodeSignedTx } from "../lib/tx.mjs";
import { USDC_CONTRACT, INTENTS_CONTRACT, USDC_INTENTS_TOKEN_ID } from "../lib/constants.mjs";

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

export function fixtureKey(label) {
  const seed = createHash("sha256").update(`nearpay live-setup test fixture: ${label}`).digest();
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" });
  const pub = Buffer.from(createPublicKey(priv).export({ format: "jwk" }).x, "base64url");
  return {
    label,
    secret: `ed25519:${baseEncode(Buffer.concat([seed, pub]))}`,
    publicKey: `ed25519:${baseEncode(pub)}`,
    implicitId: pub.toString("hex"),
    pubRaw: pub,
  };
}

export const KEYS = {
  treasury: fixtureKey("treasury"),
  relayer: fixtureKey("relayer"),
  merchant: fixtureKey("merchant"),
  agent: fixtureKey("agent"),
  rk: [1, 2, 3, 4].map((n) => fixtureKey(`relayer_key_${n}`)),
};

/** Every secret string a test must never see in the output. */
export const ALL_SECRETS = [KEYS.treasury, KEYS.relayer, KEYS.merchant, KEYS.agent, ...KEYS.rk].flatMap((k) => [
  k.secret,
  k.secret.slice(8),
]);

export const nearCliJson = (k, accountId = k.implicitId) =>
  JSON.stringify({ account_id: accountId, public_key: k.publicKey, private_key: k.secret });

/** Writes deploy/.secrets/{accounts,live}/ and compose/env/local.env into a temp dir; returns the deploy dir. */
export function makeDeployDir({ relayerKeys = [1, 2, 3, 4], env = true } = {}) {
  const deploy = mkdtempSync(join(tmpdir(), "np-live-setup-"));
  const acc = join(deploy, ".secrets", "accounts");
  const live = join(deploy, ".secrets", "live");
  mkdirSync(acc, { recursive: true, mode: 0o700 });
  mkdirSync(live, { recursive: true, mode: 0o700 });
  for (const role of ["treasury", "relayer", "merchant", "agent"])
    writeFileSync(join(acc, `${role}.json`), nearCliJson(KEYS[role]), { mode: 0o600 });
  for (const n of relayerKeys)
    writeFileSync(join(live, `relayer_key_${n}`), nearCliJson(KEYS.rk[n - 1], KEYS.relayer.implicitId), { mode: 0o600 });
  if (env) {
    mkdirSync(join(deploy, "compose", "env"), { recursive: true });
    writeFileSync(
      join(deploy, "compose", "env", "local.env"),
      [
        "NP_NEAR_RPC_URLS=https://rpc.down.example,https://rpc.up.example",
        `NP_RELAYER_ACCOUNT=${KEYS.relayer.implicitId}`,
        `NP_TREASURY_ACCOUNT=${KEYS.treasury.implicitId}`,
        "",
      ].join("\n"),
    );
  }
  return deploy;
}

const NEAR = 10n ** 24n;
export const BLOCK_HASH = baseEncode(createHash("sha256").update("block").digest());

/** A funded, freshly set-up-nothing chain: all accounts exist, relayer has only its full-access key. */
export function baseChain() {
  const acct = (k, amount) => ({ amount: amount.toString(), keys: { [k.publicKey]: { nonce: 100, permission: "FullAccess" } } });
  return {
    accounts: {
      [KEYS.treasury.implicitId]: acct(KEYS.treasury, NEAR / 10n),
      [KEYS.relayer.implicitId]: acct(KEYS.relayer, 2n * NEAR),
      [KEYS.merchant.implicitId]: acct(KEYS.merchant, NEAR / 10n),
      [KEYS.agent.implicitId]: acct(KEYS.agent, NEAR / 5n),
    },
    ft: { [INTENTS_CONTRACT]: "999999999999", [KEYS.agent.implicitId]: "2500000" },
    mt: {},
    removedImplicit: new Set(),
    usdcRegistered: true,
    storageMin: "1250000000000000000000",
  };
}

/**
 * Fake RPC: `fetch(url, init)`. URLs containing "down" throw like a dead endpoint. Records every call in
 * `calls` and every accepted transaction (decoded, signature checked) in `sent`; applies AddKey,
 * ft_transfer_call and add_public_key to the state so a second run sees the result.
 */
export function fakeRpc(chain = baseChain(), { onSend } = {}) {
  const calls = [];
  const sent = [];
  const err = (name, data) => ({ error: { name: "HANDLER_ERROR", cause: { name, info: {} }, code: -32000, message: "Server error", data } });
  const ok = (result) => ({ result });
  const bytes = (v) => [...Buffer.from(JSON.stringify(v))];

  function view(contract, method, args) {
    if (contract === USDC_CONTRACT) {
      if (method === "ft_balance_of") return chain.ft[args.account_id] ?? "0";
      if (method === "storage_balance_of")
        return args.account_id === INTENTS_CONTRACT && !chain.usdcRegistered ? null : { total: "1250000000000000000000", available: "0" };
      if (method === "storage_balance_bounds") return { min: chain.storageMin, max: chain.storageMin };
    }
    if (contract === INTENTS_CONTRACT) {
      if (method === "mt_balance_of") return args.token_id === USDC_INTENTS_TOKEN_ID ? (chain.mt[args.account_id] ?? "0") : "0";
      if (method === "has_public_key") {
        const implicit = Buffer.from(require58(args.public_key)).toString("hex") === args.account_id;
        return (implicit && !chain.removedImplicit.has(args.account_id)) || (chain.intentsKeys?.[args.account_id] ?? []).includes(args.public_key);
      }
    }
    throw Object.assign(new Error("MethodNotFound"), { rpc: err("CONTRACT_EXECUTION_ERROR", `wasm execution failed: MethodNotFound ${method}`) });
  }

  function apply(tx) {
    const a = chain.accounts[tx.signerId];
    const k = a.keys[tx.publicKey];
    if (!k || tx.nonce <= BigInt(k.nonce)) return { status: { Failure: { InvalidTxError: "InvalidNonce" } } };
    k.nonce = Number(tx.nonce);
    let value = "";
    for (const act of tx.actions) {
      if (act.type === "AddKey") {
        if (a.keys[act.publicKey]) return { status: { Failure: { ActionError: { kind: { AddKeyAlreadyExists: {} } } } } };
        const p = act.permission;
        a.keys[act.publicKey] = {
          nonce: 0,
          permission: { FunctionCall: { allowance: p.allowance?.toString() ?? null, receiver_id: p.receiverId, method_names: p.methodNames } },
        };
      } else if (act.type === "FunctionCall" && tx.receiverId === USDC_CONTRACT && act.methodName === "storage_deposit") {
        chain.usdcRegistered = true;
      } else if (act.type === "FunctionCall" && tx.receiverId === USDC_CONTRACT && act.methodName === "ft_transfer_call") {
        const amt = BigInt(act.args.amount);
        const credit = act.args.msg === "" ? tx.signerId : act.args.msg;
        chain.ft[tx.signerId] = (BigInt(chain.ft[tx.signerId] ?? 0) - amt).toString();
        chain.mt[credit] = (BigInt(chain.mt[credit] ?? 0) + amt).toString();
        value = JSON.stringify(act.args.amount);
      } else if (act.type === "FunctionCall" && tx.receiverId === INTENTS_CONTRACT && act.methodName === "add_public_key") {
        chain.removedImplicit.delete(tx.signerId);
        (chain.intentsKeys ??= {})[tx.signerId] = [...(chain.intentsKeys[tx.signerId] ?? []), act.args.public_key];
      }
    }
    return { status: { SuccessValue: Buffer.from(value).toString("base64") }, final_execution_status: "FINAL", receipts_outcome: [] };
  }

  async function fetch(url, init) {
    const req = JSON.parse(init.body);
    calls.push({ url, method: req.method, params: req.params });
    if (url.includes("down")) throw new TypeError("fetch failed");
    const p = req.params;
    let body;
    try {
      if (req.method === "status") body = ok({ chain_id: "mainnet" });
      else if (req.method === "query" && p.request_type === "view_account") {
        const a = chain.accounts[p.account_id];
        body = a ? ok({ amount: a.amount, locked: "0", storage_usage: 182 }) : err("UNKNOWN_ACCOUNT", `account ${p.account_id} does not exist while viewing`);
      } else if (req.method === "query" && p.request_type === "view_access_key_list") {
        const a = chain.accounts[p.account_id];
        body = a
          ? ok({ keys: Object.entries(a.keys).map(([public_key, access_key]) => ({ public_key, access_key })) })
          : err("UNKNOWN_ACCOUNT", "does not exist");
      } else if (req.method === "query" && p.request_type === "view_access_key") {
        const k = chain.accounts[p.account_id]?.keys[p.public_key];
        body = k ? ok({ ...k, block_hash: BLOCK_HASH, block_height: 1 }) : err("UNKNOWN_ACCESS_KEY", "access key does not exist");
      } else if (req.method === "query" && p.request_type === "call_function") {
        const args = JSON.parse(Buffer.from(p.args_base64, "base64").toString("utf8"));
        body = ok({ result: bytes(view(p.account_id, p.method_name, args)), logs: [] });
      } else if (req.method === "send_tx") {
        const raw = Buffer.from(p.signed_tx_base64, "base64");
        const tx = decodeSignedTx(new Uint8Array(raw));
        const s = decodeSignedTransaction(new Uint8Array(raw));
        const msg = createHash("sha256").update(encodeTransaction(s.transaction)).digest();
        const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(require58(tx.publicKey)).toString("base64url") }, format: "jwk" });
        if (!verify(null, msg, pub, Buffer.from(tx.signature))) body = err("INVALID_TRANSACTION", "invalid signature");
        else {
          const hash = baseEncode(msg);
          sent.push({ ...tx, hash });
          body = ok({ ...(onSend?.(tx) ?? apply(tx)), transaction: { hash } });
        }
      } else body = err("UNSUPPORTED", req.method);
    } catch (e) {
      body = e.rpc ?? err("INTERNAL", e.message);
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, ...body }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return { fetch, calls, sent, chain };
}

function require58(pk) {
  return baseDecode(pk.replace(/^ed25519:/, ""));
}

/** Output collector. */
export function collector() {
  const lines = [];
  return { lines, out: (l) => lines.push(String(l)), text: () => lines.join("\n") };
}
