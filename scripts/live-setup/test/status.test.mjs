import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RELAYER_KEY_ALLOWANCE } from "../lib/constants.mjs";
import { loadInputs, parseArgs } from "../lib/inputs.mjs";
import { connect, createRpc } from "../lib/rpc.mjs";
import { gatherStatus, matchesRelayerPolicy, normalizePermission } from "../lib/status.mjs";
import { existsSync, readFileSync } from "node:fs";
import { baseChain, fakeRpc, KEYS, makeDeployDir } from "./fixtures.mjs";

const io = { readFile: (p) => readFileSync(p, "utf8"), exists: existsSync };
const inputsFor = (deploy) => loadInputs(parseArgs([], { deployDir: deploy }), io);
const fcPerm = (over = {}) => ({
  FunctionCall: { allowance: RELAYER_KEY_ALLOWANCE.toString(), receiver_id: "intents.near", method_names: ["execute_intents"], ...over },
});

describe("permissions", () => {
  it("normalizes RPC permissions", () => {
    assert.deepEqual(normalizePermission("FullAccess"), { type: "FullAccess" });
    assert.deepEqual(normalizePermission(fcPerm()), {
      type: "FunctionCall",
      receiverId: "intents.near",
      methodNames: ["execute_intents"],
      allowance: RELAYER_KEY_ALLOWANCE,
    });
    assert.equal(normalizePermission(fcPerm({ allowance: null })).allowance, null);
  });

  it("matches only the agentpay relayer policy", () => {
    const p = (o) => normalizePermission(fcPerm(o));
    assert.ok(matchesRelayerPolicy(p({})));
    assert.ok(matchesRelayerPolicy(p({ allowance: "4000000000000000000000000" })), "spent allowance is fine");
    assert.ok(!matchesRelayerPolicy(p({ allowance: null })), "unlimited allowance");
    assert.ok(!matchesRelayerPolicy(p({ allowance: "6000000000000000000000000" })));
    assert.ok(!matchesRelayerPolicy(p({ receiver_id: "wrap.near" })));
    assert.ok(!matchesRelayerPolicy(p({ method_names: [] })), "empty = any method");
    assert.ok(!matchesRelayerPolicy(p({ method_names: ["execute_intents", "add_public_key"] })));
    assert.ok(!matchesRelayerPolicy(normalizePermission("FullAccess")));
  });
});

describe("rpc", () => {
  it("uses the first RPC that answers", async () => {
    const f = fakeRpc();
    const rpc = await connect(["https://rpc.down.example", "https://rpc.up.example"], { fetch: f.fetch });
    assert.equal(rpc.url, "https://rpc.up.example");
  });

  it("fails clearly when no RPC answers", async () => {
    const f = fakeRpc();
    await assert.rejects(connect(["https://a.down", "https://b.down"], { fetch: f.fetch }), /no NEAR RPC answered:[\s\S]*a\.down[\s\S]*b\.down/);
  });

  it("send_tx waits for FINAL and falls back to polling tx after an RPC timeout", async () => {
    const seen = [];
    const fetch = async (_url, init) => {
      const req = JSON.parse(init.body);
      seen.push([req.method, req.params]);
      const body =
        req.method === "send_tx"
          ? { error: { name: "HANDLER_ERROR", cause: { name: "TIMEOUT_ERROR" }, code: -32000, message: "Server error", data: "Timeout" } }
          : { result: { status: { SuccessValue: "" }, final_execution_status: "FINAL" } };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, ...body }));
    };
    const rpc = createRpc("https://rpc.up.example", { fetch });
    const r = await rpc.sendTx("AAAA", { hash: "H", signerId: "s.near" });
    assert.equal(r.final_execution_status, "FINAL");
    assert.deepEqual(seen, [
      ["send_tx", { signed_tx_base64: "AAAA", wait_until: "FINAL" }],
      ["tx", { tx_hash: "H", sender_account_id: "s.near", wait_until: "FINAL" }],
    ]);
  });

  it("maps UNKNOWN_ACCOUNT to null / [] and surfaces other errors", async () => {
    const f = fakeRpc();
    const rpc = createRpc("https://rpc.up.example", { fetch: f.fetch });
    assert.equal(await rpc.viewAccount("nobody.near"), null);
    assert.deepEqual(await rpc.accessKeyList("nobody.near"), []);
    await assert.rejects(rpc.view("intents.near", "no_such_method", {}), /MethodNotFound/);
  });
});

