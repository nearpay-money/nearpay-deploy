/**
 * Mainnet constants for the one-time live setup. The relayer key policy mirrors nearpay-agentpay
 * `src/relayer/key-pool/keys.ts` and `src/relayer/batcher/batcher.ts` (nearpay-brain `lld/agentpay.md` §9):
 * function-call keys restricted to `intents.near` / `execute_intents`, allowance 5 NEAR each, zero deposit.
 */

export const INTENTS_CONTRACT = "intents.near";
/** Native (Circle) USDC on NEAR, 6 decimals. */
export const USDC_CONTRACT = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const USDC_DECIMALS = 6;
/** NEP-245 token id of native USDC inside intents.near. */
export const USDC_INTENTS_TOKEN_ID = `nep141:${USDC_CONTRACT}`;

export const RELAYER_KEY_RECEIVER = INTENTS_CONTRACT;
export const RELAYER_KEY_METHODS = Object.freeze(["execute_intents"]);
/** 5 NEAR in yoctoNEAR (agentpay KEY_ALLOWANCE_YOCTO). */
export const RELAYER_KEY_ALLOWANCE = 5n * 10n ** 24n;
/** Key files the agentpay batcher reads (`.secrets/live/relayer_key_<n>`, Stage 1: N = 4). */
export const RELAYER_KEY_COUNT = 4;

export const ONE_YOCTO = 1n;
export const TGAS = 10n ** 12n;
/** docs.near-intents.org deposits page: "100 TGas is sufficient for a simple deposit." */
export const FT_TRANSFER_CALL_GAS = 100n * TGAS;
export const STORAGE_DEPOSIT_GAS = 30n * TGAS;
export const ADD_PUBLIC_KEY_GAS = 30n * TGAS;

const NEAR = 10n ** 24n;
/** Funding guidance printed in the next steps (yoctoNEAR). */
export const FUNDING = Object.freeze({
  /** testbed README "Mainnet demo": relayer with ~1 NEAR for gas (it pays every execute_intents batch). */
  relayerMin: NEAR,
  /**
   * Agent pays gas for its own ft_transfer_call / add_public_key. The chain checks the balance against 100 Tgas at
   * the pessimistic gas price (about 0.1 NEAR) plus storage before accepting, so 0.1 NEAR was refused on mainnet
   * (NotEnoughBalance, cost 0.10092); 0.2 NEAR passes.
   */
  agentMin: NEAR / 5n,
  /** Merchant needs NEAR only when it must call intents.near add_public_key itself. */
  merchantMin: NEAR / 10n,
  /** testbed README: agent with ~1 USDC in its NEAR Intents balance. */
  agentUsdc: 1_000_000n,
});

export const EXPLORER_TX = "https://nearblocks.io/txns/";
export const DEFAULT_RPC_URLS = Object.freeze(["https://rpc.mainnet.near.org", "https://free.rpc.fastnear.com"]);
export const ROLES = Object.freeze(["treasury", "relayer", "merchant", "agent"]);
