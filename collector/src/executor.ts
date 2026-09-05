// Host executor: claims executor:"host" jobs and drives attached Android
// devices from outside via adb + Maestro. Runs on the Mac next to the
// collector (iOS support arrives in Phase 3 via devicectl/XCUITest).
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import {
  exec, BASE, NAME, log, postResult, postBeacon, fetchArtifact, uploadArtifact,
  leaseBudgetS,
} from "./fleet-client.js";
import { runWebUnfurl } from "./web/unfurl.js";
import { runWebAudit } from "./web/audit.js";
import { runArchive } from "./web/archive/index.js";
import { runDigest } from "./web/digest.js";
import { countXcodebuildTests, xcodebuildDiagnostics } from "./xcparse.js";
import {
  fleetOwned, physicalIos, simulatorName, isAndroidEmulatorSerial, iosNotReadyReason,
  adbFailureIsWorthReporting, SIM_PREFIX,
  type IosDeviceInfo,
} from "./targets.js";
import { evalMatch } from "./match.js";
import { keychainPassword, redact, KEYCHAIN_SERVICE } from "./secrets.js";
import { parseAmStart, amStartProblem } from "./am-start.js";
import { withNetwork, withNetworkAll, restoreAttached } from "./network-shape.js";
import {
  restoreAttachedState, unmanageableReason, withState,
  type SettingName,
} from "./device-state.js";
import { appleLocaleOf, coversRtl, localeDirName, parseLocaleList, type Locale } from "./locale.js";
import { contactSheetHtml, type SheetShot } from "./contact-sheet.js";
import {
  parseSdkLevel, parseVariantList, planVariant, type DisplayPlatform,
} from "./display-settings.js";
import { parseCrashLogcat, parseGfxinfo, parseMeminfo, parseSimCrashLog } from "./soak-samples.js";
import {
  a11yFindings, parseAndroidDensity, parseMaestroHierarchy, parseUiautomatorDump,
  parseXcuiDebugDescription, type A11yGeometry, type A11yNode,
} from "./a11y-tree.js";
import { countBySeverity, uploadReport, type Finding } from "./web/shared.js";
import { ADB, batteryPct, hasApp, launchApp, processAlive } from "./workloads/device.js";
import { discoverWorkloads, loadRun, type LoadedWorkload } from "./workloads/registry.js";
import type { Target, WorkloadCtx } from "./workloads/types.js";

const FLOWS_DIR = process.env.FLEET_FLOWS_DIR ?? path.resolve("examples/flows");
const MAESTRO = process.env.MAESTRO_BIN ?? path.join(os.homedir(), ".maestro/bin/maestro");

export type Job = {
  job_id: string;
  workload: string;
  // ML workloads name the model artifact; digest forwards it into the batch
  // jobs it enqueues.
  model?: Record<string, unknown>;
  app?: { name: string; build: string; sha256: string; platform?: "android" | "ios" };
  suite?: {
    kind: string; flows?: string; app_id?: string; asserts?: string[];
    // An app repo running its OWN XCUITest suite rather than the generic
    // FleetRunner bundle: which project, which scheme, which tests.
    project?: string; scheme?: string; only?: string;
    // How the suite signs in. NAMES only -- the account (an email, not a
    // secret) and which env vars the suite reads. The password is resolved on
    // the executor host and never travels in a job spec, because specs are
    // stored, served by the API and rendered on the dashboard.
    credentials?: { account: string; email_var?: string; password_var?: string };
    // TCC permissions to pre-grant on simulator targets before the tests run
    // (`xcrun simctl privacy grant <service> <bundle>`). A permission dialog a
    // suite does not handle is worse than a failure: it sits on the shared
    // simulator blocking every job after this one. `service` is whatever
    // simctl accepts (location, location-always, photos, ...); `bundle_id`
    // defaults to the suite's app_id. Simulators only -- a physical device has
    // no simctl, so a suite that runs on devices still needs an interruption
    // monitor.
    permissions?: { service: string; bundle_id?: string }[];
  };
  targets?: {
    pool?: string; exclusive?: boolean; executor?: string; url?: string;
    // Honoured HERE as well as at claim time -- see selectTargets.
    match?: string; device_id?: string; device_kind?: "device" | "simulator";
  };
  params?: Record<string, unknown>;
  lease?: { ttl_s?: number };
};

// The generic XCUITest bundle lives in the iOS runner repo; one scheme tests
// any app via TEST_RUNNER_-passed env (FLEET_APP_ID / FLEET_ASSERTS).
const WEB_SPECS_DIR = process.env.FLEET_WEB_SPECS_DIR ?? path.resolve("examples/web-specs");

// A sibling directory in the mono repo. It used to be a sibling checkout, and
// FLEET_IOS_PROJECT still overrides it, which is what the executor host on the
// workstation uses when the tree lives somewhere else entirely.
const IOS_PROJECT = process.env.FLEET_IOS_PROJECT ??
  path.resolve("../runner-ios/FleetRunner.xcodeproj");

// One definition, in workloads/types.ts, so a handler that has moved out and a
// handler that has not are talking about the same thing. Re-exported because
// src/web/* and the workload directories import their types from here.
export type { Target };

// Exclusive jobs hold the collector's device locks while they run, so a
// device-executor agent never gets handed work mid-UI-test.
async function acquireLocks(jobId: string, deviceIds: string[]): Promise<Set<string>> {
  const res = await fetch(`${BASE}/locks/acquire`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ job_id: jobId, device_ids: deviceIds }),
  });
  if (!res.ok) throw new Error(`locks/acquire -> ${res.status}`);
  const body = (await res.json()) as { granted: string[] };
  return new Set(body.granted);
}

async function releaseLocks(jobId: string) {
  await fetch(`${BASE}/locks/release`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ job_id: jobId }),
  }).catch(() => {});
}

/**
 * Android serials, or none on a host with no Android SDK.
 *
 * The `catch` is the point. This used to throw ENOENT on a Mac without adb,
 * listTargets propagated it, and reportAttached's catch swallowed it -- so an
 * iOS-only host registered NOTHING, silently, including the iPhone cabled to
 * it. bootedSimulators and devicectlDevices have always tolerated their
 * tooling being absent; this was the one that did not, and it went unnoticed
 * because every host so far happened to have adb.
 */
let adbComplaint = "";

async function adbDevices(): Promise<string[]> {
  let stdout: string;
  try {
    ({ stdout } = await exec(ADB, ["devices"]));
    adbComplaint = "";
  } catch (e) {
    const err = e as { code?: string; stderr?: string; message?: string };
    // ENOENT is the iOS-only host this function exists for: no adb, no Android
    // devices, nothing to say. Anything else means adb IS here and is failing
    // -- a version-mismatched daemon, a dead server -- and returning [] for
    // that silently empties the whole Android shelf. Every cabled phone reads
    // offline, and jobs fail with "no android targets matched this job", which
    // sends you looking at match expressions instead of at adb.
    if (adbFailureIsWorthReporting(err.code)) {
      const why = (err.stderr ?? err.message ?? "unknown").trim().split("\n")[0].slice(0, 160);
      // Once per distinct complaint: this runs every 60s and a permanently
      // broken adb would otherwise fill the log.
      if (why !== adbComplaint) {
        adbComplaint = why;
        log(`adb is present but failing, so no Android devices are visible: ${why}`);
      }
    }
    return [];
  }
  return stdout
    .split("\n")
    .slice(1)
    .filter((l) => l.trim().endsWith("device"))
    .map((l) => l.split("\t")[0]);
}

async function bootedSimulators(): Promise<string[]> {
  try {
    const { stdout } = await exec("xcrun", ["simctl", "list", "devices", "booted", "-j"]);
    const parsed = JSON.parse(stdout) as {
      devices: Record<string, { udid: string; state: string }[]>;
    };
    return Object.values(parsed.devices).flat()
      .filter((d) => d.state === "Booted")
      .map((d) => d.udid);
  } catch {
    return []; // no Xcode tooling on this host
  }
}

/**
 * What devicectl knows, keyed by identifier.
 *
 * Read once and shared, because devicectl is slow and every caller wants the
 * same answer. The important field is `transport`, and it is not the obvious
 * one: devicectl lists SIMULATORS as devices too, with no `isSimulated` flag
 * to tell them apart -- this Mac reports 25 "devices", of which one is real.
 * A simulator is always `sameMachine`; hardware arrives over `wired` or
 * `localNetwork`. Filtering on tunnelState alone let a simulator through as a
 * physical device, which is how one ended up in the fleet.
 */
async function devicectlDevices(): Promise<IosDeviceInfo[]> {
  try {
    const out = path.join(mkdtempSync(path.join(os.tmpdir(), "fleet-dc-")), "devices.json");
    await exec("xcrun", ["devicectl", "list", "devices", "--json-output", out], { timeout: 30_000 });
    const parsed = JSON.parse(readFileSync(out, "utf8")) as {
      result?: {
        devices?: {
          identifier: string;
          connectionProperties?: { tunnelState?: string; transportType?: string; pairingState?: string };
          hardwareProperties?: { marketingName?: string; productType?: string; platform?: string };
          deviceProperties?: { name?: string; osVersionNumber?: string };
        }[];
      };
    };
    return (parsed.result?.devices ?? []).map((d) => ({
      identifier: d.identifier,
      name: d.deviceProperties?.name,
      marketingName: d.hardwareProperties?.marketingName,
      productType: d.hardwareProperties?.productType,
      osVersion: d.deviceProperties?.osVersionNumber,
      transport: d.connectionProperties?.transportType,
      tunnelState: d.connectionProperties?.tunnelState,
      pairingState: d.connectionProperties?.pairingState,
      platform: d.hardwareProperties?.platform,
    }));
  } catch {
    return []; // no Xcode tooling on this host
  }
}

/** `ios` lets a caller that has already listed devicectl avoid paying for it twice. */
async function listTargets(ios?: IosDeviceInfo[]): Promise<Target[]> {
  const android = (await adbDevices()).map((id): Target => ({ id, platform: "android", kind: "device" }));
  const sims = (await bootedSimulators()).map((id): Target => ({ id, platform: "ios", kind: "simulator" }));
  const phones = physicalIos(ios ?? (await devicectlDevices())).map((d): Target => ({
    id: d.identifier, platform: "ios", kind: "device",
  }));
  // A booted simulator is reported by BOTH simctl and devicectl, so dedupe and
  // let the simctl answer win: it is the one that knows it is a simulator.
  const seen = new Set(sims.map((t) => t.id));
  return [...android, ...sims, ...phones.filter((t) => !seen.has(t.id))];
}

function parseJunit(xml: string): { passed: number; failed: number } {
  const m = /tests="(\d+)"[^>]*failures="(\d+)"/.exec(xml);
  if (!m) return { passed: 0, failed: 1 };
  const tests = Number(m[1]);
  const failed = Number(m[2]);
  return { passed: tests - failed, failed };
}


/** Is this target one the fleet may run work on? Presence and jobs must agree. */
async function fleetOwnedTarget(
  t: Target,
  sims: Record<string, { udid: string; name: string }[]> | null,
): Promise<boolean> {
  return fleetOwned(await virtualNameOf(t, sims));
}

/** The simctl device map, or null when there is no Xcode tooling here. */
async function simctlDevices(): Promise<Record<string, { udid: string; name: string }[]> | null> {
  try {
    const { stdout } = await exec("xcrun", ["simctl", "list", "devices", "-j"], { timeout: 20_000 });
    return (JSON.parse(stdout) as { devices: Record<string, { udid: string; name: string }[]> }).devices;
  } catch {
    return null;
  }
}

/**
 * Narrow the attached targets to the ones this job actually asked for.
 *
 * `targets.match` used to gate only which EXECUTOR claimed a job; once claimed,
 * the executor ran on everything it could see. That was invisible while the
 * Xcode Mac had a single simulator. It stopped being invisible the moment the
 * fleet held an iOS 27 simulator and an iOS 18.7 phone at once: a job asking
 * for `os ~ 'ios-18'` would claim correctly and then run on both, and a nightly
 * meant for real hardware would quietly report simulator results as well.
 *
 * The same expression now means the same thing in both places, evaluated
 * against the same descriptor the collector holds.
 *
 * `device_kind` is the blunt instrument for the common case -- "real hardware,
 * whatever it is" -- which no descriptor field expresses honestly, because
 * `kind` is a property of how the device is attached rather than of the device.
 */
async function selectTargets(job: Job, all: Target[]): Promise<Target[]> {
  const t = job.targets ?? {};
  let out = all;

  // Cheap, pure filters first. They are array operations; membership has to
  // interrogate each survivor -- `adb emu avd name` per emulator, 10s timeout
  // apiece -- so narrowing before asking means a pinned job never pays to
  // identify devices it had already excluded.
  if (t.device_id) out = out.filter((x) => x.id === t.device_id);
  if (t.device_kind) out = out.filter((x) => x.kind === t.device_kind);

  // Membership, which was missing entirely. fleetOwned gated only PRESENCE --
  // a scratch simulator could not join the device list, but a job still ran on
  // it, because selection never asked. Observed: an aliquant suite pinned to
  // simulators ran on `fleet-sim-1` AND a stray `iPhone 17` somebody had
  // booted, reporting both. "It cannot be registered" and "it cannot be given
  // work" are different claims.
  {
    const sims = out.some((x) => x.platform === "ios") ? await simctlDevices() : null;
    const owned: Target[] = [];
    const rejected: string[] = [];
    for (const target of out) {
      if (await fleetOwnedTarget(target, sims)) owned.push(target);
      else rejected.push(target.id);
    }
    // Say so. Otherwise the caller throws "no targets matched this job", which
    // sends an operator to their match expression -- and the device is absent
    // from the dashboard too, because presence is gated by the same rule, so
    // there is nothing anywhere that names the actual reason.
    if (rejected.length > 0) {
      log(
        `ignoring ${rejected.length} attached device(s) that are not in the fleet ` +
        `(a virtual device joins by being named "${SIM_PREFIX}…"): ${rejected.join(", ")}`,
      );
    }
    out = owned;
  }

  if (t.match) {
    // Descriptors cost adb, simctl and devicectl calls, so nothing is queried
    // unless a match expression actually needs one.
    const sims = await simctlDevices();
    const ios = out.some((x) => x.platform === "ios") ? await devicectlDevices() : null;
    const kept: Target[] = [];
    for (const target of out) {
      const d = await describeTarget(target, sims, ios);
      try {
        if (evalMatch(t.match, d as Record<string, unknown>)) kept.push(target);
      } catch (e) {
        // A malformed expression must not silently select everything.
        throw new Error(`targets.match is invalid: ${(e as Error).message}`);
      }
    }
    out = kept;
  }
  return out;
}


/**
 * Resolve a suite's sign-in details, or explain precisely why it cannot.
 *
 * Shared by both UI-test paths. It used to live only in the XCUITest branch,
 * which meant a Maestro job could set `suite.credentials`, have the collector
 * accept it, and get no sign-in and no error -- the field looked like it should
 * work and silently did nothing, which is the same green-but-vacuous failure
 * this whole mechanism exists to remove.
 */
async function resolveCredentials(suite: NonNullable<Job["suite"]>, who: string): Promise<{
  account: string; password: string; emailVar: string; passwordVar: string;
} | null> {
  const cred = suite.credentials;
  if (!cred?.account) return null;
  const got = await keychainPassword(cred.account);
  if (!got.ok) {
    throw new Error(
      got.reason === "missing"
        ? `no Keychain item for ${cred.account} (service "${KEYCHAIN_SERVICE}") on ${who}; add one with: ` +
          `security add-generic-password -s ${KEYCHAIN_SERVICE} -a ${cred.account} -w`
        : `the Keychain item for ${cred.account} exists on ${who} but could not be read (${got.detail}); ` +
          "the login keychain is locked, or this agent is not allowed to read it",
    );
  }
  log(`signing in as ${cred.account} (password from the ${who} Keychain)`);
  return {
    account: cred.account,
    password: got.password,
    emailVar: cred.email_var ?? "GREENFOLIO_TEST_EMAIL",
    passwordVar: cred.password_var ?? "GREENFOLIO_TEST_PASSWORD",
  };
}

