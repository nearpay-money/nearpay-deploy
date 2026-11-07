import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { loadInputs, parseArgs, parseDeposit } from "../lib/inputs.mjs";
import { depositArgs, plan } from "../lib/plan.mjs";
import { createRpc } from "../lib/rpc.mjs";
import { gatherStatus } from "../lib/status.mjs";
import { baseChain, fakeRpc, KEYS, makeDeployDir } from "./fixtures.mjs";

const io = { readFile: (p) => readFileSync(p, "utf8"), exists: existsSync };
async function statusOf(chain, deployOpts) {
  const f = fakeRpc(chain);
  return gatherStatus(createRpc("https://rpc.up.example", { fetch: f.fetch }), loadInputs(parseArgs([], { deployDir: makeDeployDir(deployOpts) }), io));
}
const FIVE_NEAR = 5n * 10n ** 24n;
const fc = { allowance: FIVE_NEAR.toString(), receiver_id: "intents.near", method_names: ["execute_intents"] };

describe("(a) relayer add-key transaction", () => {
  it("adds every relayer key with exactly receiver intents.near, [execute_intents], 5 NEAR, from the relayer", async () => {
    const { txs } = plan(await statusOf(baseChain()));
    assert.equal(txs.length, 1);
    const t = txs[0];
    assert.equal(t.id, "relayer-keys");
    assert.equal(t.role, "relayer");
    assert.equal(t.signerId, KEYS.relayer.implicitId);
    assert.equal(t.receiverId, KEYS.relayer.implicitId);
    assert.deepEqual(
      t.actions,
      KEYS.rk.map((k) => ({
        type: "AddKey",
        publicKey: k.publicKey,
        permission: { receiverId: "intents.near", methodNames: ["execute_intents"], allowance: FIVE_NEAR },
      })),
    );
    assert.ok(t.actions.every((a) => a.type === "AddKey"), "no transfer or function call: zero deposit");
  });

  it("adds only the missing keys", async () => {
    const chain = baseChain();
    const keys = chain.accounts[KEYS.relayer.implicitId].keys;
    keys[KEYS.rk[0].publicKey] = { nonce: 0, permission: { FunctionCall: fc } };
    keys[KEYS.rk[2].publicKey] = { nonce: 0, permission: { FunctionCall: { ...fc, allowance: "1" } } };
    const { txs } = plan(await statusOf(chain));
    assert.deepEqual(
      txs[0].actions.map((a) => a.publicKey),
      [KEYS.rk[1].publicKey, KEYS.rk[3].publicKey],
    );
    assert.match(txs[0].title, /relayer_key_2, relayer_key_4/);
  });

  it("sends nothing when all keys are present, and never re-adds a key with another permission", async () => {
    const chain = baseChain();
    const keys = chain.accounts[KEYS.relayer.implicitId].keys;
    for (const k of KEYS.rk.slice(0, 3)) keys[k.publicKey] = { nonce: 0, permission: { FunctionCall: fc } };
    keys[KEYS.rk[3].publicKey] = { nonce: 0, permission: "FullAccess" };
    const s = await statusOf(chain);
    assert.equal(s.relayer.keys[3].state, "wrong-permission");
    assert.deepEqual(plan(s).txs, []);
  });

  it("skips with a reason when the relayer is unfunded or the key file is not a full-access key", async () => {
    const unfunded = baseChain();
    delete unfunded.accounts[KEYS.relayer.implicitId];
    let r = plan(await statusOf(unfunded));
    assert.deepEqual(r.txs, []);
    assert.match(r.notes[0], /does not exist on chain/);

    const fcOnly = baseChain();
    fcOnly.accounts[KEYS.relayer.implicitId].keys[KEYS.relayer.publicKey].permission = { FunctionCall: fc };
    r = plan(await statusOf(fcOnly));
    assert.deepEqual(r.txs, []);
    assert.match(r.notes[0], /not a full-access key/);
  });
});

