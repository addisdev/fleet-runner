/**
 * The build-kind dispatch, and the naming that goes with it.
 *
 * The cases worth asserting are the ones a machine with a full toolchain would
 * never hit: an xcode build with no scheme, a kind nobody supports, and two
 * different repos whose remotes happen to end in the same name.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { planBuild, isBuildKind, repoCacheName, KIND_BINARY, BUILD_KINDS } from "../src/buildkinds.js";
import { defaultAppName } from "../src/workloads/build.js";
import { repoDirFor } from "../src/git.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const REPO = "/tmp/checkout";

test("only the three kinds are kinds", () => {
  assert.deepEqual([...BUILD_KINDS], ["gradle", "xcode", "npm"]);
  for (const k of BUILD_KINDS) assert.ok(isBuildKind(k));
  assert.ok(!isBuildKind("cmake"));
  assert.ok(!isBuildKind(undefined));
  assert.ok(!isBuildKind(""));
});

test("every kind names the binary its capability probe asks about", () => {
  assert.deepEqual(KIND_BINARY, { gradle: "gradle", xcode: "xcodebuild", npm: "node" });
});

test("gradle prefers the repo's own wrapper over the system binary", () => {
  const withWrapper = planBuild("gradle", { task: "assembleRelease" }, REPO, { hasGradlew: true });
  assert.equal(withWrapper.cmd, path.join(REPO, "gradlew"));
  const without = planBuild("gradle", { task: "assembleRelease" }, REPO, { hasGradlew: false });
  assert.equal(without.cmd, "gradle");
});

test("gradle's task is the target, and reaches the command line", () => {
  const plan = planBuild("gradle", { task: "assembleDebug" }, REPO, {});
  assert.equal(plan.target, "assembleDebug");
  assert.deepEqual(plan.args, ["assembleDebug", "--no-daemon", "--console=plain"]);
  assert.equal(plan.platform, "android");
});

test("gradle defaults to assembleRelease when no task is named", () => {
  assert.equal(planBuild("gradle", undefined, REPO, {}).target, "assembleRelease");
  // An empty string is not a task name; it must not become one.
  assert.equal(planBuild("gradle", { task: "   " }, REPO, {}).target, "assembleRelease");
});

test("an xcode build with no scheme is refused, not defaulted", () => {
  // xcodebuild with no -scheme builds whichever scheme it lists first, which
  // would report a green build of the wrong target.
  assert.throws(() => planBuild("xcode", {}, REPO, {}), /params\.scheme/);
  assert.throws(() => planBuild("xcode", { scheme: "" }, REPO, {}), /params\.scheme/);
});

test("a workspace wins over a project, and never both", () => {
  const ws = path.join(REPO, "App.xcworkspace");
  const proj = path.join(REPO, "App.xcodeproj");
  const plan = planBuild("xcode", { scheme: "App" }, REPO, { hasWorkspace: ws, hasProject: proj });
  assert.equal(plan.args[0], "-workspace");
  assert.equal(plan.args[1], ws);
  assert.ok(!plan.args.includes("-project"), "xcodebuild errors when given both");

  const projOnly = planBuild("xcode", { scheme: "App" }, REPO, { hasWorkspace: null, hasProject: proj });
  assert.equal(projOnly.args[0], "-project");
  assert.equal(projOnly.args[1], proj);

  const neither = planBuild("xcode", { scheme: "App" }, REPO, {});
  assert.equal(neither.args[0], "-scheme");
});

test("xcode's derived data path appears exactly once and is under the checkout", () => {
  const plan = planBuild("xcode", { scheme: "App" }, REPO, {});
  const at = plan.args.filter((a) => a === "-derivedDataPath");
  assert.equal(at.length, 1, "a repeated -derivedDataPath is an xcodebuild error");
  const dd = plan.args[plan.args.indexOf("-derivedDataPath") + 1];
  assert.equal(dd, path.join(REPO, ".fleet-derived-data"));
  assert.equal(plan.args.at(-1), "build");
  assert.equal(plan.platform, "ios");
  assert.deepEqual(plan.productExts, [".app"]);
});

test("npm runs a script, because `npm build` is not a thing", () => {
  assert.deepEqual(planBuild("npm", undefined, REPO, {}).args, ["run", "build"]);
  assert.deepEqual(planBuild("npm", { task: "bundle" }, REPO, {}).args, ["run", "bundle"]);
  assert.equal(planBuild("npm", undefined, REPO, {}).platform, null);
});

test("every plan runs in the checkout", () => {
  for (const kind of BUILD_KINDS) {
    const params = kind === "xcode" ? { scheme: "App" } : {};
    assert.equal(planBuild(kind, params, REPO, {}).cwd, REPO);
  }
});

test("two repos whose remotes end in the same name get different caches", () => {
  // github.com/a/app and github.com/b/app are absolutely a thing, and a cache
  // keyed on the basename would fetch one repo's refs into the other's
  // checkout and build the wrong code under the right name.
  const a = repoCacheName("https://github.com/alice/app.git", sha);
  const b = repoCacheName("https://github.com/bob/app.git", sha);
  assert.notEqual(a, b);
  assert.ok(a.startsWith("app-"), "the readable half is still the repo's name");
  assert.ok(b.startsWith("app-"));
});

test("a cache name is stable and filesystem-safe", () => {
  const repo = "git@github.com:addisdev/fleet runner.git";
  const once = repoCacheName(repo, sha);
  assert.equal(once, repoCacheName(repo, sha), "the same remote must key the same cache after a restart");
  assert.match(once, /^[A-Za-z0-9._-]+$/);
});

test("the clone cache lives under the agent's data dir", () => {
  const dir = repoDirFor("https://github.com/alice/app.git", { FLEET_CACHE_DIR: "/data/fleet" });
  assert.ok(dir.startsWith(path.join("/data/fleet", "repos") + path.sep), dir);
});

test("the published app name says which platform a build is for", () => {
  // Two builds of one repo — the Android one and the iOS one — must not both
  // be `greenfolio`, or `resolveLatestBuild` hands an iOS test an APK.
  assert.equal(defaultAppName("https://github.com/x/greenfolio.git", "gradle"), "greenfolio-android");
  assert.equal(defaultAppName("https://github.com/x/greenfolio.git", "xcode"), "greenfolio-ios");
  assert.equal(defaultAppName("https://github.com/x/greenfolio.git", "npm"), "greenfolio");
  assert.equal(defaultAppName("/local/path/tiny-repo", "npm"), "tiny-repo");
});
