// macOS LaunchAgents for the beta (scripts/beta.sh install-autostart / uninstall-autostart). Three jobs in the owner's
// login session (Docker Desktop runs there too, so they need a signed-in user; docs/beta-launch.md "Uptime"):
//
//   money.nearpay.beta.autostart  at login: wait for Docker Desktop, then `beta.sh up --no-pull` (idempotent)
//   money.nearpay.beta.keepawake  caffeinate -ims owned by launchd (survives closing Terminal; restarted if killed);
//                                 exits for good while `beta.sh down`'s marker exists
//   money.nearpay.beta.watchdog   `beta.sh watchdog` every 60 s (scripts/lib/watchdog.mjs)
//
//   node scripts/lib/launchd.mjs write <LaunchAgents dir> <deploy dir> <log dir> <PATH>   prints the plist paths
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const LABELS = Object.freeze({
  autostart: "money.nearpay.beta.autostart",
  keepawake: "money.nearpay.beta.keepawake",
  watchdog: "money.nearpay.beta.watchdog",
});

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

function value(v, indent) {
  const pad = "  ".repeat(indent);
  if (typeof v === "boolean") return `${pad}<${v}/>`;
  if (typeof v === "number") return `${pad}<integer>${Math.trunc(v)}</integer>`;
  if (Array.isArray(v)) return `${pad}<array>\n${v.map((x) => value(x, indent + 1)).join("\n")}\n${pad}</array>`;
  if (v && typeof v === "object") {
    const inner = Object.entries(v).map(([k, x]) => `${"  ".repeat(indent + 1)}<key>${esc(k)}</key>\n${value(x, indent + 1)}`);
    return `${pad}<dict>\n${inner.join("\n")}\n${pad}</dict>`;
  }
  return `${pad}<string>${esc(v)}</string>`;
}

/** A launchd property list (XML) for one job. */
export function plist(job) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
${value(job, 0)}
</plist>
`;
}

/** The three jobs. path = the PATH the jobs get (launchd's default lacks Homebrew, Docker and Node). */
export function jobs({ deploy, logDir, path, intervalS = 60 }) {
  const betaSh = join(deploy, "scripts/beta.sh");
  const env = { PATH: path, LANG: "en_US.UTF-8", NP_BETA_LAUNCHD: "1" };
  const stoppedMarker = join(deploy, ".secrets/beta/stopped");
  return [
    {
      label: LABELS.autostart,
      job: {
        Label: LABELS.autostart,
        ProgramArguments: ["/bin/bash", betaSh, "autostart"],
        EnvironmentVariables: env,
        WorkingDirectory: deploy,
        RunAtLoad: true,
        KeepAlive: false,
        ProcessType: "Standard",
        StandardOutPath: join(logDir, "autostart.log"),
        StandardErrorPath: join(logDir, "autostart.log"),
      },
    },
    {
      label: LABELS.keepawake,
      job: {
        Label: LABELS.keepawake,
        // -i idle sleep, -m disk sleep, -s system sleep on the power adapter. Exit 0 (and stay down) while the beta is
        // stopped; any other exit (killed, crashed) is restarted by launchd.
        ProgramArguments: ["/bin/sh", "-c", 'if [ -e "$1" ]; then exit 0; fi; exec /usr/bin/caffeinate -ims', "nearpay-keepawake", stoppedMarker],
        RunAtLoad: true,
        KeepAlive: { SuccessfulExit: false },
        ThrottleInterval: 30,
        ProcessType: "Background",
        StandardOutPath: join(logDir, "keepawake.log"),
        StandardErrorPath: join(logDir, "keepawake.log"),
      },
    },
    {
      label: LABELS.watchdog,
      job: {
        Label: LABELS.watchdog,
        ProgramArguments: ["/bin/bash", betaSh, "watchdog"],
        EnvironmentVariables: env,
        WorkingDirectory: deploy,
        StartInterval: intervalS,
        RunAtLoad: true,
        ProcessType: "Background",
        StandardOutPath: join(logDir, "watchdog.launchd.log"),
        StandardErrorPath: join(logDir, "watchdog.launchd.log"),
      },
    },
  ];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, dir, deploy, logDir, path] = process.argv.slice(2);
  if (cmd !== "write" || !dir || !deploy || !logDir || !path) {
    process.stderr.write("usage: launchd.mjs write <LaunchAgents dir> <deploy dir> <log dir> <PATH>\n");
    process.exit(2);
  }
  mkdirSync(dir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  for (const { label, job } of jobs({ deploy, logDir, path })) {
    const file = join(dir, `${label}.plist`);
    writeFileSync(file, plist(job), { mode: 0o644 });
    process.stdout.write(`${file}\n`);
  }
}