// XCUITest path: booted simulators and physical devices paired with this Mac.
// A physical device additionally needs a signed test bundle -- xcodebuild will
// say so plainly, and the diagnostics in the log artifact carry that message.
// Pass/fail per device from the test counts xcodebuild reports; the log tail is
// uploaded as the artifact.
async function runXcuitest(job: Job) {
  const suite = job.suite!;
  // An app repo's own suite names its project and scheme. The generic
  // FleetRunner bundle drives an ALREADY-INSTALLED app and so needs an app_id;
  // a real suite builds and installs the app itself, so it needs neither an
  // app_id nor the installed-app check below.
  const ownProject = suite.project ? path.resolve(suite.project) : null;
  const project = ownProject ?? IOS_PROJECT;
  const scheme = suite.scheme ?? "FleetRunner";
  const only = suite.only ?? (ownProject ? undefined : "FleetRunnerUITests");
  const appId = suite.app_id;
  if (!appId && !ownProject) throw new Error("xcuitest suite needs app_id or project");
  const asserts = (suite.asserts ?? []).join("|");

  // Sign-in details, resolved HERE and nowhere else. A suite that needs an
  // account skips every test that touches one -- greenfolio's skips 8 of 12 --
  // so this is the difference between a nightly that tests the app and a
  // nightly that tests that the app launches.
  const creds = await resolveCredentials(suite, NAME);

  // Resolved before the loop so a spec that cannot name a bundle fails the
  // job with one clear message instead of failing per-target.
  const perms = (suite.permissions ?? []).map((p) => {
    const bundle = p.bundle_id ?? appId;
    if (!bundle) throw new Error(`suite.permissions entry "${p.service}" needs a bundle_id (this suite has no app_id)`);
    return { service: p.service, bundle };
  });

  const targets = await selectTargets(job, (await listTargets()).filter((t) => t.platform === "ios"));
  if (targets.length === 0) throw new Error("no iOS targets matched this job");

  const granted = job.targets?.exclusive
    ? await acquireLocks(job.job_id, targets.map((t) => t.id))
    : null;

  let allOk = true;
  try {
    for (const target of targets) {
      if (granted && !granted.has(target.id)) {
        await postResult({
          job_id: job.job_id, device_id: target.id, iter: 0, ok: true,
          error: "skipped: device locked by another job",
        });
        continue;
      }
      // Only meaningful for the generic bundle: a project running its own
      // suite installs the app as part of the test action.
      if (!ownProject && appId && !(await hasApp(target, appId))) {
        await postResult({
          job_id: job.job_id, device_id: target.id, iter: 0, ok: true,
          error: `skipped: ${appId} not installed`,
        });
        log(`xcuitest on ${target.id}: skipped (${appId} not installed)`);
        continue;
      }
      if (target.kind !== "simulator") {
        log(`provisioning updates allowed for ${target.id} (may register it with the Apple team)`);
      }
      // Pre-grant TCC permissions so no system dialog ever appears. The grant
      // is recorded by bundle id whether or not the app is installed yet, so
      // it works for own-project suites that install during the test action.
      // A grant that fails means the dialog WILL appear and the suite WILL
      // hang on it -- and worse, the dialog outlives the job on a shared
      // simulator -- so a failed grant fails this target rather than running.
      if (perms.length > 0 && target.kind === "simulator") {
        let grantError = "";
        for (const p of perms) {
          try {
            await exec("xcrun", ["simctl", "privacy", target.id, "grant", p.service, p.bundle], { timeout: 30_000 });
            log(`granted ${p.service} to ${p.bundle} on ${target.id}`);
          } catch (e) {
            grantError = `simctl privacy grant ${p.service} ${p.bundle} failed: ` +
              (((e as { stderr?: string }).stderr ?? (e as Error).message) || "unknown error").trim().slice(-500);
            break;
          }
        }
        if (grantError) {
          allOk = false;
          await postResult({ job_id: job.job_id, device_id: target.id, iter: 0, ok: false, error: grantError });
          log(`xcuitest on ${target.id}: ${grantError}`);
          continue;
        }
      } else if (perms.length > 0) {
        // No simctl for hardware; the suite must handle the dialog itself.
        log(`permissions not pre-granted on ${target.id} (physical device; needs an interruption monitor)`);
      }
      let ok = true;
      let logTail = "";
      let full = "";
      try {
        const { stdout } = await exec(
          "xcodebuild",
          ["test", "-project", project, "-scheme", scheme,
           // A physical device is not a simulator, and xcodebuild will not
           // guess: the destination platform has to match the hardware or the
           // run fails before a single test starts.
           "-destination", `platform=${target.kind === "simulator" ? "iOS Simulator" : "iOS"},id=${target.id}`,
           // A physical device needs a provisioning profile that lists it, and
           // without this xcodebuild refuses rather than fetching one -- "No
           // profiles for 'com.example' were found". Simulators are unsigned,
           // so it costs them nothing.
           //
           // It authorises xcodebuild to MUTATE the developer portal, not just
           // read it: an unrecognised device gets registered, consuming one of
           // the team's 100 slots, which Apple resets only at renewal. That is
           // a real side effect for a job running unattended at 02:30, so the
           // log below records which device it was passed for.
           ...(target.kind === "simulator" ? [] : ["-allowProvisioningUpdates"]),
           ...(only ? [`-only-testing:${only}`] : [])],
          {
            timeout: Number(job.params?.timeout_s ?? 1800) * 1000,
            env: {
              ...process.env,
              ...(appId ? { TEST_RUNNER_FLEET_APP_ID: appId } : {}),
              ...(asserts ? { TEST_RUNNER_FLEET_ASSERTS: asserts } : {}),
              // TEST_RUNNER_ is the prefix xcodebuild strips before handing the
              // variable to the test runner process -- which is where
              // ProcessInfo.processInfo.environment is read, and from there the
              // suite forwards it into the app's launchEnvironment.
              ...(creds
                ? {
                    [`TEST_RUNNER_${creds.emailVar}`]: creds.account,
                    [`TEST_RUNNER_${creds.passwordVar}`]: creds.password,
                  }
                : {}),
            },
            maxBuffer: 64 * 1024 * 1024,
          },
        );
        full = stdout;
        logTail = stdout.slice(-4000);
      } catch (e) {
        ok = false;
        allOk = false;
        full = (e as { stdout?: string }).stdout ?? "";
        logTail = (full || (e as Error).message).slice(-4000);
      }
      // Counts come from what ran, not from the exit code.
      const counted = countXcodebuildTests(full);
      const passed = counted.passed;
      // A build failure produces no Test Case lines at all, and a suite that
      // XCTSkip'd every case produces no passes -- xcodebuild exits 0 for the
      // second, so without this a run that tested NOTHING reports green.
      let failed = counted.failed || (ok ? 0 : 1);
      let note = "";
      // A skip is a test that did not run. Judging only the all-skipped case
      // makes the check all-or-nothing, while the failure it guards against --
      // a fixture rotting and coverage quietly shrinking -- is gradual: a suite
      // that degrades from 16 passing to 1 passing and 15 skipped would stay
      // green on the strength of the one survivor. Most of the suite not
      // running is a result nobody should have to read a count to notice.
      if (counted.skipped > 0 && counted.skipped >= passed + counted.failed) {
        failed = failed || counted.skipped;
        note = passed === 0 && counted.failed === 0
          ? `all ${counted.skipped} tests skipped (no fixture?)`
          : `${counted.skipped} of ${passed + counted.failed + counted.skipped} tests skipped (no fixture?)`;
      }
      if (failed > 0) { ok = false; allOk = false; }
      // The tail alone is not enough to diagnose a build failure: xcodebuild
      // prints thousands of lines of compile commands after the error, so the
      // last 4000 characters are reliably the least useful 4000 characters.
      // Scrub before ANY of this becomes an artifact. xcodebuild echoes its
      // environment in places, and the log is downloadable from the dashboard,
      // so a password that reaches the store has leaked however carefully it
      // was fetched.
      const secrets = creds ? [creds.password] : [];
      full = redact(full, secrets);
      logTail = redact(logTail, secrets);
      const diagnostics = xcodebuildDiagnostics(full);
      const logFile = path.join(mkdtempSync(path.join(os.tmpdir(), "fleet-xc-")), "xcodebuild.log");
      writeFileSync(
        logFile,
        (diagnostics.length ? `--- diagnostics (${diagnostics.length}) ---\n${diagnostics.join("\n")}\n\n` : "") +
          `--- tail ---\n${logTail}`,
      );
      const sha = await uploadArtifact(logFile, `${job.job_id}-${target.id}-xcodebuild.log`);
      await postResult({
        job_id: job.job_id, device_id: target.id, iter: 0, ok,
        test: { passed, failed, skipped: counted.skipped, artifacts: [sha] },
        error: note || undefined,
      });
      log(
        `xcuitest ${scheme} on ${target.id}: ${passed} passed / ${failed} failed` +
        (counted.skipped ? ` / ${counted.skipped} skipped` : "") + (note ? ` -- ${note}` : ""),
      );
    }
  } finally {
    if (granted) await releaseLocks(job.job_id);
  }
  await postResult({ job_id: job.job_id, device_id: `host:${NAME}`, iter: 0, final: true, ok: allOk });
}

async function runUiTest(job: Job) {
  const suite = job.suite;
  if (!suite) throw new Error("ui-test job needs a suite");
  if (suite.kind === "xcuitest") return runXcuitest(job);
  if (suite.kind !== "maestro") throw new Error(`suite kind ${suite.kind} not supported yet`);
  if (!suite.flows) throw new Error("maestro suite needs flows");
  const flows = path.resolve(FLOWS_DIR, suite.flows);
  if (!existsSync(flows)) throw new Error(`flows not found: ${flows}`);

  // Maestro takes `-e KEY=value` and a flow reads it as ${KEY}, which is how a
  // flow types into a login form. Same Keychain, same rule: the job names the
  // account, the password never leaves this host.
  const creds = await resolveCredentials(suite, NAME);

  const targets = await selectTargets(job, await listTargets());
  if (targets.length === 0) throw new Error("no targets attached");

  // The appId in the flow decides which pool members can run it; devices
  // without the app are reported as skipped, not failed (registry pools
  // make this explicit in Phase 4). Same bundle id on both platforms means
  // one flow can span Android and iOS.
  // The flow names an app; the job may override which VARIANT of it.
  //
  // This is the .debug mismatch from the plan. A flow hard-coding
  // com.taylab.greenfolio.debug cannot test the .smoke build that CI actually
  // publishes, and a flow hard-coding either cannot test the other -- so the
  // one flow that existed could never pass against the installed package.
  // A flow written as `appId: ${APP_ID}` takes the id from the job instead, and
  // the same flow then covers debug, smoke and release.
  const appIdMatch = /^appId:\s*(\S+)/m.exec(readFileSync(flows, "utf8"));
  const declared = appIdMatch?.[1];
  const parameterised = !declared || /\$\{|^\$/.test(declared);
  if (parameterised && !job.suite?.app_id) {
    throw new Error(`${flows} takes its appId from the job, so suite.app_id is required`);
  }
  const appId = job.suite?.app_id ?? declared;

  const granted = job.targets?.exclusive
    ? await acquireLocks(job.job_id, targets.map((t) => t.id))
    : null;

  let allOk = true;
  try {
  for (const target of targets) {
    const serial = target.id;
    if (granted && !granted.has(serial)) {
      await postResult({
        job_id: job.job_id, device_id: serial, iter: 0, ok: true,
        error: "skipped: device locked by another job",
      });
      log(`ui-test on ${serial}: skipped (locked)`);
      continue;
    }
    if (appId && !(await hasApp(target, appId))) {
      await postResult({
        job_id: job.job_id, device_id: serial, iter: 0, ok: true,
        error: `skipped: ${appId} not installed`,
      });
      log(`ui-test on ${serial}: skipped (${appId} not installed)`);
      continue;
    }
    const outDir = mkdtempSync(path.join(os.tmpdir(), "fleet-junit-"));
    const report = path.join(outDir, "report.xml");
    let failedToRun = false;
    // params.network, when the job carries one, is applied around the flow run
    // and restored afterwards whatever happens inside it. A profile that cannot
    // be applied fails the device's row by name rather than running the flow
    // unshaped — an offline suite that quietly ran online is a pass that proves
    // nothing.
    let shapeError: string | undefined;
    try {
      await withNetwork(job, target, async () => {
        try {
          await exec(
            MAESTRO,
            ["--device", serial, "test", "--format", "junit", "--output", report,
             ...(appId ? ["-e", `APP_ID=${appId}`] : []),
             ...(creds
               ? ["-e", `${creds.emailVar}=${creds.account}`, "-e", `${creds.passwordVar}=${creds.password}`]
               : []),
             flows],
            { timeout: 600_000 },
          );
        } catch {
          // Non-zero exit also just means failing flows; the report tells the truth.
          failedToRun = !existsSync(report);
        }
      });
    } catch (e) {
      shapeError = (e as Error).message.slice(0, 300);
      failedToRun = true;
    }

    let passed = 0;
    let failed = 1;
    const artifacts: string[] = [];
    if (!failedToRun && existsSync(report)) {
      const xml = readFileSync(report, "utf8");
      ({ passed, failed } = parseJunit(xml));
      // Scrub before upload: a failing step echoes the command it ran, and the
      // report is downloadable from the dashboard.
      if (creds) writeFileSync(report, redact(xml, [creds.password]));
      artifacts.push(await uploadArtifact(report, `${job.job_id}-${serial}-junit.xml`));
    }
    if (failed > 0) allOk = false;
    await postResult({
      job_id: job.job_id, device_id: serial, iter: 0,
      ok: failed === 0, test: { passed, failed, artifacts },
      ...(shapeError ? { error: `params.network: ${shapeError}` } : {}),
    });
    log(`ui-test on ${serial}: ${passed} passed / ${failed} failed${shapeError ? ` (network shaping: ${shapeError})` : ""}`);
  }
  } finally {
    if (granted) await releaseLocks(job.job_id);
  }
  await postResult({ job_id: job.job_id, device_id: `host:${NAME}`, iter: 0, final: true, ok: allOk });
}

// Location replay: feed the device a recorded route so a drain run walks the
// same path every night with the real GPS radio on. Simulators take a GPX
// file directly; Android uses the mock-location provider (the app under test
// must allow mock locations in its debug build); real iPhones need the app's
// own debug replay provider (devicectl has no location injection).
async function replayLocation(target: Target, gpxPath: string): Promise<string> {
  if (target.platform === "ios" && target.kind === "simulator") {
    await exec("xcrun", ["simctl", "location", target.id, "start", "--speed=1.4", gpxPath], { timeout: 30_000 });
    return "simctl location (gpx replay)";
  }
  if (target.platform === "android") {
    // Parse trackpoints and push them one at a time via the emulator geo
    // console (emulators) or the mock provider (devices with fleet-runner as
    // mock app). Emulator path here; device path is best-effort.
    const gpx = readFileSync(gpxPath, "utf8");
    const pts = [...gpx.matchAll(/<trkpt[^>]*lat="([-0-9.]+)"[^>]*lon="([-0-9.]+)"/g)].map((m) => [Number(m[1]), Number(m[2])]);
    if (target.id.startsWith("emulator-")) {
      // Fire-and-forget replay: one fix per second, in the background.
      (async () => {
        for (const [lat, lon] of pts) {
          await exec(ADB, ["-s", target.id, "emu", "geo", "fix", String(lon), String(lat)], { timeout: 10_000 }).catch(() => {});
          await new Promise((r) => setTimeout(r, 1000));
        }
      })();
      return `adb emu geo fix (${pts.length} points)`;
    }
    return `no injection path for physical Android; app-side replay required (${pts.length} points parsed)`;
  }
  return "no injection path for physical iOS; app-side replay required";
}

// Drain: unplugged battery-drain curve for an app scenario. Launches the app,
// optionally replays a GPX route, and samples battery + process-alive every
// interval — each sample renews the lease. Result: the drain curve (per-check
// rows), start/end %, and %/hour. Honest about preconditions: refuses when
// the device is charging (a drain test on a charger is meaningless) unless
// params.allow_charging is set for pipeline validation.
async function runDrain(job: Job) {
  const appId = job.params?.app_id as string | undefined;
  if (!appId) throw new Error("drain job needs params.app_id");
  const durationS = Number(job.params?.duration_s ?? 3600);
  const intervalS = Number(job.params?.interval_s ?? 60);
  const gpxSha = job.params?.gpx_sha256 as string | undefined;
  const allowCharging = job.params?.allow_charging === true;
  const platform = job.app?.platform ?? "android";
  const targets = await selectTargets(job, (await listTargets()).filter((t) => t.platform === platform));
  if (targets.length === 0) throw new Error(`no ${platform} targets matched this job`);

  let gpxPath: string | undefined;
  if (gpxSha) {
    gpxPath = path.join(mkdtempSync(path.join(os.tmpdir(), "fleet-gpx-")), "route.gpx");
    await fetchArtifact(gpxSha, gpxPath);
  }

  const start = new Map<string, number | null>();
  const eligible: Target[] = [];
  for (const t of targets) {
    if (!(await hasApp(t, appId))) {
      await postResult({ job_id: job.job_id, device_id: t.id, iter: 0, ok: true, error: `skipped: ${appId} not installed` });
      continue;
    }
    // Precondition: not charging. Android reports it via dumpsys; sims never charge.
    if (t.platform === "android" && !allowCharging) {
      const { stdout } = await exec(ADB, ["-s", t.id, "shell", "dumpsys", "battery"], { timeout: 15_000 }).catch(() => ({ stdout: "" }));
      if (/(AC|USB|Wireless) powered: true/.test(stdout)) {
        await postResult({ job_id: job.job_id, device_id: t.id, iter: 0, ok: false, error: "drain precondition failed: device is charging (unplug, or set the pool's power webhook)" });
        continue;
      }
    }
    await launchApp(t, appId).catch(() => {});
    let replay = "none";
    if (gpxPath) replay = await replayLocation(t, gpxPath).catch((e) => `replay failed: ${(e as Error).message}`);
    start.set(t.id, await batteryPct(t));
    log(`drain ${appId} on ${t.id}: start ${start.get(t.id)}% · location: ${replay}`);
    eligible.push(t);
  }
  if (eligible.length === 0) {
    await postResult({ job_id: job.job_id, device_id: `host:${NAME}`, iter: 0, final: true, ok: false, error: "no eligible targets (not installed / charging)" });
    return;
  }

  const t0 = Date.now();
  const deadline = t0 + durationS * 1000;
  let iter = 0;
  const alive = new Map(eligible.map((t) => [t.id, true]));
  let allOk = true;
  // params.network wraps the sampling window rather than the whole job: the app
  // is already up when shaping starts, so `offline-after-<n>s` measures what it
  // is for — an app that loses the network while running — instead of one that
  // never had it. Restored on every exit path, including a throw mid-run.
  //
  // Worth knowing before pointing an offline profile at a drain job: this
  // executor drives the device over adb, and taking a wifi-attached device
  // offline would cut its own control channel. network-shape refuses that case
  // outright rather than stranding the device.
  await withNetworkAll(job, eligible, async () => {
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Math.min(intervalS * 1000, deadline - Date.now())));
    iter += 1;
    for (const t of eligible) {
      const isAlive = await processAlive(t, appId);
      if (!isAlive) alive.set(t.id, false);
      const battery = await batteryPct(t);
      await postBeacon(job.job_id, t.id, { process_alive: { [appId]: isAlive }, ...(battery !== null ? { battery_pct: battery } : {}) });
      await postResult({ job_id: job.job_id, device_id: t.id, iter, ok: isAlive,
        metrics: { battery_end_pct: battery, ttft_ms: (Date.now() - t0) / 1000 },
        error: isAlive ? undefined : `process ${appId} not running at check ${iter}` });
    }
  }
  if (gpxPath) for (const t of eligible) if (t.platform === "ios" && t.kind === "simulator")
    await exec("xcrun", ["simctl", "location", t.id, "clear"], { timeout: 15_000 }).catch(() => {});

  for (const t of eligible) {
    const s = start.get(t.id); const e = await batteryPct(t);
    const hours = (Date.now() - t0) / 3_600_000;
    const perHour = s !== null && s !== undefined && e !== null && hours > 0 ? (s - e) / hours : null;
    const ok = alive.get(t.id) ?? false;
    if (!ok) allOk = false;
    await postResult({ job_id: job.job_id, device_id: t.id, iter: 0, ok,
      // drain_pct_per_h, not decode_tok_s. This used to ride in the decode slot
      // "for the bench page" — which never worked: both bench queries filter
      // workload = 'benchmark', so a drain row could not appear there. All it
      // achieved was a battery figure stored under a name that means tokens
      // per second. Historical rows still carry it that way and the dashboard
      // reads them back, marked as inferred.
      metrics: { battery_start_pct: s, battery_end_pct: e, drain_pct_per_h: perHour },
      error: ok ? undefined : `${appId} died during the drain run` });
    log(`drain ${appId} on ${t.id}: ${s}% -> ${e}% (${perHour?.toFixed(1) ?? "?"} %/h) ${ok ? "" : "APP DIED"}`);
  }
  });
  await postResult({ job_id: job.job_id, device_id: `host:${NAME}`, iter: 0, final: true, ok: allOk });
}

