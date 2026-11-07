/**
 * Minimal NEAR JSON-RPC client over an injected `fetch` (tests pass a fake; the CLI passes globalThis.fetch).
 * @near-js/providers' JsonRpcProvider calls the global fetch directly (lib/esm/fetch_json.js), so it cannot
 * be pointed at a fake RPC without patching globals; the handful of methods needed here are small enough to
 * own. Every read uses finality "final".
 */

export class RpcError extends Error {
  constructor(message, { name, cause, data, url } = {}) {
    super(message);
    this.rpcName = name;
    this.causeName = cause;
    this.data = data;
    this.url = url;
  }
}

const b64 = (s) => Buffer.from(s).toString("base64");

/** First URL that answers `status` wins; the rest are not tried again. */
export async function connect(urls, { fetch, timeoutMs = 10_000 } = {}) {
  const failures = [];
  for (const url of urls) {
    const rpc = createRpc(url, { fetch, timeoutMs });
    try {
      const st = await rpc.call("status", []);
      if (st?.chain_id && st.chain_id !== "mainnet") throw new Error(`chain_id is ${st.chain_id}, not mainnet`);
      return rpc;
    } catch (e) {
      failures.push(`${url}: ${e.message}`);
    }
  }
  throw new Error(`no NEAR RPC answered:\n  ${failures.join("\n  ")}`);
}

export function createRpc(url, { fetch, timeoutMs = 10_000 } = {}) {
  if (typeof fetch !== "function") throw new Error("createRpc: fetch is required");
  let id = 0;

  async function call(method, params, { timeout = timeoutMs } = {}) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: `np-${++id}`, method, params }),
      signal: AbortSignal.timeout(timeout),
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new RpcError(`${method}: HTTP ${res.status} with a non-JSON body`, { url });
    }
    if (body.error) {
      const e = body.error;
      const causeName = e.cause?.name;
      const data = typeof e.data === "string" ? e.data : JSON.stringify(e.data ?? e.cause?.info ?? "");
      throw new RpcError(`${method}: ${causeName ?? e.name ?? e.message} ${data}`.trim(), {
        name: e.name,
        cause: causeName,
        data,
        url,
      });
    }
    if (!res.ok) throw new RpcError(`${method}: HTTP ${res.status}`, { url });
    // Older nodes report query errors inside result.error.
    if (typeof body.result?.error === "string") throw new RpcError(`${method}: ${body.result.error}`, { data: body.result.error, url });
    return body.result;
  }

  const unknownAccount = (e) =>
    e instanceof RpcError && (e.causeName === "UNKNOWN_ACCOUNT" || /does not exist/.test(e.data ?? e.message));

  return {
    url,
    call,
    /** `null` when the account does not exist (an implicit account appears on its first transfer). */
    async viewAccount(accountId) {
      try {
        return await call("query", { request_type: "view_account", finality: "final", account_id: accountId });
      } catch (e) {
        if (unknownAccount(e)) return null;
        throw e;
      }
    },
    /** `[]` for a missing account. Entries: `{public_key, access_key: {nonce, permission}}`. */
    async accessKeyList(accountId) {
      try {
        const r = await call("query", { request_type: "view_access_key_list", finality: "final", account_id: accountId });
        return r.keys ?? [];
      } catch (e) {
        if (unknownAccount(e)) return [];
        throw e;
      }
    },
    /** `{nonce, permission, block_hash}`; block_hash is a final block, usable as the transaction's block hash. */
    accessKey(accountId, publicKey) {
      return call("query", {
        request_type: "view_access_key",
        finality: "final",
        account_id: accountId,
        public_key: publicKey,
      });
    },
    /** View call with JSON args → parsed JSON result. */
    async view(contractId, methodName, args = {}) {
      const r = await call("query", {
        request_type: "call_function",
        finality: "final",
        account_id: contractId,
        method_name: methodName,
        args_base64: b64(JSON.stringify(args)),
      });
      const raw = Buffer.from(r.result ?? []).toString("utf8");
      return raw === "" ? null : JSON.parse(raw);
    },
    /** `send_tx` waiting for FINAL; on an RPC timeout it polls `tx` with the same wait level. */
    async sendTx(signedTxBase64, { hash, signerId, attempts = 6 } = {}) {
      try {
        return await call("send_tx", { signed_tx_base64: signedTxBase64, wait_until: "FINAL" }, { timeout: 90_000 });
      } catch (e) {
        const timedOut = e.name === "TimeoutError" || e.causeName === "TIMEOUT_ERROR" || /timeout/i.test(e.rpcName ?? "");
        if (!timedOut || !hash) throw e;
      }
      let last;
      for (let i = 0; i < attempts; i++) {
        try {
          return await call("tx", { tx_hash: hash, sender_account_id: signerId, wait_until: "FINAL" }, { timeout: 90_000 });
        } catch (e) {
          last = e;
        }
      }
      throw new Error(`transaction ${hash} was sent but its final status is unknown (${last?.message}); check the explorer`);
    },
  };
}
