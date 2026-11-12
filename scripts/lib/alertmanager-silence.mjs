// Deploy silence for `scripts/beta.sh up`: while Compose recreates containers, Prometheus sees them down for a scrape
// or two and autoheal may see a slow start. A short Alertmanager silence on the availability alerts only keeps those
// blips out of Telegram; beta.sh expires it as soon as the smoke test is done. Money-path alerts (kill switch, routing,
// reconciliation, finality, …) are never silenced, and anything still firing after the deploy is sent as usual.
//
//   node scripts/lib/alertmanager-silence.mjs create <alertmanager url> <minutes> <comment>   prints the silence id
//   node scripts/lib/alertmanager-silence.mjs expire <alertmanager url> <id>
import { pathToFileURL } from "node:url";

export const DEPLOY_ALERTS = ["ServiceDown", "PlatformComponentDown", "ContainerUnhealthy", "ContainerAutoHealed", "AutohealDown"];

export function silenceBody(now, minutes, comment) {
  return {
    matchers: [{ name: "alertname", value: DEPLOY_ALERTS.join("|"), isRegex: true, isEqual: true }],
    startsAt: new Date(now).toISOString(),
    endsAt: new Date(now + minutes * 60_000).toISOString(),
    createdBy: "scripts/beta.sh up",
    comment,
  };
}

export async function create(url, minutes, comment, now = Date.now()) {
  const res = await fetch(`${url.replace(/\/$/, "")}/api/v2/silences`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(silenceBody(now, minutes, comment)),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Alertmanager answered ${res.status}`);
  return (await res.json()).silenceID;
}

export async function expire(url, id) {
  const res = await fetch(`${url.replace(/\/$/, "")}/api/v2/silence/${encodeURIComponent(id)}`, { method: "DELETE", signal: AbortSignal.timeout(10_000) });
  if (!res.ok && res.status !== 404) throw new Error(`Alertmanager answered ${res.status}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, url, a, b] = process.argv.slice(2);
  const p =
    cmd === "create" && url && Number(a) > 0 ? create(url, Number(a), b ?? "deploy").then((id) => process.stdout.write(`${id}\n`))
    : cmd === "expire" && url && a ? expire(url, a)
    : null;
  if (!p) {
    process.stderr.write("usage: alertmanager-silence.mjs create <url> <minutes> <comment> | expire <url> <id>\n");
    process.exit(2);
  }
  p.catch((e) => {
    process.stderr.write(`silence: ${e.message}\n`);
    process.exit(1);
  });
}
