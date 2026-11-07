import assert from "node:assert/strict";
import { inspect } from "node:util";
import { describe, it } from "node:test";
import { implicitIdOf, isImplicit, parseKeyFile } from "../lib/keys.mjs";
import { KEYS, nearCliJson } from "./fixtures.mjs";

describe("key files", () => {
  it("parses near-cli JSON of an implicit account and derives its public key", () => {
    const k = parseKeyFile(nearCliJson(KEYS.agent), { requireAccount: true });
    assert.equal(k.accountId, KEYS.agent.implicitId);
    assert.equal(k.publicKey, KEYS.agent.publicKey);
    assert.equal(implicitIdOf(k.publicKey), KEYS.agent.implicitId);
    assert.ok(isImplicit(k.accountId));
  });

  it("accepts a bare ed25519:<base58> relayer key and takes the expected account", () => {
    const k = parseKeyFile(KEYS.rk[0].secret, { expectAccount: KEYS.relayer.implicitId });
    assert.equal(k.publicKey, KEYS.rk[0].publicKey);
    assert.equal(k.accountId, KEYS.relayer.implicitId);
  });

  it("rejects a relayer key file that names another account", () => {
    assert.throws(
      () => parseKeyFile(nearCliJson(KEYS.rk[0], KEYS.agent.implicitId), { file: "relayer_key_1", expectAccount: KEYS.relayer.implicitId }),
      /relayer_key_1: account_id .* is not the expected account/,
    );
  });

  it("rejects a public_key that does not match the private key", () => {
    const bad = JSON.stringify({ account_id: KEYS.agent.implicitId, public_key: KEYS.merchant.publicKey, private_key: KEYS.agent.secret });
    assert.throws(() => parseKeyFile(bad, { file: "agent.json" }), /public_key does not match private_key/);
  });

  it("rejects an implicit account id that is not the hex of the key", () => {
    assert.throws(() => parseKeyFile(nearCliJson(KEYS.agent, KEYS.merchant.implicitId)), /is not the hex of its public key/);
  });

  it("requires JSON with account_id for account files", () => {
    assert.throws(() => parseKeyFile(KEYS.agent.secret, { file: "agent.json", requireAccount: true }), /expected near-cli JSON/);
    assert.throws(() => parseKeyFile("{not json", { file: "agent.json" }), /agent.json: not valid JSON/);
  });

  it("errors never echo the secret", () => {
    const broken = JSON.stringify({ account_id: "x.near", private_key: `${KEYS.agent.secret}zz` });
    try {
      parseKeyFile(broken, { file: "f" });
      assert.fail("should throw");
    } catch (e) {
      assert.ok(!e.message.includes(KEYS.agent.secret.slice(8, 30)));
    }
  });

  it("the key object prints without its secret (String, JSON, inspect, keys)", () => {
    const k = parseKeyFile(nearCliJson(KEYS.relayer), { requireAccount: true });
    const renderings = [String(k), JSON.stringify(k), inspect(k, { depth: 10, showHidden: true }), Object.keys(k).join(",")];
    for (const r of renderings) {
      assert.ok(!r.includes(KEYS.relayer.secret.slice(8)), r);
      assert.ok(!r.includes(KEYS.relayer.secret.slice(8, 40)), r);
    }
    assert.ok(Object.isFrozen(k));
  });
});
