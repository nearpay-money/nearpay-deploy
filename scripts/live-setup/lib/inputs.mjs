/**
 * Command line, key files and RPC list. Key files are read only from the `.secrets` paths (defaults below,
 * each overridable by a flag); their content never reaches the output.
 */
import { join, resolve } from "node:path";
import { DEFAULT_RPC_URLS, RELAYER_KEY_COUNT, ROLES, USDC_DECIMALS } from "./constants.mjs";
import { parseKeyFile } from "./keys.mjs";

export const USAGE = `Usage: node scripts/live-setup.mjs [options]

One-time mainnet setup for the NearPay live demo. Without --apply it only prints the on-chain status
and the next steps (no transaction is built, signed or sent).

  --apply                 build the missing transactions, print them, ask, then sign and send
  --yes, -y               do not ask before sending (with --apply)
  --deposit <amount|all>  with --apply: move the agent's native USDC into its NEAR Intents balance
                          (amount in USDC, e.g. 2.5; "all" = the whole native balance)
  --secrets <dir>         secrets directory (default: <nearpay-deploy>/.secrets)
  --treasury|--relayer|--merchant|--agent <file>
                          account key file (default: <secrets>/accounts/<role>.json)
  --relayer-keys <dir>    directory of relayer_key_1..${RELAYER_KEY_COUNT} (default: <secrets>/live)
  --rpc <url,url>         NEAR RPC URLs (default: NP_NEAR_RPC_URLS in --env-file, then public RPCs)
  --env-file <file>       default: <nearpay-deploy>/compose/env/local.env
  --help, -h              this text
`;

export class UsageError extends Error {}

/** Parses argv (without node and script). */
export function parseArgs(argv, { deployDir }) {
  const o = { apply: false, yes: false, deposit: null, help: false, files: {} };
  const take = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.startsWith("--") && a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    const value = () => {
      if (inline !== undefined) return inline;
      const v = take(i, flag);
      i++;
      return v;
    };
    switch (flag) {
      case "--apply":
        o.apply = true;
        break;
      case "--yes":
      case "-y":
        o.yes = true;
        break;
      case "--help":
      case "-h":
        o.help = true;
        break;
      case "--deposit":
        o.deposit = parseDeposit(value());
        break;
      case "--secrets":
        o.secrets = value();
        break;
      case "--relayer-keys":
        o.relayerKeysDir = value();
        break;
      case "--rpc":
        o.rpc = value();
        break;
      case "--env-file":
        o.envFile = value();
        break;
      case "--treasury":
      case "--relayer":
      case "--merchant":
      case "--agent":
        o.files[flag.slice(2)] = value();
        break;
      default:
        throw new UsageError(`unknown option ${a}`);
    }
  }
  if (o.deposit && !o.apply) throw new UsageError("--deposit only makes sense with --apply");
  if (o.yes && !o.apply) throw new UsageError("--yes only makes sense with --apply");
  o.secrets = resolve(o.secrets ?? join(deployDir, ".secrets"));
  o.relayerKeysDir = resolve(o.relayerKeysDir ?? join(o.secrets, "live"));
  o.envFile = resolve(o.envFile ?? join(deployDir, "compose", "env", "local.env"));
  for (const r of ROLES) o.files[r] = resolve(o.files[r] ?? join(o.secrets, "accounts", `${r}.json`));
  return o;
}

/** "all" or a positive USDC amount with at most 6 decimals → { all: true } | { amount: bigint (micro USDC) }. */
export function parseDeposit(v) {
  if (v === "all") return { all: true };
  const m = /^(\d+)(?:\.(\d+))?$/.exec(v);
  if (!m || (m[2] && m[2].length > USDC_DECIMALS)) throw new UsageError(`--deposit: expected "all" or a USDC amount like 2.5 (max ${USDC_DECIMALS} decimals), got ${v}`);
  const amount = BigInt(m[1]) * 10n ** BigInt(USDC_DECIMALS) + BigInt((m[2] ?? "").padEnd(USDC_DECIMALS, "0") || "0");
  if (amount <= 0n) throw new UsageError("--deposit: amount must be greater than zero");
  return { amount };
}

/** KEY=VALUE lines → object (last wins; no interpolation, like Compose env files). */
export function parseEnvFile(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

export function rpcUrls(opts, env) {
  const list = (s) => String(s ?? "").split(",").map((u) => u.trim()).filter(Boolean);
  const fromFlag = list(opts.rpc);
  if (fromFlag.length) return fromFlag;
  const fromEnv = list(env.NP_NEAR_RPC_URLS);
  return fromEnv.length ? fromEnv : [...DEFAULT_RPC_URLS];
}

/**
 * Reads the four account files and the relayer key files. Missing or invalid files are reported, not
 * thrown: the status report still shows what it can.
 */
export function loadInputs(opts, { readFile, exists }) {
  const accounts = {};
  for (const role of ROLES) {
    const file = opts.files[role];
    if (!exists(file)) {
      accounts[role] = { role, file, error: "file not found" };
      continue;
    }
    try {
      const key = parseKeyFile(readFile(file), { file, requireAccount: true });
      accounts[role] = { role, file, accountId: key.accountId, publicKey: key.publicKey, key };
    } catch (e) {
      accounts[role] = { role, file, error: e.message.replace(`${file}: `, "") };
    }
  }
  const relayerId = accounts.relayer.accountId;
  const relayerKeys = [];
  for (let n = 1; n <= RELAYER_KEY_COUNT; n++) {
    const file = join(opts.relayerKeysDir, `relayer_key_${n}`);
    if (!exists(file)) {
      relayerKeys.push({ n, file, error: "file not found" });
      continue;
    }
    try {
      const key = parseKeyFile(readFile(file), { file, expectAccount: relayerId, accountKey: false });
      relayerKeys.push({ n, file, publicKey: key.publicKey });
    } catch (e) {
      relayerKeys.push({ n, file, error: e.message.replace(`${file}: `, "") });
    }
  }
  return { accounts, relayerKeys };
}
