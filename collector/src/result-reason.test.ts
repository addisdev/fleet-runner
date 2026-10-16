/**
 * Every failure says why: the JUnit report's failing step, a subprocess's exit
 * code and last line, and a host row that would otherwise say only `ok: false`.
 *
 * The report below is the one `nightly-fleet-ui-smoke-202610150230` uploaded
 * on 2026-10-15 for the Galaxy S8+ (988a1b3541354f565a), byte for byte apart
 * from the path. The job posted `failed: 1` and no error while this sat in
 * the store.
 */
import { junitFailureReason, parseJunit } from "./junit.js";
import { execFailureReason, lastLine, withFailureReasons } from "./result-reason.js";

type Check = (name: string, cond: boolean, detail?: string) => void;

const MAESTRO_REPORT = `<?xml version='1.0' encoding='UTF-8'?>
<testsuites>
  <testsuite name="Test Suite" device="988a1b3541354f565a" tests="1" failures="1" time="20.102" timestamp="2026-10-15T02:30:37">
    <testcase id="smoke" name="smoke" classname="smoke" file="flows/fleetrunner/smoke.yaml" time="20.079" timestamp="2026-10-15T02:30:37" status="ERROR">
      <failure>Assertion is false: &quot;Fleet Runner&quot; is visible</failure>
    </testcase>
  </testsuite>
</testsuites>
`;

export async function runReasonChecks(check: Check) {
  // --- JUnit ---------------------------------------------------------------
  const s = parseJunit(MAESTRO_REPORT);
  check("junit: Maestro's counts are read", s.passed === 0 && s.failed === 1, JSON.stringify(s));
  check("junit: and so is the failing flow and step",
    s.failures[0]?.name === "smoke" && s.failures[0]?.message === 'Assertion is false: "Fleet Runner" is visible', JSON.stringify(s.failures));
  check("junit: one line for the result's error",
    junitFailureReason(s) === 'smoke: Assertion is false: "Fleet Runner" is visible', String(junitFailureReason(s)));

  const two = parseJunit(`<testsuite tests="3" failures="2">
    <testcase name="login"><failure message="Element not found: Sign in"/></testcase>
    <testcase name="feed"><failure type="AssertionError"><![CDATA[Expected 3 rows
got 0]]></failure></testcase>
    <testcase name="ok"/>
  </testsuite>`);
  check("junit: a self-closing failure's message attribute is read", two.failures[0]?.message === "Element not found: Sign in", JSON.stringify(two.failures));
  check("junit: CDATA is unwrapped", two.failures[1]?.message.startsWith("Expected 3 rows"), JSON.stringify(two.failures[1]));
  check("junit: more than one failure says how many more",
    junitFailureReason(two) === "login: Element not found: Sign in (and 1 more failing)", String(junitFailureReason(two)));
  check("junit: a passing report has no reason", junitFailureReason(parseJunit('<testsuite tests="2" failures="0"><testcase name="a"/></testsuite>')) === null);
  const garbage = parseJunit("not xml at all");
  check("junit: a report with no counts is one failure, not a pass", garbage.failed === 1 && garbage.passed === 0);
  check("junit: and says the report named no step", /names no failing step/.test(junitFailureReason(garbage) ?? ""));
  check("junit: errors count as failures",
    parseJunit('<testsuite tests="2" failures="0" errors="1"><testcase name="x"><error message="boom"/></testcase></testsuite>').failed === 1);

  // --- a subprocess that failed ------------------------------------------------
  const err = Object.assign(new Error("Command failed: maestro --device X test -e GREENFOLIO_TEST_PASSWORD=hunter2 flows\nboom"), {
    cmd: "/opt/maestro/bin/maestro --device X test -e GREENFOLIO_TEST_PASSWORD=hunter2 flows",
    code: 1,
    stderr: "Running flow smoke\nError: device X is offline (hunter2)\n",
    stdout: "",
  });
  const r = execFailureReason(err, ["hunter2"]);
  check("exec: the program, its exit code and its last stderr line", r === "maestro exited 1: Error: device X is offline ([redacted])", r);
  check("exec: never the command line, which carries the password", !r.includes("PASSWORD") && !r.includes("hunter2"), r);
  check("exec: a program that could not start says so",
    execFailureReason(Object.assign(new Error("spawn maestro ENOENT"), { cmd: "maestro test", code: "ENOENT" })) === "maestro could not run (ENOENT): spawn maestro ENOENT");
  check("exec: a killed one says so",
    /^xcodebuild was killed \(SIGTERM\)/.test(execFailureReason({ cmd: "xcodebuild test", killed: true, signal: "SIGTERM", stderr: "" })));
  check("exec: silence is said, not left blank",
    execFailureReason({ cmd: "adb shell true", code: 255, stderr: "", stdout: "" }) === "adb exited 255 and printed nothing");
  check("lastLine skips trailing blank lines", lastLine("a\nb\n\n  \n") === "b");

  // --- no ok:false row goes out without a reason -------------------------------
  const posted: Record<string, unknown>[] = [];
  const post = withFailureReasons(async (row: Record<string, unknown>) => { posted.push(row); });
  await post({ job_id: "j1", device_id: "988a1b35", iter: 0, ok: false, test: { passed: 0, failed: 1 }, error: 'smoke: Assertion is false: "Fleet Runner" is visible' });
  await post({ job_id: "j1", device_id: "host:fleet-host", iter: 0, final: true, ok: false });
  check("reasons: a failing host row with no error gets the failing device's",
    posted[1]?.error === '988a1b35: smoke: Assertion is false: "Fleet Runner" is visible', JSON.stringify(posted[1]));

  await post({ job_id: "j2", device_id: "a", iter: 0, ok: true });
  await post({ job_id: "j2", device_id: "b", iter: 0, ok: false, test: { passed: 1, failed: 2 } });
  await post({ job_id: "j2", device_id: "c", iter: 0, ok: false, error: "install failed: INSTALL_FAILED_OLDER_SDK" });
  await post({ job_id: "j2", device_id: "host:mac", iter: 0, final: true, ok: false });
  check("reasons: a device row with only counts says what the counts say",
    posted[3]?.error === "2 of 3 tests failed; the runner reported no failing step", JSON.stringify(posted[3]));
  check("reasons: several failing devices are counted and named",
    posted[5]?.error === "2 of 3 devices failed -- b: 2 of 3 tests failed; the runner reported no failing step; c: install failed: INSTALL_FAILED_OLDER_SDK",
    String(posted[5]?.error));

  await post({ job_id: "j3", device_id: "host:mac", iter: 0, final: true, ok: false, error: "executor mac has no browsers" });
  check("reasons: a row that already says why is left alone", posted[6]?.error === "executor mac has no browsers");
  await post({ job_id: "j4", device_id: "host:mac", iter: 0, final: true, ok: true });
  check("reasons: a pass is left alone", posted[7]?.error === undefined);
  await post({ job_id: "j5", device_id: "host:mac", iter: 0, final: true, ok: false });
  check("reasons: a failure with nothing behind it still says so", posted[8]?.error === "failed; the workload reported no reason");
  await post({ job_id: "j1", device_id: "host:fleet-host", iter: 0, final: true, ok: false });
  check("reasons: a job's devices are forgotten once its final row is out", posted[9]?.error === "failed; the workload reported no reason");
}