describe("(b) agent deposit", () => {
  const allKeys = () => {
    const chain = baseChain();
    for (const k of KEYS.rk) chain.accounts[KEYS.relayer.implicitId].keys[k.publicKey] = { nonce: 0, permission: { FunctionCall: fc } };
    return chain;
  };

  it("ft_transfer_call to intents.near crediting the agent's own Intents account, 1 yocto, 100 Tgas", async () => {
    const { txs } = plan(await statusOf(allKeys()), { deposit: { all: true } });
    assert.equal(txs.length, 1);
    const t = txs[0];
    assert.equal(t.signerId, KEYS.agent.implicitId);
    assert.equal(t.receiverId, "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1");
    assert.deepEqual(t.actions, [
      {
        type: "FunctionCall",
        methodName: "ft_transfer_call",
        args: { receiver_id: "intents.near", amount: "2500000", msg: KEYS.agent.implicitId },
        gas: 100n * 10n ** 12n,
        deposit: 1n,
      },
    ]);
    assert.equal(t.amount, 2_500_000n);
  });

  it("deposits a given amount and refuses more than the balance", async () => {
    const s = await statusOf(allKeys());
    assert.equal(plan(s, { deposit: parseDeposit("1.25") }).txs[0].actions[0].args.amount, "1250000");
    const r = plan(s, { deposit: parseDeposit("3") });
    assert.deepEqual(r.txs, []);
    assert.match(r.notes[0], /3000000 micro-USDC requested but the agent holds 2500000/);
  });

  it("registers intents.near's storage first when the token does not know it", async () => {
    const chain = allKeys();
    chain.usdcRegistered = false;
    const { txs } = plan(await statusOf(chain), { deposit: { all: true } });
    assert.deepEqual(txs[0].actions[0], {
      type: "FunctionCall",
      methodName: "storage_deposit",
      args: { account_id: "intents.near", registration_only: true },
      gas: 30n * 10n ** 12n,
      deposit: 1_250_000_000_000_000_000_000n,
    });
    assert.equal(txs[0].actions[1].methodName, "ft_transfer_call");
  });

  it("skips without native USDC, without NEAR for gas, or without --deposit", async () => {
    const empty = allKeys();
    empty.ft[KEYS.agent.implicitId] = "0";
    assert.match(plan(await statusOf(empty), { deposit: { all: true } }).notes[0], /holds no native USDC/);
    const noGas = allKeys();
    delete noGas.accounts[KEYS.agent.implicitId];
    assert.match(plan(await statusOf(noGas), { deposit: { all: true } }).notes[0], /no NEAR for gas/);
    assert.deepEqual(plan(await statusOf(allKeys())).txs, []);
  });

  it("deposit msg format", () => {
    assert.deepEqual(depositArgs("abc.near", 7n), { receiver_id: "intents.near", amount: "7", msg: "abc.near" });
  });

  it("parses --deposit", () => {
    assert.deepEqual(parseDeposit("all"), { all: true });
    assert.deepEqual(parseDeposit("2"), { amount: 2_000_000n });
    assert.deepEqual(parseDeposit("0.000001"), { amount: 1n });
    for (const bad of ["0", "-1", "1.0000001", "abc", "1e3", ""]) assert.throws(() => parseDeposit(bad), /--deposit/);
  });
});

describe("(c) intents.near add_public_key", () => {
  it("is skipped for implicit accounts (has_public_key is true by default)", async () => {
    const { txs } = plan(await statusOf(baseChain()));
    assert.ok(!txs.some((t) => t.id.endsWith("add-public-key")));
  });

  it("is planned when has_public_key is false, with 1 yocto and the account's own key", async () => {
    const chain = baseChain();
    chain.removedImplicit.add(KEYS.merchant.implicitId);
    const { txs } = plan(await statusOf(chain));
    const t = txs.find((x) => x.id === "merchant-add-public-key");
    assert.deepEqual(
      { signerId: t.signerId, receiverId: t.receiverId, actions: t.actions },
      {
        signerId: KEYS.merchant.implicitId,
        receiverId: "intents.near",
        actions: [{ type: "FunctionCall", methodName: "add_public_key", args: { public_key: KEYS.merchant.publicKey }, gas: 30n * 10n ** 12n, deposit: 1n }],
      },
    );
  });
});