describe("status", () => {
  it("reports accounts, relayer keys, balances and Verifier keys", async () => {
    const chain = baseChain();
    const relayerKeys = chain.accounts[KEYS.relayer.implicitId].keys;
    relayerKeys[KEYS.rk[0].publicKey] = { nonce: 0, permission: fcPerm({ allowance: "4200000000000000000000000" }) };
    relayerKeys[KEYS.rk[2].publicKey] = { nonce: 0, permission: fcPerm({ receiver_id: "wrap.near" }) };
    delete chain.accounts[KEYS.treasury.implicitId];
    chain.mt[KEYS.agent.implicitId] = "1500000";
    chain.removedImplicit.add(KEYS.merchant.implicitId);
    const f = fakeRpc(chain);
    const rpc = createRpc("https://rpc.up.example", { fetch: f.fetch });
    const s = await gatherStatus(rpc, inputsFor(makeDeployDir()));

    assert.equal(s.accounts.treasury.exists, false);
    assert.equal(s.accounts.relayer.exists, true);
    assert.equal(s.accounts.relayer.balance, 2n * 10n ** 24n);
    assert.equal(s.relayer.fullAccess, true);
    assert.deepEqual(
      s.relayer.keys.map((k) => [k.n, k.state]),
      [
        [1, "present"],
        [2, "missing"],
        [3, "wrong-permission"],
        [4, "missing"],
      ],
    );
    assert.equal(s.relayer.keys[0].permission.allowance, 4_200_000n * 10n ** 18n);
    assert.equal(s.agent.usdc, 2_500_000n);
    assert.equal(s.agent.intentsUsdc, 1_500_000n);
    assert.equal(s.agent.hasPublicKey, true, "implicit account: Verifier knows its key by default");
    assert.equal(s.merchant.hasPublicKey, false, "implicit key explicitly removed");
    assert.equal(s.usdc.intentsRegistered, true);
    assert.deepEqual(s.errors, []);
    assert.ok(!f.calls.some((c) => c.method === "send_tx"));
  });

  it("queries the right contracts and args", async () => {
    const f = fakeRpc();
    await gatherStatus(createRpc("https://rpc.up.example", { fetch: f.fetch }), inputsFor(makeDeployDir()));
    const views = f.calls
      .filter((c) => c.params?.request_type === "call_function")
      .map((c) => [c.params.account_id, c.params.method_name, JSON.parse(Buffer.from(c.params.args_base64, "base64"))]);
    assert.deepEqual(views, [
      ["17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "ft_balance_of", { account_id: KEYS.agent.implicitId }],
      [
        "intents.near",
        "mt_balance_of",
        { account_id: KEYS.agent.implicitId, token_id: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1" },
      ],
      ["intents.near", "has_public_key", { account_id: KEYS.agent.implicitId, public_key: KEYS.agent.publicKey }],
      ["intents.near", "has_public_key", { account_id: KEYS.merchant.implicitId, public_key: KEYS.merchant.publicKey }],
      ["17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "storage_balance_of", { account_id: "intents.near" }],
    ]);
    assert.ok(f.calls.every((c) => !c.params?.finality || c.params.finality === "final"));
  });

  it("handles an unfunded relayer and missing key files", async () => {
    const chain = baseChain();
    delete chain.accounts[KEYS.relayer.implicitId];
    const f = fakeRpc(chain);
    const s = await gatherStatus(createRpc("https://rpc.up.example", { fetch: f.fetch }), inputsFor(makeDeployDir({ relayerKeys: [1, 2] })));
    assert.equal(s.accounts.relayer.exists, false);
    assert.equal(s.relayer.fullAccess, false);
    assert.deepEqual(
      s.relayer.keys.map((k) => k.state),
      ["missing", "missing", "file-problem", "file-problem"],
    );
    assert.match(s.relayer.keys[2].error, /file not found/);
  });
});