// ---------------------------------------------------------------------------
// Shared device plumbing for app-soak, locale-shots and a11y-audit
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/** Safe as a path segment inside a bundle and as an artifact name. */
const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");

const sha256File = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");

async function androidProp(t: Target, key: string): Promise<string> {
  try {
    return (await exec(ADB, ["-s", t.id, "shell", "getprop", key], { timeout: 10_000 })).stdout.replace(/\r/g, "").trim();
  } catch {
    return "";
  }
}

/** The API level, or null. Null is a real answer here and gates two settings. */
async function androidSdkLevel(t: Target): Promise<number | null> {
  return parseSdkLevel(await androidProp(t, "ro.build.version.sdk"));
}

/**
 * The density a uiautomator dump's pixel bounds are measured in.
 *
 * `wm density` first because it reports the OVERRIDE when one is set, and a
 * display-size override is itself an accessibility setting somebody may have
 * left on. ro.sf.lcd_density is the fallback and knows nothing about overrides.
 */
async function androidDensityDpi(t: Target): Promise<number | null> {
  try {
    const { stdout } = await exec(ADB, ["-s", t.id, "shell", "wm", "density"], { timeout: 15_000 });
    const d = parseAndroidDensity(stdout);
    if (d !== null) return d;
  } catch {
    // No `wm` on this shell; the property below is older and always there.
  }
  return parseAndroidDensity(await androidProp(t, "ro.sf.lcd_density"));
}

/**
 * A PNG of what is on the screen right now.
 *
 * The Android path goes via the device's own storage and `adb pull` rather than
 * the shorter `adb exec-out screencap -p`. exec-out streams binary through the
 * same promisified execFile every other call in this file uses, and that
 * decodes stdout as UTF-8 -- every byte above 0x7f is replaced, and what lands
 * is a PNG-shaped file no decoder will open. It fails late, in the bundle, in
 * front of a person.
 *
 * A physical iPhone has no path at all, and says so: devicectl cannot capture a
 * screen and simctl is simulators only.
 */
async function takeScreenshot(t: Target, dest: string): Promise<void> {
  mkdirSync(path.dirname(dest), { recursive: true });
  if (t.platform === "android") {
    const remote = "/sdcard/fleet-shot.png";
    await exec(ADB, ["-s", t.id, "shell", "screencap", "-p", remote], { timeout: 60_000 });
    await exec(ADB, ["-s", t.id, "pull", remote, dest], { timeout: 60_000 });
    await exec(ADB, ["-s", t.id, "shell", "rm", "-f", remote], { timeout: 15_000 }).catch(() => {});
    return;
  }
  if (t.kind === "simulator") {
    await exec("xcrun", ["simctl", "io", t.id, "screenshot", dest], { timeout: 60_000 });
    return;
  }
  throw new Error(
    `no screenshot path for the physical iPhone ${t.id}: devicectl cannot capture a screen and simctl is ` +
    "simulators only. Screenshots from real iOS hardware come from an XCUITest run's attachments",
  );
}

/** Stop the app if it is running, then start it clean. */
async function relaunchApp(t: Target, appId: string, args: string[] = []): Promise<void> {
  if (t.platform === "android") {
    await exec(ADB, ["-s", t.id, "shell", "am", "force-stop", appId], { timeout: 20_000 }).catch(() => {});
    await sleep(800);
  } else if (t.kind === "simulator") {
    await exec("xcrun", ["simctl", "terminate", t.id, appId], { timeout: 30_000 }).catch(() => {});
    await sleep(500);
  }
  await launchApp(t, appId, args);
}

/** A flow path under FLOWS_DIR, refusing escapes the way the web specs do. */
function resolveFlow(name: string): string {
  const root = path.resolve(FLOWS_DIR);
  const flow = path.resolve(root, name);
  if (flow !== root && !flow.startsWith(root + path.sep)) throw new Error(`the flow ${name} escapes the flows dir`);
  if (!existsSync(flow)) throw new Error(`flow not found: ${flow}`);
  return flow;
}

/**
 * Run one Maestro flow against one device, with `cwd` set to where its
 * screenshots should land.
 *
 * The cwd is the whole mechanism: `takeScreenshot: home` inside a flow writes
 * `home.png` relative to the working directory, so pointing the working
 * directory at this locale's folder is what files a flow's shots under the
 * right locale without the flow knowing anything about locales.
 *
 * Returns the failure text, or null. A failing flow is not thrown, because
 * every caller wants to record it against one cell of a matrix and carry on
 * with the rest.
 */
async function runFlow(
  t: Target, flow: string, cwd: string, env: Record<string, string>, timeoutMs: number,
): Promise<string | null> {
  mkdirSync(cwd, { recursive: true });
  try {
    await exec(
      MAESTRO,
      ["--device", t.id, "test", ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]), flow],
      { timeout: timeoutMs, cwd, maxBuffer: 32 * 1024 * 1024 },
    );
    return null;
  } catch (e) {
    const err = e as { stdout?: string; message?: string };
    return `${err.stdout ?? ""}${err.message ?? ""}`.trim().slice(-400) || "maestro failed";
  }
}

/** Every PNG in a directory, by name, in a stable order. */
const shotsIn = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".png")).sort() : [];

/** Zip a bundle so its per-locale (or per-condition) folders sit at the zip root. */
async function zipBundle(dir: string, zip: string): Promise<void> {
  await exec("ditto", ["-c", "-k", "--sequesterRsrc", dir, zip], { timeout: 300_000 });
}

/**
 * Write the contact sheet, zip the bundle and upload it.
 *
 * Returns the artifact sha, or null when nothing was captured -- an empty zip
 * is worse than no zip, because it is a green-looking artifact link that opens
 * onto nothing.
 */
async function bundleShots(
  bundleDir: string, title: string, sheet: SheetShot[], artifactName: string,
  opts: { columnNoun?: string } = {},
): Promise<string | null> {
  if (sheet.every((s) => !s.file)) return null;
  writeFileSync(path.join(bundleDir, "index.html"), contactSheetHtml(title, sheet, opts));
  const zip = path.join(path.dirname(bundleDir), artifactName);
  await zipBundle(bundleDir, zip);
  return uploadArtifact(zip, artifactName);
}

// ---------------------------------------------------------------------------
// app-soak
// ---------------------------------------------------------------------------

/** One interval's worth of what the device will tell us about the app. */
type SoakSample = {
  alive: boolean;
  pssMb: number | null;
  jankPct: number | null;
  /** Crashes observed IN THIS INTERVAL, not cumulatively. */
  crashes: number;
  /** Everything that could not be measured, named. Never silently a zero. */
  problems: string[];
  signatures: string[];
};

/**
 * Sample one Android device: PSS, janky frames, and crashes since the last look.
 *
 * `gfxinfo <pkg> reset` is issued AFTER reading, so each sample's jank figure
 * covers the interval that just ended rather than the whole run -- a
 * since-boot average flattens the one bad minute a soak exists to find. The
 * first sample of a run is the exception and covers process start to now, which
 * is stated on the row rather than smoothed over.
 *
 * The crash count is a delta against a running total read from the crash
 * BUFFER, which is never cleared. Clearing it would be the obvious way to get
 * per-interval numbers and would also destroy evidence belonging to whatever
 * else runs on this phone. The buffer can roll over under a very chatty device,
 * which shows up as a total that went down; that is clamped to zero and
 * under-counts rather than reporting a negative crash count.
 */
