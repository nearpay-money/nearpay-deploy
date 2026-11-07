/**
 * Key files. Accounts: near-cli JSON `{account_id, public_key, private_key}`; relayer function-call keys:
 * the same JSON (account_id = the relayer) or a bare `ed25519:<base58>` (both accepted by seed.sh live and
 * agentpay `parseKeyFile`). The secret never leaves this module as a value: callers get an object with the
 * account id, the public key and a `sign(transaction)` closure, which prints as `[key <account> <public key>]`.
 */
import { KeyPair, PublicKey } from "@near-js/crypto";
import { KeyPairSigner } from "@near-js/signers";

const IMPLICIT = /^[0-9a-f]{64}$/;

export const isImplicit = (accountId) => IMPLICIT.test(accountId);

/** Hex (implicit) account id of an ed25519 public key `ed25519:<base58>`. */
export const implicitIdOf = (publicKey) => Buffer.from(PublicKey.fromString(publicKey).data).toString("hex");

class KeyFileError extends Error {}

/**
 * Parses key-file content. `expectAccount` (optional) must equal the file's account_id when it has one.
 * `accountKey`: the file holds the account's own key, so an implicit account_id must be the hex of it (false
 * for extra keys such as the relayer's function-call keys).
 * Errors name the file and the problem, never the content.
 */
export function parseKeyFile(content, { file = "key file", expectAccount, requireAccount = false, accountKey = true } = {}) {
  let accountId;
  let declaredPublic;
  let secret = String(content).trim();
  if (secret.startsWith("{")) {
    let j;
    try {
      j = JSON.parse(secret);
    } catch {
      throw new KeyFileError(`${file}: not valid JSON`);
    }
    accountId = typeof j.account_id === "string" ? j.account_id.trim() : undefined;
    declaredPublic = typeof j.public_key === "string" ? j.public_key.trim() : undefined;
    secret = String(j.private_key ?? j.secret_key ?? "").trim();
  } else if (requireAccount) {
    throw new KeyFileError(`${file}: expected near-cli JSON {account_id, public_key, private_key}`);
  }
  if (!secret.startsWith("ed25519:")) throw new KeyFileError(`${file}: private_key must be "ed25519:<base58>"`);
  let kp;
  try {
    kp = KeyPair.fromString(secret);
  } catch {
    throw new KeyFileError(`${file}: private_key is not a valid ed25519 secret key`);
  }
  secret = undefined;
  const publicKey = kp.getPublicKey().toString();
  if (declaredPublic && declaredPublic !== publicKey)
    throw new KeyFileError(`${file}: public_key does not match private_key (derived ${publicKey})`);
  if (requireAccount && !accountId) throw new KeyFileError(`${file}: account_id is missing`);
  if (expectAccount && accountId && accountId !== expectAccount)
    throw new KeyFileError(`${file}: account_id ${accountId} is not the expected account ${expectAccount}`);
  const implicitId = Buffer.from(kp.getPublicKey().data).toString("hex");
  if (accountKey && accountId && isImplicit(accountId) && accountId !== implicitId)
    throw new KeyFileError(`${file}: implicit account_id ${accountId} is not the hex of its public key (${implicitId})`);
  return makeKey(accountId ?? expectAccount, publicKey, implicitId, kp);
}

function makeKey(accountId, publicKey, implicitId, kp) {
  const signer = new KeyPairSigner(kp);
  const key = {
    accountId,
    publicKey,
    implicitId,
    /** Signs a `Transaction` from @near-js/transactions → `[hash, SignedTransaction]`. */
    sign: (transaction) => signer.signTransaction(transaction),
    toString: () => `[key ${accountId ?? "?"} ${publicKey}]`,
    toJSON: () => ({ accountId, publicKey }),
    [Symbol.for("nodejs.util.inspect.custom")]: () => `[key ${accountId ?? "?"} ${publicKey}]`,
  };
  return Object.freeze(key);
}

export { KeyFileError };
