/**
 * The alert receiver's banner budget (scripts/alert-throttle.ts), on a fake
 * clock: one banner per kind per hour, the rest folded into one summary, a
 * sound only for thermal-critical and job-stuck, and nothing for a host that is
 * off on purpose.
 */
import { AlertThrottle, mentionsHost, parseQuietHosts, ruleOf, type Banner } from "./alert-throttle.js";

let failed = false;
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${cond || detail === undefined ? "" : ` -- ${JSON.stringify(detail)}`}`);
  if (!cond) failed = true;
}

/** Timers that fire only when the test moves the clock. */
function fakeClock() {
  let now = 0;
  let timers: { at: number; fn: () => void; live: boolean }[] = [];
  return {
    setTimer(fn: () => void, ms: number) {
      const t = { at: now + ms, fn, live: true };
      timers.push(t);
      return { cancel: () => { t.live = false; } };
    },
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const next = timers.filter((t) => t.live && t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = next.at;
        next.live = false;
        next.fn();
      }
      now = until;
      timers = timers.filter((t) => t.live);
    },
  };
}

const MIN = 60_000;

function setup(quietHosts: string[] = []) {
  const clock = fakeClock();
  const shown: Banner[] = [];
  const throttle = new AlertThrottle({ quietHosts, show: (b) => shown.push(b), setTimer: clock.setTimer });
  const failedJob = (n: number) => ({ title: "fleet: job-failed", body: `ui-test job j${n} failed`, priority: "default" });
  return { clock, shown, throttle, failedJob };
}

console.log("alert receiver: one banner per kind per hour");
{
  const { clock, shown, throttle, failedJob } = setup();
  check("the first alert of a kind shows at once", throttle.receive(failedJob(1)).shown === true && shown.length === 1);
  const outcomes = [2, 3, 4, 5, 6, 7].map((n) => { clock.advance(5 * MIN); return throttle.receive(failedJob(n)).shown; });
  check("later ones in the hour are folded", outcomes.every((o) => o === "folded"), outcomes);
  check("folded alerts raise no banner yet", shown.length === 1, shown);
  check("another kind has its own hour",
    throttle.receive({ title: "fleet: low-battery", body: "phone at 9%", priority: "default" }).shown === true && shown.length === 2);
  clock.advance(60 * MIN);
  const summary = shown[2];
  check("the hour ends in one summary banner", shown.length === 3, shown);
  check("the summary counts the folded alerts", summary?.title === "fleet: job-failed ×6 in the last hour", summary?.title);
  check("the summary carries the latest alert's text", summary?.message === "ui-test job j7 failed", summary?.message);
  check("a kind whose hour folded nothing ends quietly", !shown.some((b) => b.title.startsWith("fleet: low-battery ×")));

  // The summary is a banner, so it starts the next hour: an alert right after
  // it folds instead of showing a second banner within minutes.
  clock.advance(2 * MIN);
  check("an alert just after a summary folds", throttle.receive(failedJob(8)).shown === "folded");
  clock.advance(60 * MIN);
  check("and comes out as the next hour's summary",
    shown.length === 4 && shown[3].title === "fleet: job-failed ×1 in the last hour", shown.map((b) => b.title));
  clock.advance(60 * MIN);
  check("an empty hour after a summary closes the run", Object.keys(throttle.pending()).length === 0, throttle.pending());
  check("after a quiet hour the next alert shows at once", throttle.receive(failedJob(9)).shown === true && shown.length === 5);
  throttle.stop();
}

console.log("alert receiver: sound only for thermal-critical and job-stuck");
{
  const { shown, throttle } = setup();
  throttle.receive({ title: "fleet: thermal-critical", body: "hot", priority: "high" });
  throttle.receive({ title: "fleet: job-stuck", body: "stuck", priority: "default" });
  throttle.receive({ title: "fleet: job-failed", body: "red", priority: "high" });
  throttle.receive({ title: "fleet: device-offline", body: "gone", priority: "default" });
  check("thermal-critical sounds", shown[0]?.sound === true);
  check("job-stuck sounds, whatever priority it was sent at", shown[1]?.sound === true);
  check("high priority alone does not sound", shown[2]?.sound === false);
  check("device-offline is silent", shown[3]?.sound === false);
  throttle.stop();
}

console.log("alert receiver: a host that is off on purpose");
{
  const { shown, throttle } = setup(parseQuietHosts("fleet-host, other-mac"));
  const offline = throttle.receive({
    title: "fleet: device-offline",
    body: "fleet-host (2016 Intel) (machine-c02tf32mgtfm) has not checked in for 15 min",
    priority: "default",
  });
  check("device-offline naming a quiet host is not shown", offline.shown === false && shown.length === 0, offline);
  check("and says why", offline.reason === "quiet host fleet-host", offline.reason);
  const missed = throttle.receive({
    title: "fleet: schedule-missed",
    body: "schedule nightly-aliquant-audit on fleet-host should have fired at 2026-11-16T04:45 and did not",
    priority: "default",
  });
  check("schedule-missed naming a quiet host is not shown", missed.shown === false && shown.length === 0);
  const elsewhere = throttle.receive({
    title: "fleet: schedule-missed",
    body: "schedule nightly-aliquant-shots on ultra-phone should have fired at 2026-11-16T04:15 and did not",
    priority: "default",
  });
  check("schedule-missed on another host still shows", elsewhere.shown === true && shown.length === 1);
  const failedThere = throttle.receive({ title: "fleet: job-failed", body: "job x on fleet-host failed", priority: "default" });
  check("a quiet host only silences the rules that say it is missing", failedThere.shown === true);
  throttle.stop();
}

console.log("alert receiver: helpers");
check("ruleOf reads the collector's title", ruleOf("fleet: job-failed") === "job-failed");
check("ruleOf keeps another sender's title as its kind", ruleOf("night QA: 3 findings") === "night QA: 3 findings");
check("parseQuietHosts: unset is none", parseQuietHosts(undefined).length === 0);
check("mentionsHost matches a whole name", mentionsHost("fleet-host (2016 Intel)", "fleet-host"));
check("mentionsHost does not match a longer name", !mentionsHost("fleet-hostess is fine", "fleet-host"));

if (failed) process.exit(1);
