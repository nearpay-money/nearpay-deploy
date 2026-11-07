/**
 * Planned transaction → @near-js/transactions objects, and the human-readable description printed before
 * the owner confirms. The description is produced from the borsh-encoded bytes decoded again, so what is
 * printed is exactly what gets signed.
 */
import { PublicKey } from "@near-js/crypto";
import {
  actionCreators,
  createTransaction,
  decodeSignedTransaction,
  decodeTransaction,
  encodeTransaction,
} from "@near-js/transactions";
import { baseDecode, baseEncode, formatNearAmount } from "@near-js/utils";
import { TGAS } from "./constants.mjs";

/**
 * A planned transaction is plain data:
 *   { id, title, signerId, receiverId, actions: [
 *       { type: "AddKey", publicKey, permission: { receiverId, methodNames, allowance } }
 *     | { type: "FunctionCall", methodName, args, gas, deposit } ] }
 */
export function toNearActions(actions) {
  return actions.map((a) => {
    switch (a.type) {
      case "AddKey":
        return actionCreators.addKey(
          PublicKey.fromString(a.publicKey),
          actionCreators.functionCallAccessKey(a.permission.receiverId, [...a.permission.methodNames], a.permission.allowance),
        );
      case "FunctionCall":
        return actionCreators.functionCall(a.methodName, a.args, a.gas, a.deposit);
      default:
        throw new Error(`unsupported action ${a.type}`);
    }
  });
}

/** Unsigned Transaction for `planned`, signed with `publicKey` at `nonce` against `blockHash` (base58). */
export function buildTransaction(planned, { publicKey, nonce, blockHash }) {
  return createTransaction(
    planned.signerId,
    PublicKey.fromString(publicKey),
    planned.receiverId,
    BigInt(nonce),
    toNearActions(planned.actions),
    baseDecode(blockHash),
  );
}

const pk = (p) => {
  const k = p.ed25519Key ?? p.secp256k1Key;
  return `${p.ed25519Key ? "ed25519" : "secp256k1"}:${baseEncode(Uint8Array.from(k.data))}`;
};
const bytes = (a) => Buffer.from(Uint8Array.from(a));

/** Decoded (plain) actions of a transaction in a stable, comparable shape. */
export function normalizeActions(decodedActions) {
  return decodedActions.map((a) => {
    if (a.addKey) {
      const perm = a.addKey.accessKey.permission;
      return {
        type: "AddKey",
        publicKey: pk(a.addKey.publicKey),
        permission: perm.fullAccess
          ? "FullAccess"
          : {
              receiverId: perm.functionCall.receiverId,
              methodNames: [...perm.functionCall.methodNames],
              allowance: perm.functionCall.allowance == null ? null : BigInt(perm.functionCall.allowance),
            },
      };
    }
    if (a.functionCall) {
      const raw = bytes(a.functionCall.args).toString("utf8");
      let args;
      try {
        args = JSON.parse(raw);
      } catch {
        args = raw;
      }
      return {
        type: "FunctionCall",
        methodName: a.functionCall.methodName,
        args,
        gas: BigInt(a.functionCall.gas),
        deposit: BigInt(a.functionCall.deposit),
      };
    }
    return { type: Object.keys(a)[0] ?? "unknown" };
  });
}

export function decodeTx(bytesOrTx) {
  const t = bytesOrTx instanceof Uint8Array ? decodeTransaction(bytesOrTx) : decodeTransaction(encodeTransaction(bytesOrTx));
  return {
    signerId: t.signerId,
    publicKey: pk(t.publicKey),
    nonce: BigInt(t.nonce),
    receiverId: t.receiverId,
    blockHash: baseEncode(Uint8Array.from(t.blockHash)),
    actions: normalizeActions(t.actions),
  };
}

export function decodeSignedTx(signedBytes) {
  const s = decodeSignedTransaction(signedBytes);
  return { ...decodeTx(encodeTransaction(s.transaction)), signature: bytes(s.signature.ed25519Signature?.data ?? s.signature.data ?? []) };
}

export const near = (yocto) => `${formatNearAmount(BigInt(yocto).toString(), 5)} NEAR`;
const deposit = (y) => (y === 0n ? "0" : y < 10n ** 18n ? `${y} yoctoNEAR` : near(y));
const gas = (g) => `${Number(g / TGAS)} Tgas`;

/** Lines describing a transaction (from its bytes). */
export function describe(title, transaction) {
  const t = decodeTx(transaction);
  const lines = [
    `  ${title}`,
    `    signer    ${t.signerId}`,
    `    key       ${t.publicKey} (nonce ${t.nonce})`,
    `    receiver  ${t.receiverId}`,
  ];
  let totalDeposit = 0n;
  let totalGas = 0n;
  t.actions.forEach((a, i) => {
    if (a.type === "AddKey") {
      const p = a.permission;
      lines.push(
        p === "FullAccess"
          ? `    action ${i + 1}  AddKey ${a.publicKey} FULL ACCESS`
          : `    action ${i + 1}  AddKey ${a.publicKey} function-call: receiver ${p.receiverId}, methods [${p.methodNames.join(", ")}], allowance ${p.allowance === null ? "unlimited" : near(p.allowance)}`,
      );
    } else if (a.type === "FunctionCall") {
      totalDeposit += a.deposit;
      totalGas += a.gas;
      lines.push(
        `    action ${i + 1}  FunctionCall ${a.methodName}(${typeof a.args === "string" ? a.args : JSON.stringify(a.args)}) gas ${gas(a.gas)}, deposit ${deposit(a.deposit)}`,
      );
    } else lines.push(`    action ${i + 1}  ${a.type}`);
  });
  lines.push(`    total     deposit ${deposit(totalDeposit)}, gas ${totalGas === 0n ? "n/a (AddKey only)" : gas(totalGas)}`);
  return lines;
}
