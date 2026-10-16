/**
 * How a job closes: done, failed or skipped.
 *
 * The shapes below are the ones the live brain held for two weeks as `done`:
 * the tvloop nightly's single host row saying `skipped: no Roku developer
 * password on this host`, and explore's `skipped: no device matches this job`.
 * Plus the one the summary always knew was a skip and the queue did not -- a
 * ui-test whose every device said `skipped:` under a plain `ok: true` host row.
 */
import { closingStatus, isSkipError, skipReasonText, type ResultRow } from "./skip.js";

type Check = (name: string, cond: boolean, detail?: string) => void;

const row = (device_id: string, payload: Record<string, unknown>): ResultRow => ({ device_id, payload });

export function runSkipChecks(check: Check) {
  check("a skip error is recognised by its prefix", isSkipError("skipped: locked") && !isSkipError("failed: skipped:") && !isSkipError(null));

  // The tvloop nightly: one host row, ok, skipped.
  const tv = row("host:fleet-host", { final: true, ok: true, error: "skipped: no Roku developer password on this host" });
  const c1 = closingStatus([tv], tv.payload);
  check("a final row that says skipped closes the job as skipped",
    c1.status === "skipped" && c1.reason === "skipped: no Roku developer password on this host", JSON.stringify(c1));

  // Every device skipped, the host row says nothing.
  const devs = [
    row("phone-a", { ok: true, error: "skipped: com.example not installed" }),
    row("phone-b", { ok: true, error: "skipped: com.example not installed" }),
  ];
  const host = row("host:mac", { final: true, ok: true });
  const c2 = closingStatus([...devs, host], host.payload);
  check("every device skipping under a plain ok host row is a skip", c2.status === "skipped", JSON.stringify(c2));
  check("and the shared reason is named once", c2.reason === "skipped: com.example not installed", String(c2.reason));

  const mixedReasons = [row("a", { ok: true, error: "skipped: locked" }), row("b", { ok: true, error: "skipped: not installed" })];
  const c3 = closingStatus([...mixedReasons, host], host.payload);
  check("different reasons are counted, not concatenated", c3.status === "skipped" && /and 1 other reason/.test(c3.reason ?? ""), String(c3.reason));

  // One device ran.
  const ran = [row("a", { ok: true, error: "skipped: locked" }), row("b", { ok: true, test: { passed: 3, failed: 0 } })];
  check("one device that ran makes it done", closingStatus([...ran, host], host.payload).status === "done");

  // A plain pass.
  const pass = row("phone", { final: true, ok: true, metrics: { decode_tok_s: 12 } });
  check("a plain pass is done", closingStatus([pass], pass.payload).status === "done");

  // Failures: the final row wins, and says why from wherever it can.
  const failDev = row("988a1b35", { ok: false, test: { passed: 0, failed: 1 }, error: 'smoke: Assertion is false: "Fleet Runner" is visible' });
  const failHost = row("host:fleet-host", { final: true, ok: false });
  const c4 = closingStatus([failDev, failHost], failHost.payload);
  check("a failing final row is a failure", c4.status === "failed");
  check("whose reason comes from the failing device when the host row has none",
    c4.reason === '988a1b35: smoke: Assertion is false: "Fleet Runner" is visible', String(c4.reason));
  const own = row("host:x", { final: true, ok: false, error: "workload 'x' not supported by this executor yet" });
  check("a failing row's own error is kept", closingStatus([own], own.payload).reason === "workload 'x' not supported by this executor yet");
  const bare = row("phone", { final: true, ok: false });
  check("a failure with nothing to say has a null reason, not an invented one", closingStatus([bare], bare.payload).reason === null);
  // ok:false with a skipped: error is a failure: ok is the verdict.
  const odd = row("phone", { final: true, ok: false, error: "skipped: but the runner said ok false" });
  check("ok:false is a failure even when the text says skipped", closingStatus([odd], odd.payload).status === "failed");

  // A device's progress rows do not outvote its final row.
  const progress = [row("p", { iter: 1, ok: true }), row("p", { iter: 0, final: true, ok: true, error: "skipped: charging" })];
  check("a device's final row beats its progress rows", closingStatus(progress, progress[1].payload).status === "skipped");

  check("the prefix comes off for a sentence that already says skipped",
    skipReasonText("skipped: no Roku developer password on this host") === "no Roku developer password on this host" &&
      skipReasonText(null) === "no reason given" && skipReasonText("dependency b skipped") === "dependency b skipped");
}
