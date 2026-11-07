import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { checkOutcome, run } from "../lib/main.mjs";
import { ALL_SECRETS, baseChain, collector, fakeRpc, KEYS, makeDeployDir } from "./fixtures.mjs";

function harness({ chain = baseChain(), deploy = makeDeployDir(), prompt, onSend } = {}) {
  const rpc = fakeRpc(chain, { onSend });
  const c = collector();
  const prompts = [];
  const io = {
    deployDir: deploy,
    cwd: deploy,
    fetch: rpc.fetch,
    readFile: (p) => readFileSync(p, "utf8"),
    exists: existsSync,
    out: c.out,
    prompt: prompt === undefined ? undefined : async (q) => (prompts.push(q), prompt),
  };
  return { rpc, c, io, prompts, deploy, go: (...argv) => run(argv, io) };
}
const assertNoSecrets = (text) => {
  for (const s of ALL_SECRETS) assert.ok(!text.includes(s), "output contains a private key");
};
const methods = (rpc) => rpc.calls.map((c) => c.method);

describe("dry run (default)", () => {
  it("prints status and next steps and sends nothing", async () => {
    const chain = baseChain();
    delete chain.accounts[KEYS.relayer.implicitId];
    chain.ft[KEYS.agent.implicitId] = "0";
    const h = harness({ chain, prompt: "y" });
    assert.equal(await h.go(), 0);
    const out = h.c.text();
    assert.ok(!methods(h.rpc).includes("send_tx"), "no send_tx");
    assert.equal(h.rpc.sent.length, 0);
    assert.ok(!h.rpc.calls.some((c) => c.params?.request_type === "view_access_key"), "no nonce lookups: nothing was built");
    assert.equal(h.prompts.length, 0);
    assert.match(out, /RPC https:\/\/rpc\.up\.example/, "first answering RPC from local.env");
    assert.match(out, new RegExp(`Fund the relayer: send at least 1 NEAR to ${KEYS.relayer.implicitId}`));
    assert.match(out, new RegExp(`send at least 1 native USDC on NEAR \\(token 17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1\\) to ${KEYS.agent.implicitId}`));
    assert.match(out, /Dry run: nothing was built, signed or sent/);
    assertNoSecrets(out);
  });

  it("lists present and missing relayer keys and suggests --apply", async () => {
    const chain = baseChain();
    chain.accounts[KEYS.relayer.implicitId].keys[KEYS.rk[1].publicKey] = {
      nonce: 0,
      permission: { FunctionCall: { allowance: "5000000000000000000000000", receiver_id: "intents.near", method_names: ["execute_intents"] } },
    };
    const h = harness({ chain });
    await h.go();
    const out = h.c.text();
    assert.match(out, /relayer_key_2 +ed25519:\S+ +present: function-call intents\.near \[execute_intents\] allowance 5 NEAR/);
    assert.match(out, /relayer_key_1 +ed25519:\S+ +missing/);
    assert.match(out, /Run with --apply to add relayer_key_1, relayer_key_3, relayer_key_4/);
    assert.match(out, /Run with --apply --deposit all to move the agent's 2\.5 native USDC/);
  });

  it("reports when everything is done", async () => {
    const chain = baseChain();
    for (const k of KEYS.rk)
      chain.accounts[KEYS.relayer.implicitId].keys[k.publicKey] = {
        nonce: 0,
        permission: { FunctionCall: { allowance: "5000000000000000000000000", receiver_id: "intents.near", method_names: ["execute_intents"] } },
      };
    chain.ft[KEYS.agent.implicitId] = "0";
    chain.mt[KEYS.agent.implicitId] = "1000000";
    const h = harness({ chain });
    await h.go();
    assert.match(h.c.text(), /On-chain setup is complete/);
  });
});

describe("--apply confirmation gating", () => {
  it("answer other than y sends nothing", async () => {
    const h = harness({ prompt: "n" });
    assert.equal(await h.go("--apply"), 1);
    assert.equal(h.prompts.length, 1);
    assert.match(h.prompts[0], /Sign and send 1 transaction\(s\) on mainnet\? \[y\/N\]/);
    assert.equal(h.rpc.sent.length, 0);
    assert.ok(!methods(h.rpc).includes("send_tx"));
    assert.match(h.c.text(), /Not confirmed; nothing was sent/);
    assert.match(h.c.text(), /Transactions to sign and send \(1\)/, "printed before asking");
  });

  it("no terminal and no --yes sends nothing", async () => {
    const h = harness();
    assert.equal(await h.go("--apply"), 1);
    assert.equal(h.rpc.sent.length, 0);
    assert.match(h.c.text(), /Re-run with --yes/);
  });

  it("interactive y sends", async () => {
    const h = harness({ prompt: "y" });
    assert.equal(await h.go("--apply"), 0);
    assert.equal(h.rpc.sent.length, 1);
  });

  it("--yes sends without asking", async () => {
    const h = harness({ prompt: "n" });
    assert.equal(await h.go("--apply", "--yes"), 0);
    assert.equal(h.prompts.length, 0);
    assert.equal(h.rpc.sent.length, 1);
  });

  it("--yes and --deposit need --apply", async () => {
    for (const argv of [["--yes"], ["--deposit", "all"]]) {
      const h = harness();
      assert.equal(await h.go(...argv), 2);
      assert.match(h.c.text(), /only makes sense with --apply/);
      assert.equal(h.rpc.calls.length, 0);
    }
  });
});

describe("--apply end to end (fake chain)", () => {
  it("adds the relayer keys, deposits USDC, prints links, and a second run sends nothing", async () => {
    const chain = baseChain();
    const h = harness({ chain });
    assert.equal(await h.go("--apply", "--deposit", "all", "--yes"), 0);
    const out = h.c.text();
    assert.equal(h.rpc.sent.length, 2);
    const [keys, dep] = h.rpc.sent;
    assert.equal(keys.signerId, KEYS.relayer.implicitId);
    assert.equal(keys.nonce, 101n, "access-key nonce + 1");
    assert.deepEqual(
      keys.actions.map((a) => a.publicKey),
      KEYS.rk.map((k) => k.publicKey),
    );
    assert.equal(dep.signerId, KEYS.agent.implicitId);
    assert.deepEqual(dep.actions[0].args, { receiver_id: "intents.near", amount: "2500000", msg: KEYS.agent.implicitId });
    for (const s of h.rpc.sent) assert.ok(out.includes(`https://nearblocks.io/txns/${s.hash}`));
    assert.match(out, /signer    [0-9a-f]{64}/);
    assert.match(out, /intents\.near credited 2500000 micro-USDC/);
    assert.match(out, /Status after apply/);
    assert.equal(chain.mt[KEYS.agent.implicitId], "2500000");
    assertNoSecrets(out);

    const again = harness({ chain, deploy: h.deploy });
    assert.equal(await again.go("--apply", "--deposit", "all", "--yes"), 0);
    assert.equal(again.rpc.sent.length, 0);
    assert.match(again.c.text(), /Nothing to send/);
    assert.match(again.c.text(), /holds no native USDC/);
  });

  it("uses consecutive nonces when one signer sends two transactions", async () => {
    const chain = baseChain();
    chain.removedImplicit.add(KEYS.agent.implicitId);
    const h = harness({ chain });
    assert.equal(await h.go("--apply", "--deposit", "1", "--yes"), 0);
    const agentTxs = h.rpc.sent.filter((t) => t.signerId === KEYS.agent.implicitId);
    assert.deepEqual(
      agentTxs.map((t) => [t.actions[0].methodName, t.nonce]),
      [
        ["ft_transfer_call", 101n],
        ["add_public_key", 102n],
      ],
    );
  });

  it("stops after a failed transaction", async () => {
    const h = harness({ onSend: () => ({ status: { Failure: { ActionError: { kind: "x" } } }, final_execution_status: "FINAL" }) });
    assert.equal(await h.go("--apply", "--deposit", "all", "--yes"), 1);
    assert.equal(h.rpc.sent.length, 1);
    assert.match(h.c.text(), /FAILED/);
    assert.match(h.c.text(), /later transactions were not sent/);
  });

  it("reads key files from overridable paths only", async () => {
    const deploy = makeDeployDir();
    const moved = makeDeployDir();
    rmSync(join(deploy, ".secrets", "accounts", "agent.json"));
    const h = harness({ deploy });
    await h.go("--agent", join(moved, ".secrets", "accounts", "agent.json"), "--secrets", join(deploy, ".secrets"));
    assert.match(h.c.text(), new RegExp(`agent +${KEYS.agent.implicitId}`));
    const h2 = harness({ deploy });
    await h2.go();
    assert.match(h2.c.text(), /agent +\.secrets\/accounts\/agent\.json: file not found/);
  });
});

describe("outcome checks", () => {
  const ok = (v) => ({ status: { SuccessValue: Buffer.from(v).toString("base64") }, final_execution_status: "FINAL", receipts_outcome: [] });
  it("treats a refunded deposit as a failure", () => {
    const p = { id: "agent-deposit", amount: 5n };
    assert.equal(checkOutcome(p, ok('"5"')).ok, true);
    const r = checkOutcome(p, ok('"0"'));
    assert.equal(r.ok, false);
    assert.match(r.lines[0], /kept 0 of 5/);
  });
  it("flags failed receipts", () => {
    const o = { ...ok(""), receipts_outcome: [{ id: "R", outcome: { status: { Failure: { x: 1 } } } }] };
    assert.equal(checkOutcome({ id: "relayer-keys" }, o).ok, false);
  });
});
