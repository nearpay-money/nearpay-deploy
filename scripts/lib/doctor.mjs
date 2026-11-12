// `scripts/beta.sh doctor`: is this Mac set up to keep the beta running on its own? Each check prints ok / warn / FAIL
// with the exact fix (docs/beta-launch.md "Uptime"). Read-only: it never changes a setting.
//
//   node scripts/lib/doctor.mjs <deploy dir>     exit 1 when a check FAILs
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LABELS } from "./launchd.mjs";

/** `pmset -g custom` → { ac: { sleep: 0, … }, battery: { … } }; output without sections → { ac: … }. */
export function parsePmset(text) {
  const out = {};
  let section = "ac";
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (/^Battery Power:/i.test(line)) { section = "battery"; continue; }
    if (/^AC Power:/i.test(line)) { section = "ac"; continue; }
    const m = /^([A-Za-z_]+)\s+(-?\d+)/.exec(line);
    if (m) (out[section] ??= {})[m[1]] = Number(m[2]);
  }
  return out;
}

/** Docker Desktop's "Start Docker Desktop when you sign in" from its settings file (settings-store.json or settings.json). */
export function dockerAutoStart(json) {
  if (!json || typeof json !== "object") return null;
  for (const [k, v] of Object.entries(json)) if (k.toLowerCase() === "autostart" && typeof v === "boolean") return v;
  return null;
}

/**
 * facts: { platform, pmset: parsePmset(...), onBattery, hasBattery, fileVault: true|false|null, autoLoginUser,
 *          dockerAutoStart: true|false|null, dockerMemBytes, agents: { label: { installed, loaded } }, autoMacosUpdates }
 * → [{ status: "ok" | "warn" | "FAIL", text, fix? }]
 */
export function checks(f) {
  const r = [];
  const add = (status, text, fix) => r.push(fix ? { status, text, fix } : { status, text });
  if (f.platform !== "darwin") {
    add("warn", "not macOS: the host checks (sleep, autostart, launchd) apply to the owner's Mac only");
    return r;
  }
  const ac = f.pmset?.ac ?? {};
  if (f.onBattery) add("FAIL", "the Mac runs on battery: it sleeps and eventually shuts down", "plug in the power adapter (and keep it plugged in)");
  else add("ok", "on the power adapter");
  if (ac.sleep === 0) add("ok", "system sleep on the power adapter: never");
  else add("FAIL", `system sleep on the power adapter after ${ac.sleep ?? "?"} min: the site goes down when the Mac sleeps`, "sudo pmset -c sleep 0");
  if (ac.disksleep === 0) add("ok", "disk sleep on the power adapter: never");
  else add("warn", `disk sleep after ${ac.disksleep ?? "?"} min`, "sudo pmset -c disksleep 0");
  if (ac.autorestart === 1) add("ok", "restart automatically after a power failure: on");
  else if (ac.autorestart === undefined && f.hasBattery) add("ok", "restart after a power failure: not offered on this MacBook (its battery bridges short power cuts)");
  else add("warn", "restart automatically after a power failure: off", "sudo pmset -a autorestart 1");
  if (ac.womp === 1) add("ok", "wake for network access: on");
  else add("warn", "wake for network access: off", "sudo pmset -c womp 1");
  if (f.hasBattery) add("warn", "MacBook: closing the lid sleeps it even on power (unless an external display, keyboard and mouse are attached)", "keep the lid open");

  if (f.dockerAutoStart === true) add("ok", "Docker Desktop starts when you sign in");
  else if (f.dockerAutoStart === false) add("FAIL", "Docker Desktop does not start when you sign in", "Docker Desktop > Settings > General > Start Docker Desktop when you sign in to your computer > Apply");
  else add("warn", "could not read Docker Desktop's start-at-sign-in setting", "Docker Desktop > Settings > General > Start Docker Desktop when you sign in to your computer (tick it)");
  const gb = (f.dockerMemBytes ?? 0) / 1e9;
  if (!f.dockerMemBytes) add("warn", "Docker Desktop is not answering (memory unknown)", "open Docker Desktop");
  else if (gb >= 9.5) add("ok", `Docker Desktop memory: ${gb.toFixed(1)} GB`);
  else add("warn", `Docker Desktop memory: ${gb.toFixed(1)} GB (10 GB recommended for the beta's limits)`, "Docker Desktop > Settings > Resources > Memory: 10 GB > Apply & restart");

  if (f.fileVault === true) {
    add("warn", "FileVault is on, so after a restart macOS waits at the unlock screen and the beta stays down until you type your password (automatic login is impossible with FileVault)",
      "keep FileVault on (the live keys are on this disk); for a planned restart run: sudo fdesetup authrestart");
  } else if (f.autoLoginUser) add("ok", `automatic login as ${f.autoLoginUser}`);
  else add("warn", "automatic login is off: after a power cut the beta waits until someone signs in", "System Settings > Users & Groups > Automatically log in as > your user (only with FileVault off)");
  if (f.autoMacosUpdates === true) add("warn", "macOS installs updates by itself (and restarts)", "System Settings > General > Software Update > Automatic updates (i) > turn off \"Install macOS updates\" during the beta");
  else if (f.autoMacosUpdates === false) add("ok", "macOS does not install updates (and restart) by itself");

  for (const [name, label] of Object.entries(LABELS)) {
    const a = f.agents?.[label] ?? {};
    if (a.installed && a.loaded) add("ok", `launchd ${name} (${label}) installed and loaded`);
    else if (a.installed) add("FAIL", `launchd ${name} installed but not loaded`, "scripts/beta.sh install-autostart");
    else add("FAIL", `launchd ${name} not installed`, "scripts/beta.sh install-autostart");
  }
  return r;
}