async function sampleAndroid(
  t: Target, appId: string, crashTotal: { seen: number },
): Promise<SoakSample> {
  const problems: string[] = [];
  const alive = await processAlive(t, appId);

  let pssMb: number | null = null;
  try {
    const { stdout } = await exec(ADB, ["-s", t.id, "shell", "dumpsys", "meminfo", appId],
      { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    const m = parseMeminfo(stdout);
    if (m.problem) problems.push(`pss: ${m.problem}`);
    else pssMb = Math.round((m.pssKb! / 1024) * 10) / 10;
  } catch (e) {
    problems.push(`pss: dumpsys meminfo failed (${(e as Error).message.slice(0, 120)})`);
  }

  let jankPct: number | null = null;
  try {
    const { stdout } = await exec(ADB, ["-s", t.id, "shell", "dumpsys", "gfxinfo", appId],
      { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    const g = parseGfxinfo(stdout);
    if (g.problem) problems.push(`jank: ${g.problem}`);
    else jankPct = Math.round(g.jankPct! * 100) / 100;
    await exec(ADB, ["-s", t.id, "shell", "dumpsys", "gfxinfo", appId, "reset"], { timeout: 30_000 }).catch(() => {});
  } catch (e) {
    problems.push(`jank: dumpsys gfxinfo failed (${(e as Error).message.slice(0, 120)})`);
  }

  let crashes = 0;
  const signatures: string[] = [];
  try {
    // -t bounds the read; crashes are rare and 4000 lines is far more than an
    // interval produces, while an unbounded read of a busy buffer can outgrow
    // maxBuffer and turn a sample into an exception.
    const { stdout } = await exec(ADB, ["-s", t.id, "logcat", "-b", "crash", "-d", "-t", "4000"],
      { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    const c = parseCrashLogcat(stdout, appId);
    if (c.problem) problems.push(`crashes: ${c.problem}`);
    else {
      crashes = Math.max(0, c.count - crashTotal.seen);
      crashTotal.seen = c.count;
      if (crashes > 0) signatures.push(...c.signatures.slice(-crashes));
    }
  } catch (e) {
    problems.push(`crashes: logcat failed (${(e as Error).message.slice(0, 120)})`);
  }

  return { alive, pssMb, jankPct, crashes, problems, signatures };
}

/**
 * Sample one iOS simulator.
 *
 * `windowS` is the time since this device was last sampled, and it has to be
 * exactly that. An over-long window re-counts the previous window's crash and
 * turns one crash into a rising tally; a short one drops crashes on the floor.
 * The caller stamps the clock immediately before this runs and uses that stamp
 * as the next window's start, so consecutive windows abut rather than overlap.
 *
 * Crashes only, and the two missing numbers are named on every row rather than
 * filled in. There is no honest PSS for a simulated app: it is an ordinary
 * process on this Mac, so the only figure available is the host process's RSS,
 * which counts shared pages Android's PSS deliberately does not and would sit
 * in a field the schema documents as proportional set size. Two numbers filed
 * under one name is the failure the metrics schema was written to stop, and a
 * memory comparison between a phone and a simulator is not one anybody should
 * be able to draw by accident. Jank has no simulator equivalent at all --
 * nothing renders on a real display pipeline.
 */
async function sampleIosSim(t: Target, appId: string, windowS: number): Promise<SoakSample> {
  const problems = [
    "pss: not measurable on a simulator (the app is a host process; its RSS is not a device PSS and must not be filed as one)",
    "jank: not measurable on a simulator (no on-device display pipeline to miss a deadline)",
  ];
  const alive = await processAlive(t, appId);
  let crashes = 0;
  const signatures: string[] = [];
  try {
    const { stdout } = await exec(
      "xcrun",
      ["simctl", "spawn", t.id, "log", "show", "--style", "syslog",
       "--last", `${Math.max(1, Math.ceil(windowS))}s`,
       "--predicate", 'process == "ReportCrash" OR eventMessage CONTAINS[c] "crash"'],
      { timeout: 90_000, maxBuffer: 32 * 1024 * 1024 },
    );
    const c = parseSimCrashLog(stdout, appId);
    if (c.problem) problems.push(`crashes: ${c.problem}`);
    else {
      // The window is the interval, so this is already a per-interval count.
      crashes = c.count;
      signatures.push(...c.signatures);
    }
  } catch (e) {
    problems.push(`crashes: simctl log show failed (${(e as Error).message.slice(0, 120)})`);
  }
  return { alive, pssMb: null, jankPct: null, crashes, problems, signatures };
}

/**
 * app-soak: keep the app working for hours and watch what happens to it.
 *
 * Without `params.flow` this is the original soak and nothing more: launch the
 * app and prove it is still running at every check, which is the whole
 * measurement for OEM-task-killer survival. The `soak` workload name still
 * routes here and behaves exactly as it did.
 *
 * With `params.flow` it becomes the thing a memory leak actually shows up in: a
 * Maestro flow looped for the duration while PSS, janky frames and crashes are
 * sampled between passes. A leak is a rising pss_mb across hundreds of rows, a
 * regression is a jank_pct that climbs as the heap fills, and neither is
 * visible in a run that only asks whether the process exists.
 *
 * A crash is a RESULT, not a reason to stop. The app is relaunched and the loop
 * continues, because "it crashed twice in six hours" is the number somebody
 * ships or does not ship on, and a run that stopped at the first crash can only
 * ever report "at least one".
 */
async function runAppSoak(job: Job) {
  const appId = (job.params?.app_id as string | undefined) ?? job.suite?.app_id;
  if (!appId) throw new Error("app-soak needs params.app_id");
  const durationS = Number(job.params?.duration_s ?? 3600);
  const intervalS = Number(job.params?.interval_s ?? 60);
  const flowName = job.params?.flow as string | undefined;
  const flow = flowName ? resolveFlow(flowName) : null;
  const platform = job.app?.platform ?? "android";
  const targets = await selectTargets(job, (await listTargets()).filter((t) => t.platform === platform));
  if (targets.length === 0) throw new Error(`no ${platform} targets matched this job`);

  const flowCwd = mkdtempSync(path.join(os.tmpdir(), "fleet-soak-"));

  const eligible: Target[] = [];
  const unsupported = new Map<string, string>();
  for (const t of targets) {
    if (t.platform === "ios" && t.kind === "device") {
      // devicectl has no meminfo, no gfxinfo and no crash-log access, and the
      // on-device crash reports are not readable from here. Saying so beats a
      // row of nulls that looks like a healthy app.
      unsupported.set(t.id,
        "app-soak cannot sample a physical iPhone: devicectl exposes no memory, frame or crash-report " +
        "access, so a run here would report an app that never used memory and never crashed");
      continue;
    }
    if (!(await hasApp(t, appId))) {
      await postResult({ job_id: job.job_id, device_id: t.id, iter: 0, ok: true, error: `skipped: ${appId} not installed` });
      continue;
    }
    await relaunchApp(t, appId).catch(() => {});
    eligible.push(t);
  }
  for (const [id, why] of unsupported) {
    await postResult({ job_id: job.job_id, device_id: id, iter: 0, ok: false, error: why });
    log(`app-soak on ${id}: unsupported -- ${why}`);
  }
  if (eligible.length === 0) {
    await postResult({
      job_id: job.job_id, device_id: `host:${NAME}`, iter: 0, final: true,
      ok: unsupported.size === 0,
      error: unsupported.size > 0 ? "no target could be sampled" : undefined,
    });
    return;
  }

  const crashTotals = new Map(eligible.map((t) => [t.id, { seen: 0 }]));
  // Read the crash buffer once before anything runs so pre-existing crashes --
  // yesterday's, or another job's -- are not attributed to this soak.
  for (const t of eligible.filter((t) => t.platform === "android")) {
    await sampleAndroid(t, appId, crashTotals.get(t.id)!).catch(() => {});
  }

  // When each device was last sampled, so an iOS log window abuts the previous
  // one instead of overlapping it and counting the same crash twice.
  const lastSampledAt = new Map(eligible.map((t) => [t.id, Date.now()]));
  const survived = new Map(eligible.map((t) => [t.id, true]));
  const crashCount = new Map(eligible.map((t) => [t.id, 0]));
  const flowFailures = new Map(eligible.map((t) => [t.id, 0]));
  const firstSignature = new Map<string, string>();
  const t0 = Date.now();
  const deadline = t0 + durationS * 1000;
  let iter = 0;

  while (Date.now() < deadline) {
    iter += 1;
    if (!flow) await sleep(Math.min(intervalS * 1000, deadline - Date.now()));
    for (const t of eligible) {
      let flowError: string | null = null;
      if (flow) {
        // One pass of the flow IS this interval. Bounded by the interval so a
        // wedged flow cannot swallow the whole soak, and by at least 30s so a
        // short interval does not guarantee a timeout.
        const budget = Math.max(30_000, Math.min(intervalS * 1000, deadline - Date.now()));
        flowError = await runFlow(t, flow, flowCwd, { APP_ID: appId }, budget);
        if (flowError) flowFailures.set(t.id, (flowFailures.get(t.id) ?? 0) + 1);
      }

      const sampledAt = Date.now();
      const windowS = (sampledAt - (lastSampledAt.get(t.id) ?? sampledAt)) / 1000;
      lastSampledAt.set(t.id, sampledAt);
      const s = t.platform === "android"
        ? await sampleAndroid(t, appId, crashTotals.get(t.id)!)
        : await sampleIosSim(t, appId, windowS);

      if (s.crashes > 0) {
        crashCount.set(t.id, (crashCount.get(t.id) ?? 0) + s.crashes);
        if (!firstSignature.has(t.id) && s.signatures.length > 0) firstSignature.set(t.id, s.signatures[0]);
      }
      if (!s.alive) survived.set(t.id, false);

      const battery = await batteryPct(t);
      await postBeacon(job.job_id, t.id, {
        process_alive: { [appId]: s.alive },
        ...(battery !== null ? { battery_pct: battery } : {}),
      });

      const notes = [
        ...(flowError ? [`flow failed: ${flowError.slice(-200)}`] : []),
        ...(s.alive ? [] : [`${appId} was not running at check ${iter}`]),
        ...s.problems,
      ];
      await postResult({
        job_id: job.job_id, device_id: t.id, iter,
        // A crash is recorded, not fatal: the row is red so the curve shows
        // where it happened, and the loop carries on.
        ok: s.alive && s.crashes === 0,
        metrics: {
          elapsed_s: Math.round((Date.now() - t0) / 1000),
          crashes: s.crashes,
          ...(s.pssMb !== null ? { pss_mb: s.pssMb } : {}),
          ...(s.jankPct !== null ? { jank_pct: s.jankPct } : {}),
          ...(battery !== null ? { battery_end_pct: battery } : {}),
        },
        error: notes.length > 0 ? notes.join("; ").slice(0, 480) : undefined,
      });
      log(
        `app-soak ${appId} on ${t.id} check ${iter}: ${s.alive ? "alive" : "DEAD"}` +
        (s.pssMb !== null ? ` · ${s.pssMb} MB` : "") +
        (s.jankPct !== null ? ` · ${s.jankPct}% jank` : "") +
        (s.crashes > 0 ? ` · ${s.crashes} CRASH` : ""),
      );

      // Relaunch after a death or a crash and keep going. This is the point of
      // the workload: the count is the deliverable, so the run must be able to
      // reach a second one.
      if (!s.alive || s.crashes > 0) {
        await relaunchApp(t, appId).catch((e) => log(`app-soak: relaunching ${appId} on ${t.id} failed: ${(e as Error).message}`));
      }
    }
  }

  let allOk = unsupported.size === 0;
  for (const t of eligible) {
    const crashes = crashCount.get(t.id) ?? 0;
    const failures = flowFailures.get(t.id) ?? 0;
    const ok = crashes === 0 && (survived.get(t.id) ?? false) && failures === 0;
    if (!ok) allOk = false;
    const why = [
      ...(crashes > 0 ? [`${crashes} crash(es)${firstSignature.has(t.id) ? `, first: ${firstSignature.get(t.id)}` : ""}`] : []),
      ...((survived.get(t.id) ?? false) ? [] : [`${appId} was found dead at least once`]),
      ...(failures > 0 ? [`${failures} flow pass(es) failed`] : []),
    ].join("; ");
    await postResult({
      job_id: job.job_id, device_id: t.id, iter: 0, ok,
      metrics: { crashes, elapsed_s: Math.round((Date.now() - t0) / 1000) },
      error: ok ? undefined : why,
    });
    log(`app-soak ${appId} on ${t.id}: ${iter} checks, ${crashes} crash(es)${ok ? "" : ` -- ${why}`}`);
  }
  await postResult({ job_id: job.job_id, device_id: `host:${NAME}`, iter: 0, final: true, ok: allOk });
}

// ---------------------------------------------------------------------------
// locale-shots
// ---------------------------------------------------------------------------

/** What one locale means to one target, in settings this executor can undo. */
function localeSettings(t: Target, l: Locale): Partial<Record<SettingName, string>> {
  if (t.platform === "android") return { "android:system.system_locales": l.tag };
  return { "ios:defaults.AppleLanguages": l.tag, "ios:defaults.AppleLocale": appleLocaleOf(l) };
}

/**
 * locale-shots: the same screens, captured under every locale the job names.
 *
 * How the locale is applied, and what each path is worth:
 *
 *   Android           -- `settings put system system_locales <tag>` and a
 *                        force-stop-then-launch, because a process reads the
 *                        configuration once at start. Verified by reading the
 *                        setting back.
 *   iOS simulator     -- `defaults write -g AppleLanguages` inside the
 *                        simulator, verified by reading it back, AND
 *                        `-AppleLanguages (<tag>)` as launch arguments. The
 *                        launch arguments are the belt: they reach the app's
 *                        own NSUserDefaults directly, which is the mechanism
 *                        that cannot be defeated by a preferences daemon that
 *                        has not noticed the write yet.
 *   physical iPhone   -- REFUSED. Nothing sets a device's language from this
 *                        host, and there is no screenshot path either. See
 *                        unmanageableReason; the row says so by name.
 *
 * Two honesty checks, because "the setting took" and "the app is in that
 * language" are different claims and only the second one matters:
 *
 *   - every change is journalled before it is made and restored in a finally,
 *     with a startup sweep behind that. A phone left in Arabic is a phone
 *     somebody has to fix by hand, and it does not look broken until they do.
 *   - if two or more locales produce byte-identical screenshot sets, the run
 *     fails that device by name. That is what an app whose locale never
 *     actually changed looks like, and it is otherwise indistinguishable from
 *     a complete, correct run -- a full bundle, one folder per locale, every
 *     folder in English.
 */
async function runLocaleShots(job: Job) {
  const appId = (job.params?.app_id as string | undefined) ?? job.suite?.app_id;
  if (!appId) throw new Error("locale-shots needs params.app_id");
  const locales = parseLocaleList(job.params?.locales);
  const flowName = job.params?.flow as string | undefined;
  const flow = flowName ? resolveFlow(flowName) : null;
  const settleMs = Number(job.params?.settle_ms ?? 5000);
  const platform = job.app?.platform;
  const attached = (await listTargets()).filter((t) => !platform || t.platform === platform);
  const targets = await selectTargets(job, attached);
  if (targets.length === 0) throw new Error("no targets matched this job");

  if (!coversRtl(locales)) {
    // Not a failure -- the job may deliberately cover only LTR markets -- but
    // it is the one thing a locale sweep is most often assumed to have done.
    log(
      `locale-shots ${job.job_id}: none of ${locales.map((l) => l.tag).join(", ")} is right-to-left, ` +
      "so mirroring is not covered by this run",
    );
  }

  const bundle = path.join(mkdtempSync(path.join(os.tmpdir(), "fleet-locale-")), "locale-shots");
  mkdirSync(bundle, { recursive: true });
  const sheet: SheetShot[] = [];

  const granted = job.targets?.exclusive
    ? await acquireLocks(job.job_id, targets.map((t) => t.id))
    : null;

  let allOk = true;
  let totalShots = 0;
  try {
    for (const target of targets) {
      if (granted && !granted.has(target.id)) {
        await postResult({ job_id: job.job_id, device_id: target.id, iter: 0, ok: true, error: "skipped: device locked by another job" });
        continue;
      }
      const cannot = unmanageableReason(target);
      if (cannot) {
        allOk = false;
        await postResult({ job_id: job.job_id, device_id: target.id, iter: 0, ok: false, error: cannot });
        log(`locale-shots on ${target.id}: refused -- ${cannot}`);
        continue;
      }
      if (!(await hasApp(target, appId))) {
        await postResult({ job_id: job.job_id, device_id: target.id, iter: 0, ok: true, error: `skipped: ${appId} not installed` });
        continue;
      }

      const deviceDir = safeName(target.id);
      const fingerprints = new Map<string, string>();
      let deviceShots = 0;
      let deviceOk = true;
      let iter = 0;

      for (const l of locales) {
        iter += 1;
        await postBeacon(job.job_id, target.id, {}).catch(() => {});
        const rel = `${localeDirName(l)}/${deviceDir}`;
        const dir = path.join(bundle, rel);
        mkdirSync(dir, { recursive: true });
        let error: string | undefined;

        try {
          await withState(target, "locale", localeSettings(target, l), async () => {
            const args = target.platform === "ios"
              ? ["-AppleLanguages", `(${l.tag})`, "-AppleLocale", appleLocaleOf(l)]
              : [];
            await relaunchApp(target, appId, args);
            await sleep(settleMs);
            if (flow) {
              const e = await runFlow(target, flow, dir, { APP_ID: appId, LOCALE: l.tag }, leaseBudgetS(job) * 1000);
              if (e) error = `flow failed: ${e.slice(-240)}`;
            } else {
              await takeScreenshot(target, path.join(dir, "launch.png"));
            }
          });
        } catch (e) {
          error = (e as Error).message.slice(0, 400);
        }

        const names = shotsIn(dir);
        deviceShots += names.length;
        totalShots += names.length;
        // One fingerprint per locale over every shot it produced, so "these two
        // locales rendered the same app" is one comparison rather than N.
        const digest = createHash("sha256");
        for (const n of names) digest.update(n).update(sha256File(path.join(dir, n)));
        if (names.length > 0) fingerprints.set(l.tag, digest.digest("hex"));

        if (names.length === 0) {
          // A locale that captured nothing still gets a row on the sheet, so
          // the column is a visible hole rather than an absent column.
          sheet.push({
            column: l.tag, rtl: l.rtl, device: target.id,
            shot: flow ? "(flow produced no screenshots)" : "launch",
            file: null, note: error,
          });
        } else {
          for (const n of names) {
            sheet.push({
              column: l.tag, rtl: l.rtl, device: target.id,
              shot: n.replace(/\.png$/i, ""), file: `${rel}/${n}`, note: error,
            });
          }
        }

        const ok = names.length > 0 && !error;
        if (!ok) { deviceOk = false; allOk = false; }
        await postResult({
          job_id: job.job_id, device_id: target.id, iter, ok,
          metrics: { shots: names.length },
          error: error ?? (names.length === 0 ? `no screenshot captured for ${l.tag}` : undefined),
        });
        log(`locale-shots ${appId} on ${target.id}: ${l.tag} -- ${names.length} shot(s)${error ? ` (${error.slice(0, 120)})` : ""}`);
      }

      // The check that makes the rest of it worth anything.
      let identical: string | undefined;
      if (fingerprints.size >= 2 && new Set(fingerprints.values()).size === 1) {
        identical =
          `every locale produced byte-identical screenshots (${[...fingerprints.keys()].join(", ")}), so the ` +
          "locale never reached the app -- the setting was applied and verified on the device, but the app " +
          "rendered the same language under all of them";
        deviceOk = false;
        allOk = false;
      }

      await postResult({
        job_id: job.job_id, device_id: target.id, iter: 0, ok: deviceOk,
        metrics: { locales: fingerprints.size, shots: deviceShots },
        error: identical ?? (deviceOk ? undefined : "one or more locales captured nothing"),
      });
      log(`locale-shots ${appId} on ${target.id}: ${fingerprints.size}/${locales.length} locales, ${deviceShots} shot(s)${identical ? " -- IDENTICAL" : ""}`);
    }
  } finally {
    if (granted) await releaseLocks(job.job_id);
  }

  const sha = await bundleShots(
    bundle, `locale-shots · ${appId}`, sheet, `${job.job_id}-locale-shots.zip`, { columnNoun: "locale" },
  );
  if (!sha) allOk = false;
  await postResult({
    job_id: job.job_id, device_id: `host:${NAME}`, iter: 0, final: true, ok: allOk,
    metrics: { locales: locales.length, shots: totalShots },
    // `artifacts`, not `test.artifacts`: the bundle is an output the run
    // produced, and filing shot counts as passed tests would put a number on
    // the dashboard's test column that no test ever produced.
    ...(sha ? { artifacts: [sha] } : {}),
    error: sha ? undefined : "nothing was captured, so there is no bundle",
  });
}

// ---------------------------------------------------------------------------
// a11y-audit
// ---------------------------------------------------------------------------

/** One point in a flow at which the tree is dumped and the screen captured. */
type A11yStep = { name: string; flow?: string };

function parseA11ySteps(params: Record<string, unknown> | undefined): A11yStep[] {
  const raw = params?.steps;
  if (Array.isArray(raw)) {
    const steps = raw.map((s) => {
      const file = String(s);
      return { name: safeName(path.basename(file).replace(/\.[^.]+$/, "")), flow: file };
    });
    if (steps.length === 0) throw new Error("params.steps is empty; there is nothing to audit");
    return steps;
  }
  if (typeof params?.flow === "string") {
    return [{ name: safeName(path.basename(params.flow).replace(/\.[^.]+$/, "")), flow: params.flow }];
  }
  // No flow at all: the launch screen is still worth auditing, and saying so is
  // better than requiring ceremony for the common first use.
  return [{ name: "launch" }];
}

/**
 * The accessibility tree for whatever is on screen, and what its bounds mean.
 *
 * Android reads its own dump. A simulator is read through Maestro, which drives
 * XCUITest underneath and is the only route to an iOS tree that does not
 * require building a test bundle -- so its absence is reported as the missing
 * tool it is, with the alternative named, rather than as an empty tree.
 */
async function dumpA11yTree(
  t: Target, density: number | null,
): Promise<{ nodes: A11yNode[]; geometry: A11yGeometry; source: string }> {
  if (t.platform === "android") {
    const remote = "/sdcard/fleet-a11y.xml";
    await exec(ADB, ["-s", t.id, "shell", "uiautomator", "dump", remote], { timeout: 90_000 });
    const { stdout } = await exec(ADB, ["-s", t.id, "shell", "cat", remote],
      { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
    await exec(ADB, ["-s", t.id, "shell", "rm", "-f", remote], { timeout: 15_000 }).catch(() => {});
    const parsed = parseUiautomatorDump(stdout);
    if (parsed.problem) throw new Error(`uiautomator dump: ${parsed.problem}`);
    return {
      nodes: parsed.nodes,
      // Pixels, and only convertible when the density is known. Passing
      // "unknown" is what makes the size check skip itself and say so, instead
      // of comparing a pixel count to a point guideline.
      geometry: density !== null ? { unit: "pixels", densityDpi: density } : { unit: "unknown" },
      source: "uiautomator dump",
    };
  }
  if (!existsSync(MAESTRO)) {
    throw new Error(
      `no accessibility-tree source for the iOS target ${t.id}: Maestro is not installed on ${NAME} ` +
      `(looked for ${MAESTRO}), and the other route is an XCUITest helper printing ` +
      "XCUIApplication().debugDescription, which the FleetRunner bundle does not print yet " +
      "(the parser for it is parseXcuiDebugDescription in src/a11y-tree.ts)",
    );
  }
  const { stdout } = await exec(MAESTRO, ["--device", t.id, "hierarchy"],
    { timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  const parsed = parseMaestroHierarchy(stdout);
  if (parsed.problem) throw new Error(`maestro hierarchy: ${parsed.problem}`);
  // Maestro's iOS driver reports XCUITest frames, which are already points.
  return { nodes: parsed.nodes, geometry: { unit: "points" }, source: "maestro hierarchy" };
}

/**
 * The XCUITest route to an iOS tree: run the generic bundle with
 * TEST_RUNNER_FLEET_A11Y_DUMP=1 and read the dump out of the log.
 *
 * Selected with `params.tree_source: "xcuitest"`. It is one dump per device,
 * not one per step -- an xcodebuild run per step of a flow is not a thing that
 * can happen inside a lease -- so it audits the app's launch screen only, which
 * the run says on the row.
 *
 * It fails until the iOS runner grows the helper, and it fails by naming
 * exactly what is missing, because the alternative is a job that quietly audits
 * nothing on every simulator in the fleet.
 */
async function xcuitestA11yTree(t: Target, appId: string, timeoutS: number): Promise<A11yNode[]> {
  let out = "";
  try {
    const { stdout } = await exec(
      "xcodebuild",
      ["test", "-project", IOS_PROJECT, "-scheme", "FleetRunner",
       "-destination", `platform=${t.kind === "simulator" ? "iOS Simulator" : "iOS"},id=${t.id}`,
       "-only-testing:FleetRunnerUITests"],
      {
        timeout: timeoutS * 1000,
        env: { ...process.env, TEST_RUNNER_FLEET_APP_ID: appId, TEST_RUNNER_FLEET_A11Y_DUMP: "1" },
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    out = stdout;
  } catch (e) {
    out = (e as { stdout?: string }).stdout ?? "";
  }
  const m = /FLEET-A11Y-DUMP-BEGIN\r?\n([\s\S]*?)\r?\nFLEET-A11Y-DUMP-END/.exec(out);
  if (!m) {
    throw new Error(
      "the FleetRunner test bundle printed no accessibility dump. The iOS runner needs a test that, when " +
      "TEST_RUNNER_FLEET_A11Y_DUMP=1 is set, prints XCUIApplication().debugDescription between the lines " +
      "FLEET-A11Y-DUMP-BEGIN and FLEET-A11Y-DUMP-END. The parser for that output already exists here " +
      "(parseXcuiDebugDescription in src/a11y-tree.ts)",
    );
  }
  const parsed = parseXcuiDebugDescription(m[1]);
  if (parsed.problem) throw new Error(`XCUITest dump: ${parsed.problem}`);
  return parsed.nodes;
}

/**
 * a11y-audit: what a screen reader gets, and what the screen looks like to
 * somebody who has turned the accessibility settings up.
 *
 * Per step of the flow: the tree is dumped once, under baseline settings, and
 * checked for unlabelled tappables (error) and touch targets under the minimum
 * (warning, and only where the bounds can honestly be converted to points).
 * Then the same steps are walked again under each display condition and
 * screenshotted, so the bundle's contact sheet puts baseline, largest text,
 * bold text and dark mode side by side for each screen.
 *
 * Counts come out as issues_error / issues_warn, the same two fields web-audit
 * populates and the same severity rule: error fails the run, warn is recorded
 * and does not.
 *
 * Every display setting is journalled before it is written, verified after, and
 * restored in a finally -- with the startup sweep behind that. A phone left at
 * 2x text in dark mode is not obviously broken, which is exactly why nothing
 * would report it.
 */
async function runA11yAudit(job: Job) {
  const appId = (job.params?.app_id as string | undefined) ?? job.suite?.app_id;
  if (!appId) throw new Error("a11y-audit needs params.app_id");
  const steps = parseA11ySteps(job.params);
  const variants = parseVariantList(job.params?.variants);
  const minTargetPt = Number(job.params?.min_target_pt ?? 44);
  const settleMs = Number(job.params?.settle_ms ?? 4000);
  const fontScale = job.params?.font_scale !== undefined ? String(job.params.font_scale) : undefined;
  const treeSource = job.params?.tree_source === "xcuitest" ? "xcuitest" : "auto";
  const platform = job.app?.platform;
  const attached = (await listTargets()).filter((t) => !platform || t.platform === platform);
  const targets = await selectTargets(job, attached);
  if (targets.length === 0) throw new Error("no targets matched this job");

  // Resolved before anything runs, so a mistyped step fails the job with one
  // message rather than half a matrix.
  const stepFlows = new Map<string, string>();
  for (const s of steps) if (s.flow) stepFlows.set(s.name, resolveFlow(s.flow));

  const bundle = path.join(mkdtempSync(path.join(os.tmpdir(), "fleet-a11y-")), "a11y-audit");
  mkdirSync(bundle, { recursive: true });
  const sheet: SheetShot[] = [];
  const report: Record<string, unknown> = { app_id: appId, devices: {} };
  const devices = report.devices as Record<string, unknown>;

  const granted = job.targets?.exclusive
    ? await acquireLocks(job.job_id, targets.map((t) => t.id))
    : null;

  let allOk = true;
  let totalShots = 0;
  try {
    for (const target of targets) {
      if (granted && !granted.has(target.id)) {
        await postResult({ job_id: job.job_id, device_id: target.id, iter: 0, ok: true, error: "skipped: device locked by another job" });
        continue;
      }
      const cannot = unmanageableReason(target);
      if (cannot) {
        allOk = false;
        await postResult({ job_id: job.job_id, device_id: target.id, iter: 0, ok: false, error: cannot });
        log(`a11y-audit on ${target.id}: refused -- ${cannot}`);
        continue;
      }
      if (!(await hasApp(target, appId))) {
        await postResult({ job_id: job.job_id, device_id: target.id, iter: 0, ok: true, error: `skipped: ${appId} not installed` });
        continue;
      }

      const dPlatform: DisplayPlatform = target.platform === "android" ? "android" : "ios-sim";
      const sdk = target.platform === "android" ? await androidSdkLevel(target) : null;
      const density = target.platform === "android" ? await androidDensityDpi(target) : null;
      const deviceDir = safeName(target.id);
      const findings: Finding[] = [];
      const treeNotes: string[] = [];
      let deviceShots = 0;
      let deviceOk = true;
      let iter = 0;

      for (const vid of variants) {
        const plan = planVariant(vid, dPlatform, { sdk, fontScale });
        iter += 1;
        await postBeacon(job.job_id, target.id, {}).catch(() => {});

        if (plan.unreachable) {
          // A condition this platform cannot produce is a failed row naming the
          // limitation. Skipping it silently would leave a bundle whose columns
          // look complete and whose bold-text column is ordinary weight.
          deviceOk = false;
          allOk = false;
          for (const s of steps) {
            sheet.push({ column: plan.label, device: target.id, shot: s.name, file: null, note: plan.unreachable });
          }
          await postResult({
            job_id: job.job_id, device_id: target.id, iter, ok: false,
            error: `${plan.label}: ${plan.unreachable}`,
          });
          log(`a11y-audit on ${target.id}: ${plan.label} unreachable -- ${plan.unreachable}`);
          continue;
        }

        let variantError: string | undefined;
        let variantShots = 0;
        try {
          await withState(target, "display", plan.settings, async () => {
            await relaunchApp(target, appId);
            await sleep(settleMs);
            for (const s of steps) {
              const flow = stepFlows.get(s.name);
              if (flow) {
                const e = await runFlow(target, flow, mkdtempSync(path.join(os.tmpdir(), "fleet-step-")),
                  { APP_ID: appId }, leaseBudgetS(job) * 1000);
                if (e && !variantError) variantError = `step ${s.name}: ${e.slice(-200)}`;
              }
              await sleep(1000);

              const rel = `${plan.label}/${deviceDir}/${s.name}.png`;
              try {
                await takeScreenshot(target, path.join(bundle, rel));
                variantShots += 1;
                deviceShots += 1;
                totalShots += 1;
                sheet.push({ column: plan.label, device: target.id, shot: s.name, file: rel });
              } catch (e) {
                sheet.push({ column: plan.label, device: target.id, shot: s.name, file: null, note: (e as Error).message.slice(0, 200) });
                if (!variantError) variantError = (e as Error).message.slice(0, 200);
              }

              // The tree is read once, under the baseline: the checks are about
              // labels and geometry, and re-running them per condition would
              // multiply every finding by four without learning anything.
              if (vid !== "baseline") continue;
              try {
                if (treeSource === "xcuitest" && target.platform === "ios") {
                  const nodes = await xcuitestA11yTree(target, appId, leaseBudgetS(job));
                  findings.push(...a11yFindings(nodes, { unit: "points" }, { step: s.name, minTargetPt }));
                  treeNotes.push(`${s.name}: XCUITest debugDescription (launch screen only)`);
                } else {
                  const tree = await dumpA11yTree(target, density);
                  findings.push(...a11yFindings(tree.nodes, tree.geometry, { step: s.name, minTargetPt }));
                  treeNotes.push(`${s.name}: ${tree.nodes.length} elements via ${tree.source}`);
                }
              } catch (e) {
                // A step whose tree could not be read is an ERROR finding, not a
                // silent gap: a screen nobody could inspect is not a screen that
                // passed.
                findings.push({
                  severity: "error", check: "a11y-tree", page: s.name,
                  detail: (e as Error).message.slice(0, 300),
                });
              }
            }
          });
        } catch (e) {
          variantError = (e as Error).message.slice(0, 400);
        }

        // Shots CAPTURED, not steps asked for: a condition that produced two
        // of four screens must not report four.
        const ok = !variantError && variantShots === steps.length;
        if (!ok) { deviceOk = false; allOk = false; }
        await postResult({
          job_id: job.job_id, device_id: target.id, iter, ok,
          metrics: { shots: variantShots },
          error: variantError
            ? `${plan.label}: ${variantError}`
            : ok ? undefined : `${plan.label}: captured ${variantShots} of ${steps.length} screens`,
        });
        log(`a11y-audit ${appId} on ${target.id}: ${plan.label} — ${variantShots}/${steps.length} screens${variantError ? ` -- ${variantError.slice(0, 140)}` : ""}`);
      }

      const totals = countBySeverity(findings);
      if (totals.issues_error > 0) { deviceOk = false; allOk = false; }
      devices[target.id] = {
        platform: target.platform, kind: target.kind, sdk, density_dpi: density,
        min_target_pt: minTargetPt, trees: treeNotes, findings,
        ...totals,
      };
      const firstError = findings.find((f) => f.severity === "error");
      await postResult({
        job_id: job.job_id, device_id: target.id, iter: 0, ok: deviceOk,
        metrics: { ...totals, shots: deviceShots },
        error: deviceOk
          ? undefined
          : firstError
            ? `${totals.issues_error} error(s), e.g. ${firstError.check} on ${firstError.page}: ${firstError.detail.slice(0, 140)}`
            : "one or more display conditions could not be captured",
      });
      log(`a11y-audit ${appId} on ${target.id}: ${totals.issues_error} error(s) / ${totals.issues_warn} warning(s), ${deviceShots} shot(s)`);
    }
  } finally {
    if (granted) await releaseLocks(job.job_id);
  }

  const reportSha = await uploadReport(`${job.job_id}-a11y-report.json`, report);
  const zipSha = await bundleShots(
    bundle, `a11y-audit · ${appId}`, sheet, `${job.job_id}-a11y-shots.zip`, { columnNoun: "condition" },
  );
  await postResult({
    job_id: job.job_id, device_id: `host:${NAME}`, iter: 0, final: true, ok: allOk,
    metrics: { shots: totalShots },
    artifacts: [reportSha, ...(zipSha ? [zipSha] : [])],
    error: zipSha ? undefined : "no screenshot was captured, so there is no bundle (the findings report is still attached)",
  });
}

const LAUNCH_STATES = ["cold", "warm", "hot"] as const;
type LaunchState = (typeof LAUNCH_STATES)[number];

/** The launcher activity `am start -n` needs, resolved the same way launchApp does. */
async function androidLaunchComponent(target: Target, appId: string): Promise<string> {
  const { stdout } = await exec(
    ADB, ["-s", target.id, "shell", "cmd", "package", "resolve-activity", "--brief", appId],
    { timeout: 15_000 },
  );
  const component = stdout.replace(/\r/g, "").trim().split("\n").pop()?.trim();
  if (!component || !component.includes("/")) {
    throw new Error(`no launcher activity for ${appId}: ${stdout.trim().slice(0, 160)}`);
  }
  return component;
}

/**
 * Put the app into `state`, then launch it once and ask the framework how long
 * that took.
 *
 * The three states are three different pieces of choreography, and the
 * difference between them is the whole measurement:
 *
 *   cold -- force-stop first, so the process is gone and Android builds it from
 *           nothing. This is the number a user feels after a reboot.
 *   warm -- launch again with the process still around. No force-stop, by
 *           definition: warm IS "the app is still in memory".
 *   hot  -- HOME first, so the activity is merely backgrounded, then return to
 *           it. The cheapest launch there is.
 *
 * `am start -W` blocks until the activity reports it is displayed and prints
 * TotalTime, which is the framework's own time-to-first-frame. That is why this
 * path exists and the iOS ones below do not: nothing in simctl or devicectl
 * answers the same question.
 */
async function androidLaunchOnce(target: Target, component: string, appId: string, state: LaunchState) {
  if (state === "cold") {
    await exec(ADB, ["-s", target.id, "shell", "am", "force-stop", appId], { timeout: 20_000 });
    // Force-stop returns before the process is reaped; measuring into that
    // window times a launch that is still racing the teardown.
    await new Promise((r) => setTimeout(r, 800));
  } else if (state === "hot") {
    await exec(ADB, ["-s", target.id, "shell", "input", "keyevent", "KEYCODE_HOME"], { timeout: 20_000 });
    await new Promise((r) => setTimeout(r, 1200));
  }
  const { stdout } = await exec(
    ADB, ["-s", target.id, "shell", "am", "start", "-W", "-n", component],
    { timeout: 90_000 },
  );
  return parseAmStart(stdout);
}

/**
 * cold-start: how long the app takes to put its first frame on screen, N times
 * over, in each launch state.
 *
 * One result row per launch — never a pre-averaged one. The collector computes
 * p50 and p95 from the rows, split by launch_state, because a percentile mixing
 * cold and hot launches describes nothing that ever happens to a person holding
 * the phone.
 *
 * Android is the only platform this can measure honestly, and that is a
 * statement about the tooling rather than about the app:
 *
 *   Android      -- `am start -W` reports TotalTime, the framework's own
 *                   time-to-first-frame. Real measurement.
 *   iOS simulator-- `simctl launch` returns once the process is SPAWNED. That
 *                   is not time to first frame, it is a much smaller number
 *                   that would sit in a field documented as time to first
 *                   frame and be read as one. Reported as a failed row naming
 *                   the limitation.
 *   iOS device   -- devicectl has the same gap and one more: no force-stop by
 *                   bundle id, so the cold state cannot even be established.
 *
 * The honest iOS path is on-device (XCTApplicationLaunchMetric in an XCUITest
 * run, or the runner app reporting its own first frame) — it needs a runner
 * change in another repo, not a number invented here.
 */
async function runColdStart(job: Job) {
  const appId = (job.params?.app_id as string | undefined) ?? job.suite?.app_id;
  if (!appId) throw new Error("cold-start job needs params.app_id");
  const launches = Math.max(1, Number(job.params?.launches ?? 10));
  const asked = job.params?.states;
  const states = (Array.isArray(asked) ? asked.map(String) : [...LAUNCH_STATES]) as LaunchState[];
  for (const s of states) {
    if (!LAUNCH_STATES.includes(s)) {
      throw new Error(`params.states has ${JSON.stringify(s)}; launch states are ${LAUNCH_STATES.join(", ")}`);
    }
  }
  if (states.length === 0) throw new Error("params.states is empty; nothing to measure");

  const platform = job.app?.platform ?? "android";
  const targets = await selectTargets(job, (await listTargets()).filter((t) => t.platform === platform));
  if (targets.length === 0) throw new Error(`no ${platform} targets matched this job`);

  let allOk = true;
  for (const target of targets) {
    // iOS, both kinds: say what is missing and stop. A spawn time filed as
    // launch_ms would be indistinguishable downstream from an Android
    // time-to-first-frame, and every comparison drawn from the pair would be
    // wrong in the app's favour.
    if (target.platform === "ios") {
      allOk = false;
      const why = target.kind === "device"
        ? "devicectl cannot time an iOS device's first frame (and cannot force-stop by bundle id, " +
          "so the cold state cannot be established); measure it on-device with XCTApplicationLaunchMetric"
        : "simctl launch returns when the process is spawned, not when the first frame is presented, " +
          "so there is no honest time-to-first-frame here; measure it with XCTApplicationLaunchMetric in a ui-test job";
      await postResult({ job_id: job.job_id, device_id: target.id, iter: 0, ok: false, error: why });
      log(`cold-start on ${target.id}: unsupported — ${why}`);
      continue;
    }

    if (!(await hasApp(target, appId))) {
      await postResult({ job_id: job.job_id, device_id: target.id, iter: 0, ok: true, error: `skipped: ${appId} not installed` });
      log(`cold-start on ${target.id}: skipped (${appId} not installed)`);
      continue;
    }

    let component: string;
    try {
      component = await androidLaunchComponent(target, appId);
    } catch (e) {
      allOk = false;
      await postResult({ job_id: job.job_id, device_id: target.id, iter: 0, ok: false, error: (e as Error).message.slice(0, 300) });
      log(`cold-start on ${target.id}: ${(e as Error).message}`);
      continue;
    }

    let iter = 0;
    for (const state of states) {
      // The lease is renewed per state, not per job: ten launches of a heavy
      // app in three states outlives a default lease comfortably, and a swept
      // job would be re-claimed and re-run on the same phone.
      await postBeacon(job.job_id, target.id, {}).catch(() => {});

      // One discarded warm-up launch per state, and it is not optional. Each
      // state is defined by what the OS is holding when the launch starts, and
      // the launch before the first measured one is what puts it there: the
      // first "warm" launch after a cold start would otherwise be measured
      // against a process that was never warm, and the first launch of the run
      // as a whole carries one-time work (dexopt, first-run migrations) that no
      // user pays twice.
      try {
        await androidLaunchOnce(target, component, appId, state);
      } catch (e) {
        allOk = false;
        iter += 1;
        await postResult({
          job_id: job.job_id, device_id: target.id, iter, ok: false,
          error: `${state} warm-up launch failed: ${(e as Error).message.slice(0, 240)}`,
        });
        log(`cold-start ${appId} on ${target.id}: ${state} warm-up failed, skipping the state`);
        continue;
      }

      const measured: number[] = [];
      for (let i = 0; i < launches; i++) {
        iter += 1;
        let parsed;
        try {
          parsed = await androidLaunchOnce(target, component, appId, state);
        } catch (e) {
          allOk = false;
          await postResult({
            job_id: job.job_id, device_id: target.id, iter, ok: false,
            error: `${state} launch ${i + 1} failed: ${(e as Error).message.slice(0, 240)}`,
          });
          continue;
        }
        const problem = amStartProblem(parsed);
        if (problem || parsed.totalMs === null) {
          allOk = false;
          await postResult({
            job_id: job.job_id, device_id: target.id, iter, ok: false,
            error: `${state} launch ${i + 1}: ${problem ?? "no TotalTime"}`,
          });
          continue;
        }
        // LaunchState (Android 10+) is the framework's verdict on what that
        // launch actually was, and it beats our choreography's intent: a
        // force-stopped app the OS still had warm really did launch warm, and
        // filing it as cold is how a p95 stops meaning anything. When the
        // platform is too old to say, the state we drove is the best available.
        const reported = parsed.launchState ?? state;
        if (parsed.launchState && parsed.launchState !== state) {
          log(`cold-start ${appId} on ${target.id}: asked for ${state}, the framework reported ${parsed.launchState} — filing it as ${parsed.launchState}`);
        }
        measured.push(parsed.totalMs);
        await postResult({
          job_id: job.job_id, device_id: target.id, iter, ok: true,
          metrics: { launch_ms: parsed.totalMs, launch_state: reported },
        });
      }
      const mean = measured.length > 0 ? Math.round(measured.reduce((a, b) => a + b, 0) / measured.length) : null;
      log(`cold-start ${appId} on ${target.id}: ${state} — ${measured.length}/${launches} launches, mean ${mean ?? "?"} ms`);
    }
  }
  await postResult({ job_id: job.job_id, device_id: `host:${NAME}`, iter: 0, final: true, ok: allOk });
}

/**
 * web-test: Playwright against a URL.
 *
 * No device, so no target list and no locks — the "device" on the result row is
 * the browser, because a result row needs a device_id and pretending a phone
 * was involved would be worse than naming what actually ran.
 *
 * Browsers install into the executor's own home directory, so this stays
 * sudo-free like everything else on these machines.
 */
async function runWebTest(job: Job) {
  const url = job.targets?.url;
  if (!url) throw new Error("web-test needs targets.url");
  const spec = (job.suite?.flows as string | undefined) ?? ".";
  const specRoot = path.resolve(WEB_SPECS_DIR);
  const specDir = path.resolve(specRoot, spec);
  // The separator matters: a bare prefix test lets `../web-specs-evil` through,
  // because it really does start with `.../web-specs`.
  if (specDir !== specRoot && !specDir.startsWith(specRoot + path.sep)) {
    throw new Error("suite.flows escapes the specs dir");
  }

  // Only executors with browsers installed can honestly run this. The fleet
  // has them on one machine, so an unpinned web job landing anywhere else must
  // say "this host has no browsers" rather than fail somewhere inside npx --
  // or worse, quietly download a browser onto a 2016 laptop mid-nightly.
  if (process.env.FLEET_WEB !== "1") {
    await postResult({
      job_id: job.job_id, device_id: `host:${NAME}`, iter: 0, final: true, ok: false,
      error: `executor ${NAME} has no browsers; pin web-test with targets.executor`,
    });
    log(`refused web-test ${job.job_id}: no browsers on ${NAME}`);
    return;
  }

  // Which config projects to run: one name, an array run in sequence, or "all".
  // "all" asks Playwright for the resolved config rather than keeping a copy of
  // the project names here — a copy is how a project added to the config would
  // silently never run in the nightly that exists to run everything.
  const asked = job.params?.browser ?? "chromium";
  const projects = asked === "all"
    ? await listWebProjects()
    : (Array.isArray(asked) ? asked.map(String) : [String(asked)]);
  if (projects.length === 0) throw new Error("params.browser named no projects");

  // Nothing beacons DURING a single project's run, so each one must finish
  // inside the lease or the sweep requeues a job that is still running and a
  // second executor runs the same suite concurrently. Between projects a
  // beacon renews the lease, which is what lets a matrix of N projects run on
  // the same lease one project needs. next-job reports the lease the collector
  // granted. Stop a little short of it so a timing-out run reports its own
  // failure rather than being swept mid-flight and silently re-run by whoever
  // claims it next.
  const timeoutS = leaseBudgetS(job);

  let allOk = true;
  for (const [i, project] of projects.entries()) {
    if (i > 0) await postBeacon(job.job_id, `web:${project}`, {}).catch(() => {});
    const ok = await runWebProject(job, url, specDir, project, timeoutS);
    if (!ok) allOk = false;
  }
  await postResult({ job_id: job.job_id, device_id: `host:${NAME}`, iter: 0, final: true, ok: allOk });
}

/** Every file under dir, named by its path relative to dir. */
function walkFiles(dir: string, rel: string): { file: string; name: string }[] {
  const found: { file: string; name: string }[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) found.push(...walkFiles(abs, r));
    else if (e.isFile()) found.push({ file: abs, name: r });
  }
  return found;
}

/** The project names playwright.config.ts resolves to, via --list. */
async function listWebProjects(): Promise<string[]> {
  const { stdout } = await exec("npx", ["playwright", "test", "--list", "--reporter=json"], {
    timeout: 120_000,
    env: { ...process.env, CI: "1" },
    maxBuffer: 64 * 1024 * 1024,
  });
  const report = JSON.parse(stdout.slice(stdout.indexOf("{"))) as {
    config?: { projects?: { name?: string }[] };
  };
  const names = [...new Set((report.config?.projects ?? []).map((p) => p.name ?? "").filter(Boolean))];
  if (names.length === 0) throw new Error("playwright --list reported no projects");
  return names;
}

/** One config project against the URL; posts its own result row. */
async function runWebProject(
  job: Job, url: string, specDir: string, project: string, timeoutS: number,
): Promise<boolean> {
  const deviceId = `web:${project}`;
  const out = mkdtempSync(path.join(os.tmpdir(), `web-${job.job_id}-${project}-`));

  const args = [
    "playwright", "test", specDir,
    `--project=${project}`,
    "--reporter=json",
    `--output=${out}`,
  ];
  const started = Date.now();
  let passed = 0;
  let failed = 0;
  let ok = false;
  let detail = "";

  try {
    const { stdout } = await exec("npx", args, {
      timeout: timeoutS * 1000,
      env: { ...process.env, PLAYWRIGHT_BASE_URL: url, CI: "1" },
    });
    // Playwright's JSON reporter puts the counts in stats; a non-zero exit is
    // a failing suite, not a broken run, so both paths report rather than throw.
    const report = JSON.parse(stdout.slice(stdout.indexOf("{")));
    passed = report.stats?.expected ?? 0;
    failed = (report.stats?.unexpected ?? 0) + (report.stats?.flaky ?? 0);
    ok = failed === 0 && passed > 0;
  } catch (e: unknown) {
    const err = e as { stdout?: string; message?: string };
    try {
      const report = JSON.parse((err.stdout ?? "").slice((err.stdout ?? "").indexOf("{")));
      passed = report.stats?.expected ?? 0;
      failed = (report.stats?.unexpected ?? 0) + (report.stats?.flaky ?? 0);
      detail = report.errors?.[0]?.message ?? "";
    } catch {
      detail = (err.message ?? String(e)).slice(0, 400);
      failed = failed || 1;
    }
  }

  // A trace or screenshot is the whole reason a failing web test is
  // debuggable later, so upload whatever Playwright left behind.
  // Playwright puts trace.zip, the failure screenshot and error-context.md in a
  // per-test SUBDIRECTORY, not at the top level. A flat readdir here uploads
  // .last-run.json and silently loses everything that makes a red suite
  // debuggable, so walk the tree and name each file by its relative path.
  const artifacts: string[] = [];
  for (const f of (existsSync(out) ? walkFiles(out, "") : [])) {
    // The project is part of the name: two projects failing the same test
    // otherwise upload artifacts under identical names.
    artifacts.push(await uploadArtifact(f.file, `${job.job_id}-${project}-${f.name.replace(/\//g, "_")}`));
  }

  await postResult({
    job_id: job.job_id, device_id: deviceId, iter: 0,
    ok, test: { passed, failed, artifacts },
    error: ok ? undefined : detail || `${failed} failing`,
  });
  log(`web-test ${url} (${project}): ${passed} passed / ${failed} failed in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  return ok;
}

type ShotsManifest = {
  profiles?: string[];
  threshold_pct?: number;
  freeze_time?: string;
  pages?: {
    name?: string; path?: string; waitFor?: string; mask?: string[];
    fullPage?: boolean; threshold_pct?: number; settle_ms?: number;
  }[];
};

/**
 * A profile the matrix captures under. Most are playwright.config.ts project
 * names run via the _shots spec; two are meta-names that expand to real
 * hardware attached to THIS host:
 *
 *   "android-device"  -> one `android:<serial>` profile per fleet-owned
 *                        Android device, real Chrome driven over adb
 *   "ios-sim-safari"  -> one `ios-sim:<name>` profile per booted fleet-owned
 *                        simulator, Safari via simctl
 *
 * Expansion is per-device on purpose: two phones have two screens, so they
 * are two baselines — collapsing them under one profile would diff a Pixel
 * against an S21 and call the hardware difference a regression.
 *
 * `missing` marks a meta-name that expanded to nothing here: the profile the
 * manifest asked for cannot run on this host, and the run must say so rather
 * than quietly shrink. (Split device profiles into their own job pinned to
 * the executor whose shelf holds the hardware.)
 */
type WebProfile = {
  profile: string;
  target?: { kind: "android" | "ios-sim"; id: string };
  missing?: string;
};

async function expandWebProfiles(names: string[]): Promise<WebProfile[]> {
  const out: WebProfile[] = [];
  let all: Target[] | null = null;
  const targets = async () => (all ??= await listTargets());
  for (const name of names) {
    if (name === "android-device") {
      const owned: Target[] = [];
      for (const t of (await targets()).filter((t) => t.platform === "android")) {
        if (await fleetOwnedTarget(t, null)) owned.push(t);
      }
      if (owned.length === 0) out.push({ profile: name, missing: `no fleet-owned Android device attached to ${NAME}` });
      for (const t of owned) out.push({ profile: `android:${t.id}`, target: { kind: "android", id: t.id } });
    } else if (name === "ios-sim-safari") {
      const sims = await simctlDevices();
      const booted = (await targets()).filter((t) => t.platform === "ios" && t.kind === "simulator");
      let any = false;
      for (const t of booted) {
        const nm = simulatorName(t.id, sims);
        if (!fleetOwned(nm)) continue;
        any = true;
        out.push({ profile: `ios-sim:${nm ?? t.id}`, target: { kind: "ios-sim", id: t.id } });
      }
      if (!any) out.push({ profile: name, missing: `no booted fleet-owned simulator on ${NAME}` });
    } else {
      out.push({ profile: name });
    }
  }
  return out;
}

/** Reject after `s` seconds — device captures must not outlive the lease. */
function withTimeout<T>(p: Promise<T>, s: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} did not finish inside ${s}s`)), s * 1000).unref()),
  ]);
}

// Mirrors the CSS the _shots spec injects; the android path drives a Page
// directly, so it carries its own copy.
const KILL_MOTION_CSS =
  "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }";

/**
 * Real Chrome on a real (fleet-owned) Android device, via Playwright's
 * android support over adb. Same determinism steps as the _shots spec; the
 * PNGs land in the same layout, so the shared verdict/diff code downstream
 * never knows a phone was involved.
 *
 * Dynamic import: this executor also runs on hosts that will never capture,
 * and they should not pay to load playwright at startup.
 */
async function captureAndroidShots(
  serial: string, manifest: ShotsManifest, url: string, outDir: string,
): Promise<string> {
  const { _android } = await import("playwright");
  const devices = await _android.devices();
  const device = devices.find((d) => d.serial() === serial);
  if (!device) {
    for (const d of devices) await d.close().catch(() => {});
    throw new Error(`playwright's adb sees no device ${serial}`);
  }
  let detail = "";
  try {
    const context = await device.launchBrowser();
    try {
      const page = await context.newPage();
      if (manifest.freeze_time) await page.clock.setFixedTime(new Date(manifest.freeze_time));
      await page.emulateMedia({ reducedMotion: "reduce" });
      for (const p of manifest.pages ?? []) {
        try {
          await page.goto(new URL(p.path!, url).toString(), { waitUntil: "load", timeout: 30_000 });
          if (p.waitFor) await page.locator(p.waitFor).first().waitFor({ timeout: 15_000 });
          await page.addStyleTag({ content: KILL_MOTION_CSS });
          await page.evaluate(() => document.fonts.ready.then(() => undefined));
          await page.screenshot({
            path: path.join(outDir, `${p.name}.png`),
            fullPage: p.fullPage ?? true,
            animations: "disabled",
            mask: (p.mask ?? []).map((s) => page.locator(s)),
          });
        } catch (e) {
          // Leave the PNG absent; the per-page row downstream reports it. Keep
          // the first failure as the run's detail — later ones usually echo it.
          if (!detail) detail = (e as Error).message.slice(0, 200);
        }
      }
    } finally {
      await context.close().catch(() => {});
    }
  } finally {
    await device.close().catch(() => {});
    for (const d of devices) if (d !== device) await d.close().catch(() => {});
  }
  return detail;
}

/**
 * Safari on a booted fleet simulator: openurl, settle, screenshot. True
 * WebKit rendering with none of Playwright's control — no waitFor, no masks,
 * no fullPage, and Safari's own chrome is in frame. The status bar is pinned
 * (Apple's own 9:41, full battery) so the clock does not diff against itself
 * nightly; `settle_ms` per page stands in for waitFor.
 *
 * The simulator is shared state, and the capture inherits it: a system dialog
 * another job left up, or a "back to app" breadcrumb from whatever opened
 * Safari last, is in the shot. That is deliberate — dismissing a dialog some
 * suspended XCUITest is waiting on would break THAT job to prettify this one.
 * A polluted shot diffs red, a person sees why on the review grid, and the
 * fix is fleet hygiene, not capture cleverness.
 */
async function captureSimSafariShots(
  udid: string, manifest: ShotsManifest, url: string, outDir: string,
): Promise<string> {
  let detail = "";
  await exec("xcrun", ["simctl", "status_bar", udid, "override",
    "--time", "9:41", "--batteryState", "charged", "--batteryLevel", "100",
    "--wifiBars", "3", "--cellularBars", "4"], { timeout: 30_000 }).catch(() => {});
  try {
    // Cold-start warm-up. The first openurl may LAUNCH Safari, and a shot
    // taken on a per-page settle budget catches it mid-launch — observed as a
    // black screen where the page should be, accepted as a 97%-wrong
    // baseline. Open the first page and give the launch its own budget before
    // any capture; ready-and-idle is what makes the per-page settle honest.
    const first = manifest.pages?.[0];
    if (first) {
      await exec("xcrun", ["simctl", "openurl", udid, new URL(first.path!, url).toString()], { timeout: 30_000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 8000));
    }
    for (const p of manifest.pages ?? []) {
      try {
        await exec("xcrun", ["simctl", "openurl", udid, new URL(p.path!, url).toString()], { timeout: 30_000 });
        await new Promise((r) => setTimeout(r, p.settle_ms ?? 4000));
        await exec("xcrun", ["simctl", "io", udid, "screenshot", path.join(outDir, `${p.name}.png`)], { timeout: 30_000 });
      } catch (e) {
        if (!detail) detail = (e as Error).message.slice(0, 200);
      }
    }
  } finally {
    await exec("xcrun", ["simctl", "status_bar", udid, "clear"], { timeout: 30_000 }).catch(() => {});
  }
  return detail;
}

/**
 * web-shots: the screenshot half of the visual-regression matrix.
 *
 * Captures every page in the suite's shots.json under each requested config
 * project and uploads the PNGs. Capture only — baselines and diffing arrive
 * with the collector's baselines table (Phase 3), so today's rows say "these
 * pixels exist", not "these pixels are right".
 *
 * The actual browser work happens in web-specs/_shots/capture.spec.ts, run as
 * a Playwright test so `--project=` means exactly what it means for web-test.
 * Result shape follows drain: per-page rows at iter 1..N, a per-profile
 * summary at iter 0, and the host row closing the job.
 *
 * Each captured page is diffed against the accepted baseline the collector
 * holds for (suite, page, profile). Diffing happens HERE, on the one host that
 * captures, because a baseline is only comparable to pixels rendered by the
 * same machine — fonts and antialiasing differ across hosts, so moving the
 * capture host invalidates every baseline, and pretending the collector could
 * judge that would hide it. A page with no baseline reports ok with a note:
 * the first capture of a new page must not fail the nightly, but must stay
 * visible until someone accepts it.
 */
async function runWebShots(job: Job) {
  const url = job.targets?.url;
  if (!url) throw new Error("web-shots needs targets.url");
  const spec = job.suite?.flows as string | undefined;
  if (!spec) throw new Error("web-shots needs suite.flows (the web-specs/<site> directory holding shots.json)");
  const specRoot = path.resolve(WEB_SPECS_DIR);
  const specDir = path.resolve(specRoot, spec);
  // Same separator rule as web-test: a bare prefix test lets `../web-specs-evil` through.
  if (specDir !== specRoot && !specDir.startsWith(specRoot + path.sep)) {
    throw new Error("suite.flows escapes the specs dir");
  }
  const manifestPath = path.join(specDir, "shots.json");
  if (!existsSync(manifestPath)) throw new Error(`no shots manifest: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ShotsManifest;
  const pages = manifest.pages ?? [];
  if (pages.length === 0) throw new Error(`${manifestPath} lists no pages`);
  // Page names become file names and artifact names, so they are validated
  // here — before a browser launches — rather than discovered as a half-run
  // matrix when the screenshot path fails to write.
  for (const p of pages) {
    if (!p.name || !/^[a-z0-9][a-z0-9_-]*$/i.test(p.name)) {
      throw new Error(`shots.json page name unusable as a filename: ${JSON.stringify(p.name)}`);
    }
    if (!p.path) throw new Error(`shots.json page '${p.name}' has no path`);
  }
  if (new Set(pages.map((p) => p.name)).size !== pages.length) {
    throw new Error("shots.json page names must be unique — they name the artifacts");
  }

  // Same honesty rule as web-test: only a host with browsers may run this.
  if (process.env.FLEET_WEB !== "1") {
    await postResult({
      job_id: job.job_id, device_id: `host:${NAME}`, iter: 0, final: true, ok: false,
      error: `executor ${NAME} has no browsers; pin web-shots with targets.executor`,
    });
    log(`refused web-shots ${job.job_id}: no browsers on ${NAME}`);
    return;
  }

  // The job may override the manifest's profiles; same forms as web-test.
  const asked = job.params?.browser ?? manifest.profiles ?? "chromium";
  const profiles = asked === "all"
    ? await listWebProjects()
    : (Array.isArray(asked) ? asked.map(String) : [String(asked)]);
  if (profiles.length === 0) throw new Error("no profiles: params.browser and shots.json both named none");

  // The accepted truth for this suite, keyed page|profile. Fetched once per
  // job, not per profile: every profile in one run diffs against the same
  // accepted set even if someone clicks accept mid-run.
  const suite = path.relative(specRoot, specDir) || ".";
  const baselines = new Map<string, string>();
  {
    const res = await fetch(`${BASE}/api/visual/baselines?suite=${encodeURIComponent(suite)}`);
    if (!res.ok) throw new Error(`baselines fetch -> ${res.status}`);
    const body = (await res.json()) as { baselines: { page: string; profile: string; sha256: string }[] };
    for (const b of body.baselines) baselines.set(`${b.page}|${b.profile}`, b.sha256);
  }

  // Same per-profile lease budget as web-test, renewed by a beacon between
  // profiles: the lease budgets one profile's capture, not the whole matrix.
  const timeoutS = leaseBudgetS(job);

  const expanded = await expandWebProfiles(profiles);

  // Device-backed captures drive hardware the device-executor also hands work
  // to, so they hold collector locks for the whole run — a benchmark starting
  // mid-capture would pollute both jobs' results.
  const deviceIds = expanded.filter((e) => e.target).map((e) => e.target!.id);
  const granted = deviceIds.length > 0 ? await acquireLocks(job.job_id, deviceIds) : null;

  let allOk = true;
  try {
  for (const [i, entry] of expanded.entries()) {
    const profile = entry.profile;
    if (i > 0) await postBeacon(job.job_id, `web:${profile}`, {}).catch(() => {});
    // A meta-profile that found no hardware here: fail its slot plainly.
    if (entry.missing) {
      allOk = false;
      await postResult({
        job_id: job.job_id, device_id: `web:${profile}`, iter: 0, ok: false,
        test: { passed: 0, failed: pages.length, artifacts: [] },
        error: `${entry.missing}; pin device captures to the executor whose shelf holds them`,
      });
      log(`web-shots ${url} (${profile}): ${entry.missing}`);
      continue;
    }
    // Locked hardware is skipped, not failed — the precedent every other
    // host-driven workload sets.
    if (entry.target && granted && !granted.has(entry.target.id)) {
      await postResult({
        job_id: job.job_id, device_id: `web:${profile}`, iter: 0, ok: true,
        test: { passed: 0, failed: 0, artifacts: [] },
        error: "skipped: device locked by another job",
      });
      log(`web-shots ${url} (${profile}): skipped (locked)`);
      continue;
    }
    const outDir = mkdtempSync(path.join(os.tmpdir(), `shots-${job.job_id}-${profile.replace(/[^a-zA-Z0-9_-]/g, "_")}-`));
    const testResults = path.join(outDir, "test-results");
    const started = Date.now();
    let detail = "";
    try {
      // Device captures honour params.network: shaping is applied around the
      // capture and restored after it, including when the capture throws. A
      // profile the target cannot take throws out of here into the catch below,
      // so the profile's failure is what the pages report — not a clean-looking
      // capture taken under conditions nobody asked for.
      if (entry.target?.kind === "android") {
        const t: Target = { id: entry.target.id, platform: "android", kind: "device" };
        detail = await withNetwork(job, t, () => withTimeout(
          captureAndroidShots(t.id, manifest, url, outDir), timeoutS, `android capture on ${t.id}`));
      } else if (entry.target?.kind === "ios-sim") {
        const t: Target = { id: entry.target.id, platform: "ios", kind: "simulator" };
        detail = await withNetwork(job, t, () => withTimeout(
          captureSimSafariShots(t.id, manifest, url, outDir), timeoutS, `simulator capture on ${t.id}`));
      } else {
        await exec(
          "npx",
          ["playwright", "test", path.join(specRoot, "_shots"),
           `--project=${profile}`, "--reporter=json", `--output=${testResults}`],
          {
            timeout: timeoutS * 1000,
            env: {
              ...process.env, CI: "1", PLAYWRIGHT_BASE_URL: url,
              SHOTS_MANIFEST: manifestPath, SHOTS_OUT: outDir,
            },
            maxBuffer: 64 * 1024 * 1024,
          },
        );
      }
    } catch (e: unknown) {
      // A non-zero exit is some pages failing to capture; the per-page rows
      // below say which. Keep the message for pages with nothing better.
      detail = ((e as Error).message ?? String(e)).slice(0, 300);
    }

    // Per-page verdict: captured, and within threshold of the accepted
    // baseline. The metric is a named field — diff_pct — never laundered
    // through a slot that means something else.
    let captured = 0;
    let diverged = 0;
    const shas: string[] = [];
    for (const [pi, p] of pages.entries()) {
      const file = path.join(outDir, `${p.name}.png`);
      const capturedOk = existsSync(file);
      let ok = capturedOk;
      let diffPct: number | undefined;
      let note: string | undefined;
      let sha: string | undefined;
      let diffSha: string | undefined;
      const rowArtifacts: string[] = [];
      if (capturedOk) {
        sha = await uploadArtifact(file, `${job.job_id}-${profile}-${p.name}.png`);
        rowArtifacts.push(sha);
        shas.push(sha);
        captured++;
        const baseline = baselines.get(`${p.name}|${profile}`);
        const threshold = Number(p.threshold_pct ?? manifest.threshold_pct ?? 0.1);
        if (!baseline) {
          // Visible, not failing: a new page's first capture is not a
          // regression, but it stays flagged until someone accepts it.
          note = "new: no baseline — accept this shot to start diffing";
        } else if (baseline === sha) {
          diffPct = 0; // identical bytes; nothing to decode
        } else {
          try {
            const diffFile = path.join(outDir, `${p.name}-diff.png`);
            const d = await diffShot(file, baseline, diffFile);
            diffPct = d.diffPct;
            if (diffPct > threshold) {
              ok = false;
              diverged++;
              note = d.note ?? `${diffPct.toFixed(2)}% of pixels differ (threshold ${threshold}%)`;
              // The diff image only when it matters: a within-threshold pair
              // has nothing worth a person's look, and the store is forever.
              if (d.wroteDiff) {
                diffSha = await uploadArtifact(diffFile, `${job.job_id}-${profile}-${p.name}-diff.png`);
                rowArtifacts.push(diffSha);
              }
            }
          } catch (e) {
            // A baseline the store cannot produce is an operational problem,
            // not a visual regression — but it must fail, loudly, because a
            // page that cannot be judged is not a page that passed.
            ok = false;
            diverged++;
            note = `baseline ${baseline.slice(0, 12)}… unreadable: ${(e as Error).message.slice(0, 200)}`;
          }
        }
      } else {
        note = `no screenshot for page '${p.name}'${detail ? `: ${detail}` : ""}`;
      }
      await postResult({
        job_id: job.job_id, device_id: `web:${profile}`, iter: pi + 1, ok,
        ...(diffPct !== undefined ? { metrics: { diff_pct: Number(diffPct.toFixed(4)) } } : {}),
        test: { passed: ok ? 1 : 0, failed: ok ? 0 : 1, artifacts: rowArtifacts },
        // The structured identity of this cell of the matrix. The dashboard
        // grid is assembled from these, never parsed out of iter order or the
        // note text — iter maps to manifest order, and manifests change.
        shot: {
          suite, page: p.name, profile,
          ...(sha ? { sha256: sha } : {}),
          ...(diffSha ? { diff_sha256: diffSha } : {}),
        },
        error: note,
      });
    }

    // A capture that missed pages left traces/screenshots explaining why;
    // upload them onto the profile summary so a red matrix is debuggable.
    const debris: string[] = [];
    if (captured < pages.length && existsSync(testResults)) {
      for (const f of walkFiles(testResults, "")) {
        debris.push(await uploadArtifact(f.file, `${job.job_id}-${profile}-debris-${f.name.replace(/\//g, "_")}`));
      }
    }

    const missed = pages.length - captured;
    const ok = missed === 0 && diverged === 0;
    if (!ok) allOk = false;
    const problems = [
      ...(missed > 0 ? [`${missed} of ${pages.length} pages not captured`] : []),
      ...(diverged > 0 ? [`${diverged} page(s) diverged from baseline`] : []),
    ].join("; ");
    await postResult({
      job_id: job.job_id, device_id: `web:${profile}`, iter: 0, ok,
      test: { passed: pages.length - missed - diverged, failed: missed + diverged, artifacts: [...shas, ...debris] },
      error: ok ? undefined : problems,
    });
    log(
      `web-shots ${url} (${profile}): ${captured}/${pages.length} pages` +
      (diverged ? `, ${diverged} diverged` : "") +
      ` in ${((Date.now() - started) / 1000).toFixed(0)}s`,
    );
  }
  } finally {
    if (granted) await releaseLocks(job.job_id);
  }
  await postResult({ job_id: job.job_id, device_id: `host:${NAME}`, iter: 0, final: true, ok: allOk });
}

/**
 * How far the captured pixels drifted from the baseline, as a percent of the
 * pixel grid, writing a visual diff image when any pixel drifted.
 *
 * A size change short-circuits to 100%: pixelmatch cannot compare mismatched
 * grids, and a page whose full-page height changed has materially changed
 * however its overlapping pixels look. Antialiasing differences are ignored
 * (pixelmatch's default) — they are the noise floor of same-host rendering.
 */
async function diffShot(
  currentFile: string, baselineSha: string, diffFile: string,
): Promise<{ diffPct: number; note?: string; wroteDiff: boolean }> {
  const baseFile = path.join(mkdtempSync(path.join(os.tmpdir(), "fleet-base-")), "baseline.png");
  await fetchArtifact(baselineSha, baseFile);
  const cur = PNG.sync.read(readFileSync(currentFile));
  const base = PNG.sync.read(readFileSync(baseFile));
  if (cur.width !== base.width || cur.height !== base.height) {
    return {
      diffPct: 100,
      note: `size changed: ${base.width}x${base.height} -> ${cur.width}x${cur.height}`,
      wroteDiff: false,
    };
  }
  const diff = new PNG({ width: cur.width, height: cur.height });
  const mismatched = pixelmatch(base.data, cur.data, diff.data, cur.width, cur.height, { threshold: 0.1 });
  if (mismatched > 0) writeFileSync(diffFile, PNG.sync.write(diff));
  return { diffPct: (mismatched / (cur.width * cur.height)) * 100, wroteDiff: mismatched > 0 };
}

/**
 * Describe an attached device well enough to target it.
 *
 * Match expressions are evaluated against a descriptor, so a device registered
 * without one can never be selected by `os ~ 'android'` -- it would show up on
 * the dashboard and silently never be given work.
 */
async function describeTarget(
  t: Target,
  sims: Record<string, { udid: string; name: string }[]> | null,
  ios: IosDeviceInfo[] | null,
): Promise<Record<string, unknown>> {
  if (t.platform === "android") {
    const prop = async (k: string) => {
      try {
        return (await exec(ADB, ["-s", t.id, "shell", "getprop", k], { timeout: 10_000 })).stdout.trim();
      } catch {
        return "";
      }
    };
    const [model, release, memKb] = await Promise.all([
      prop("ro.product.model"),
      prop("ro.build.version.release"),
      (async () => {
        try {
          const out = (await exec(ADB, ["-s", t.id, "shell", "cat", "/proc/meminfo"], { timeout: 10_000 })).stdout;
          return Number(/MemTotal:\s+(\d+)/.exec(out)?.[1] ?? 0);
        } catch {
          return 0;
        }
      })(),
    ]);
    return {
      model: model || t.id,
      os: release ? `android-${release}` : "android",
      ...(memKb ? { ram_mb: Math.round(memKb / 1024) } : {}),
      serial: t.id,
      attached_to: NAME,
      kind: t.kind,
    };
  }
  // iOS: ask simctl what this UDID actually is. A descriptor of
  // {model: "simulator", os: "ios"} would register the device but leave it
  // untargetable -- `os ~ 'ios-18'` matches nothing without the version, and
  // every simulator would look identical on the dashboard.
  try {
    for (const [runtime, list] of Object.entries(sims ?? {})) {
      const hit = list.find((d) => d.udid === t.id);
      if (!hit) continue;
      // "com.apple.CoreSimulator.SimRuntime.iOS-18-4" -> "ios-18.4"
      const v = /iOS-([\d-]+)$/.exec(runtime)?.[1]?.replace(/-/g, ".");
      return {
        model: hit.name,
        os: v ? `ios-${v}` : "ios",
        serial: t.id,
        attached_to: NAME,
        // simctl knows it, so it is a simulator whichever enumerator found it.
        kind: "simulator",
        // Belt and braces for isSimulator(), which reads model/os/soc: a
        // simulator that slips past that check lands in a hardware comparison,
        // which is the one thing the flag exists to prevent.
        soc: "simulator",
      };
    }
  } catch {
    // simctl changed its output shape.
  }

  // Physical hardware. `{model: "iphone", os: "ios"}` would register the phone
  // and leave it untargetable -- `os ~ 'ios-18'` matches nothing without the
  // version, and every iPhone on the shelf would look identical.
  const info = (ios ?? []).find((d) => d.identifier === t.id);
  if (info) {
    return {
      model: info.marketingName ?? info.name ?? "iphone",
      os: info.osVersion ? `ios-${info.osVersion}` : "ios",
      ...(info.productType ? { soc: info.productType } : {}),
      serial: t.id,
      attached_to: NAME,
      kind: "device",
    };
  }
  return { model: t.kind === "simulator" ? "simulator" : "iphone", os: "ios", serial: t.id, attached_to: NAME, kind: t.kind };
}

/**
 * Register the devices attached to this host, so the fleet knows they exist.
 *
 * A phone driven over adb never speaks to the collector itself: it has no
 * runner app polling, so nothing registers it and nothing refreshes its
 * last_seen. The result was a dashboard where the entire shelf read `offline`
 * however many phones were actually cabled up, and where host-driven results
 * were filed against serial numbers that had no device row at all.
 *
 * Best effort by design -- presence must never be the reason an executor stops
 * claiming work, so failures here are swallowed.
 */
/**
 * The virtual device name behind this target, or null if it is real hardware.
 *
 * Android emulators are resolved over adb because the serial (`emulator-5554`)
 * says nothing about which AVD it is -- the Xcode Mac was running one called
 * `jerv-test`, which has no business taking nightly work.
 */
async function virtualNameOf(
  t: Target,
  sims: Record<string, { udid: string; name: string }[]> | null,
): Promise<string | null> {
  if (t.platform === "ios") return simulatorName(t.id, sims);
  if (!isAndroidEmulatorSerial(t.id)) return null; // a cabled phone
  try {
    const { stdout } = await exec(ADB, ["-s", t.id, "emu", "avd", "name"], { timeout: 10_000 });
    // `adb emu` answers with the value then a trailing OK line.
    return stdout.split("\n").map((l) => l.trim()).filter((l) => l && l !== "OK")[0] ?? t.id;
  } catch {
    // Unreachable emulators cannot be identified, so they do not get in.
    return t.id;
  }
}

// Devices we have already complained about, so a permanently-paired phone
// does not print the same line every minute.
const announcedIos = new Set<string>();

let reporting = false;

async function reportAttached() {
  // Per-device work is bounded only by timeouts -- 10s per adb getprop against
  // a wedged phone -- so a sweep can outlast the interval that scheduled it.
  // Without this guard those runs overlap and compound adb contention against
  // a device an actual job may be driving.
  if (reporting) return;
  reporting = true;
  try {
    // One listing per sweep of each kind, not one per device. devicectl in
    // particular takes seconds and has a 30s timeout, so re-running it per
    // target is how a sweep starts outlasting the interval that scheduled it.
    const ios = await devicectlDevices();
    // A device the fleet is ignoring looks identical to one that was never
    // plugged in. Say why, once, so onboarding is diagnosable instead of
    // silent -- and say the RIGHT thing, because "unlock it" is useless advice
    // for a phone that is simply not paired with this Mac.
    for (const d of ios) {
      const reason = iosNotReadyReason(d);
      if (!reason) continue;
      const key = `${d.identifier}:${d.pairingState}:${d.tunnelState}`;
      if (announcedIos.has(key)) continue;
      announcedIos.add(key);
      log(reason);
    }
    let targets: Target[] = [];
    try {
      targets = await listTargets(ios);
    } catch (e) {
      // Was a bare `return`, which turned any enumerator failure into a host
      // that reports no devices at all and says nothing about why.
      log(`could not list attached devices: ${(e as Error).message.slice(0, 160)}`);
      return;
    }

    const sims = targets.some((t) => t.platform === "ios") ? await simctlDevices() : null;

    // devicectl and simctl can both report the same UDID, so without this the
    // device is registered twice a sweep with a different `kind` each time.
    const seen = new Set<string>();
    for (const t of targets) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      if (!(await fleetOwnedTarget(t, sims))) continue;
      try {
        await fetch(`${BASE}/devices/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ device_id: t.id, descriptor: await describeTarget(t, sims, ios), pools: [] }),
        });
      } catch {
        // Next tick will try again.
      }
    }
  } finally {
    reporting = false;
  }
}

/**
 * Undo every device change an earlier run of this executor left behind, before
 * a single job is claimed: network shaping, locale, and display settings.
 *
 * The failure this prevents, in its two flavours. A phone whose wifi was
 * disabled by a job that never reached its restore -- a reboot, an OOM, a pkill
 * aimed at something else -- looks exactly like a phone that has died: absent
 * from the dashboard, failing everything, with nothing naming the cause. A
 * phone left in Arabic at 2x text is the opposite and worse: it looks perfectly
 * healthy, answers every job, and quietly produces wrong screenshots until
 * somebody notices by eye. Restoring at startup turns both into one log line.
 *
 * Only devices this executor is allowed to touch, decided by the same
 * fleetOwned rule as presence and selection: a scratch phone somebody has
 * deliberately taken off the network, or deliberately set to Japanese, is not
 * ours to change back.
 */
async function restoreDevicesOnStartup() {
  try {
    const attached = await listTargets();
    const sims = attached.some((t) => t.platform === "ios") ? await simctlDevices() : null;
    const owned: Target[] = [];
    for (const t of attached) if (await fleetOwnedTarget(t, sims)) owned.push(t);
    const repaired = await restoreAttached(owned);
    log(
      repaired.length > 0
        ? `network: repaired ${repaired.length} device(s) left shaped by an earlier run: ${repaired.join(", ")}`
        : `network: ${owned.length} attached device(s), none needed repair`,
    );
    // The same sweep for locale and display settings, and for the same reason.
    // A phone left in Arabic at 2x text does not look broken -- it stays online
    // and answers every job -- so nothing else anywhere would ever report it.
    const restated = await restoreAttachedState(owned);
    log(
      restated.length > 0
        ? `device-state: repaired ${restated.length} device(s) left changed by an earlier run: ${restated.join(", ")}`
        : `device-state: ${owned.length} attached device(s), none needed repair`,
    );
  } catch (e) {
    // Never a reason not to start working: an executor that refuses to claim
    // because a restore sweep failed is a worse outage than the one it is
    // guarding against.
    log(`startup restore sweep failed: ${(e as Error).message.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// The workload loader
// ---------------------------------------------------------------------------

/**
 * The one ctx, built once from the real collector client.
 *
 * This object is the entire reason a moved handler is testable: it is the only
 * route a workload has to the collector, the artifact store, the device list
 * and the Keychain, so a test can hand the same handler a different one and
 * watch what it posts. Nothing here is new behaviour — every field is the
 * function the handlers were already calling as a module-level import.
 */
const CTX: WorkloadCtx = {
  host: NAME,
  log,
  postResult,
  postBeacon,
  fetchArtifact,
  uploadArtifact,
  // Wrapped rather than passed by reference: listTargets takes an optional
  // pre-fetched devicectl list, which only reportAttached has a reason to
  // supply. A workload asking "what is attached" should not have to know that.
  listTargets: () => listTargets(),
  selectTargets,
  leaseBudgetS,
  secrets: { credentialsFor: resolveCredentials, redact },
};

/**
 * The workload directories, scanned once at startup.
 *
 * At startup rather than per job so that a stranger who mistypes a manifest
 * hears about it when they restart the executor, instead of at 3am when the
 * nightly that needed it fails. `log` is passed in so the complaints appear in
 * this executor's log with everything else.
 */
const LOADED = discoverWorkloads(log);

/**
 * Send a job to whoever handles it.
 *
 * A lookup on the loaded directories first, then the if/else below for the
 * handlers that still live in this file. The fallback is not a transitional
 * embarrassment to be tidied away quickly — it is what lets a handler move on
 * its own, verified on its own, while the other eleven keep running exactly as
 * they did. When the chain is empty the chain goes; until then, a workload is
 * dispatched by whichever of the two knows it, and a name in neither gets the
 * same "not supported by this executor" row it always did.
 */
async function dispatch(job: Job, loaded: Map<string, LoadedWorkload>): Promise<void> {
  const w = loaded.get(job.workload);
  if (w) {
    const run = await loadRun(w);
    await run(job, CTX);
    return;
  }

  if (job.workload === "ui-test") await runUiTest(job);
  // Same implementation, and deliberately so: `soak` with no params.flow is
  // exactly the old behaviour, so the existing nightlies keep meaning what
  // they meant.
  else if (job.workload === "soak" || job.workload === "app-soak") await runAppSoak(job);
  else if (job.workload === "locale-shots") await runLocaleShots(job);
  else if (job.workload === "a11y-audit") await runA11yAudit(job);
  else if (job.workload === "drain") await runDrain(job);
  else if (job.workload === "cold-start") await runColdStart(job);
  else if (job.workload === "web-test") await runWebTest(job);
  else if (job.workload === "web-shots") await runWebShots(job);
  else if (job.workload === "web-audit") await runWebAudit(job);
  else if (job.workload === "web-unfurl") await runWebUnfurl(job);
  else if (job.workload === "archive") await runArchive(job);
  else if (job.workload === "digest") await runDigest(job);
  else {
    await postResult({
      job_id: job.job_id, device_id: `host:${NAME}`, iter: 0, final: true, ok: false,
      error: `workload '${job.workload}' not supported by this executor yet`,
    });
  }
}

async function main() {
  log(`polling ${BASE} (flows: ${FLOWS_DIR})`);
  log(
    LOADED.size > 0
      ? `workloads loaded from src/workloads: ${[...LOADED.keys()].sort().join(", ")}`
      : "no workload directories found; every job falls back to the built-in handlers",
  );
  await restoreDevicesOnStartup();
  // The dashboard calls a device online for ONLINE_S seconds after it was last
  // seen. Refreshing on a timer rather than per poll keeps presence steady
  // regardless of how long a long-poll blocks or how long a job runs.
  await reportAttached();
  setInterval(reportAttached, 60_000).unref();
  while (true) {
    let job: Job | null = null;
    try {
      const res = await fetch(`${BASE}/executor/next-job?name=${encodeURIComponent(NAME)}`);
      if (res.status === 204) continue;
      if (!res.ok) throw new Error(`next-job -> ${res.status}`);
      job = (await res.json()) as Job;
    } catch (e) {
      log(`poll error: ${(e as Error).message}; retrying in 10s`);
      await new Promise((r) => setTimeout(r, 10_000));
      continue;
    }

    log(`claimed ${job.job_id} (${job.workload})`);
    try {
      await dispatch(job, LOADED);
    } catch (e) {
      await postResult({
        job_id: job.job_id, device_id: `host:${NAME}`, iter: 0, final: true, ok: false,
        error: (e as Error).message.slice(0, 500),
      });
      log(`job ${job.job_id} failed: ${(e as Error).message}`);
    }
  }
}

main();
