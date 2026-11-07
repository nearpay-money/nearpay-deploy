import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { describe, it } from "node:test";
import { decodeSignedTransaction, decodeTransaction, encodeTransaction } from "@near-js/transactions";
import { baseEncode } from "@near-js/utils";
import { parseKeyFile } from "../lib/keys.mjs";
import { depositArgs, relayerKeyAction } from "../lib/plan.mjs";
import { buildTransaction, decodeSignedTx, decodeTx, describe as describeTx } from "../lib/tx.mjs";
import { BLOCK_HASH, KEYS, nearCliJson } from "./fixtures.mjs";

const relayer = parseKeyFile(nearCliJson(KEYS.relayer), { requireAccount: true });
const agent = parseKeyFile(nearCliJson(KEYS.agent), { requireAccount: true });
const FIVE_NEAR = 5n * 10n ** 24n;

const addKeys = {
  signerId: relayer.accountId,
  receiverId: relayer.accountId,
  actions: KEYS.rk.slice(1).map((k) => relayerKeyAction(k.publicKey)),
};
const deposit = {
  signerId: agent.accountId,
  receiverId: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  actions: [{ type: "FunctionCall", methodName: "ft_transfer_call", args: depositArgs(agent.accountId, 2_500_000n), gas: 100n * 10n ** 12n, deposit: 1n }],
};

describe("serialized transactions", () => {
  it("add-key bytes deserialize with @near-js/transactions to the intended actions", async () => {
    const t = buildTransaction(addKeys, { publicKey: relayer.publicKey, nonce: 101n, blockHash: BLOCK_HASH });
    const [hash, signed] = await relayer.sign(t);
    const bytes = signed.encode();

    // Raw library decode, independent of our normalizer.
    const raw = decodeSignedTransaction(bytes);
    assert.equal(raw.transaction.signerId, KEYS.relayer.implicitId);
    assert.equal(raw.transaction.receiverId, KEYS.relayer.implicitId);
    assert.equal(BigInt(raw.transaction.nonce), 101n);
    assert.equal(baseEncode(Uint8Array.from(raw.transaction.blockHash)), BLOCK_HASH);
    assert.equal(raw.transaction.actions.length, 3);
    raw.transaction.actions.forEach((a, i) => {
      assert.deepEqual(Object.keys(a), ["addKey"]);
      assert.equal(`ed25519:${baseEncode(Uint8Array.from(a.addKey.publicKey.ed25519Key.data))}`, KEYS.rk[i + 1].publicKey);
      assert.equal(BigInt(a.addKey.accessKey.nonce), 0n);
      assert.deepEqual(Object.keys(a.addKey.accessKey.permission), ["functionCall"]);
      const fc = a.addKey.accessKey.permission.functionCall;
      assert.equal(BigInt(fc.allowance), FIVE_NEAR);
      assert.equal(fc.receiverId, "intents.near");
      assert.deepEqual([...fc.methodNames], ["execute_intents"]);
    });

    // The hash is sha256 of the unsigned bytes and the signature verifies with the relayer's public key.
    const msg = encodeTransaction(raw.transaction);
    assert.deepEqual(Buffer.from(hash), createHash("sha256").update(msg).digest());
    const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: KEYS.relayer.pubRaw.toString("base64url") }, format: "jwk" });
    assert.ok(verify(null, createHash("sha256").update(msg).digest(), pub, Buffer.from(decodeSignedTx(bytes).signature)));

    // Our normalizer agrees.
    assert.deepEqual(decodeSignedTx(bytes).actions, addKeys.actions);
  });

  it("ft_transfer_call bytes deserialize to the intended call", async () => {
    const t = buildTransaction(deposit, { publicKey: agent.publicKey, nonce: 7n, blockHash: BLOCK_HASH });
    const [, signed] = await agent.sign(t);
    const raw = decodeSignedTransaction(signed.encode());
    const fc = raw.transaction.actions[0].functionCall;
    assert.equal(fc.methodName, "ft_transfer_call");
    assert.deepEqual(JSON.parse(Buffer.from(Uint8Array.from(fc.args)).toString("utf8")), {
      receiver_id: "intents.near",
      amount: "2500000",
      msg: KEYS.agent.implicitId,
    });
    assert.equal(BigInt(fc.gas), 100n * 10n ** 12n);
    assert.equal(BigInt(fc.deposit), 1n);
    assert.equal(raw.transaction.receiverId, deposit.receiverId);
    assert.deepEqual(decodeTx(decodeTransaction(encodeTransaction(t))).actions, deposit.actions);
  });

  it("refuses to sign with a key that is not the transaction's key", async () => {
    const t = buildTransaction(deposit, { publicKey: agent.publicKey, nonce: 7n, blockHash: BLOCK_HASH });
    await assert.rejects(relayer.sign(t), /doesn't match/);
  });

  it("the printed description comes from the bytes and shows signer, receiver, actions, deposit, gas", () => {
    const lines = describeTx("T", buildTransaction(addKeys, { publicKey: relayer.publicKey, nonce: 101n, blockHash: BLOCK_HASH })).join("\n");
    assert.match(lines, new RegExp(`signer    ${KEYS.relayer.implicitId}`));
    assert.match(lines, new RegExp(`receiver  ${KEYS.relayer.implicitId}`));
    assert.match(lines, /AddKey ed25519:\S+ function-call: receiver intents\.near, methods \[execute_intents\], allowance 5 NEAR/);
    assert.match(lines, /total     deposit 0, gas n\/a/);
    const d = describeTx("D", buildTransaction(deposit, { publicKey: agent.publicKey, nonce: 7n, blockHash: BLOCK_HASH })).join("\n");
    assert.match(d, /FunctionCall ft_transfer_call\(\{"receiver_id":"intents.near","amount":"2500000","msg":"[0-9a-f]{64}"\}\) gas 100 Tgas, deposit 1 yoctoNEAR/);
  });
});