// ---- facts on the Mac ----------------------------------------------------------------------------------------------
const sh = (cmd, args) => {
  try { return execFileSync(cmd, args, { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; }
};

export function gather() {
  const f = { platform: process.platform };
  if (f.platform !== "darwin") return f;
  f.pmset = parsePmset(sh("pmset", ["-g", "custom"]));
  const batt = sh("pmset", ["-g", "batt"]) ?? "";
  f.onBattery = /Battery Power/.test(batt);
  f.hasBattery = /InternalBattery/.test(batt);
  const fv = sh("fdesetup", ["status"]);
  f.fileVault = fv === null ? null : /FileVault is On/.test(fv);
  f.autoLoginUser = (sh("defaults", ["read", "/Library/Preferences/com.apple.loginwindow", "autoLoginUser"]) ?? "").trim() || null;
  const au = sh("defaults", ["read", "/Library/Preferences/com.apple.SoftwareUpdate", "AutomaticallyInstallMacOSUpdates"]);
  f.autoMacosUpdates = au === null ? null : au.trim() === "1";
  const group = join(homedir(), "Library/Group Containers/group.com.docker");
  f.dockerAutoStart = null;
  for (const name of ["settings-store.json", "settings.json"]) {
    const p = join(group, name);
    if (!existsSync(p)) continue;
    try { f.dockerAutoStart = dockerAutoStart(JSON.parse(readFileSync(p, "utf8"))); } catch { /* unreadable */ }
    if (f.dockerAutoStart !== null) break;
  }
  f.dockerMemBytes = Number((sh("docker", ["info", "--format", "{{.MemTotal}}"]) ?? "0").trim()) || 0;
  f.agents = {};
  const uid = userInfo().uid;
  for (const label of Object.values(LABELS)) {
    f.agents[label] = {
      installed: existsSync(join(homedir(), "Library/LaunchAgents", `${label}.plist`)),
      loaded: sh("launchctl", ["print", `gui/${uid}/${label}`]) !== null,
    };
  }
  return f;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = checks(gather());
  for (const c of results) process.stdout.write(`${c.status}\t${c.text}${c.fix ? `\tfix: ${c.fix}` : ""}\n`);
  process.exit(results.some((c) => c.status === "FAIL") ? 1 : 0);
}
