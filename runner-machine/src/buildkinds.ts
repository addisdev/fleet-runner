/**
 * What "build it" means, per kind — chosen from the job's params, not guessed
 * from the repo.
 *
 * Three kinds, three toolchains, and one shape between them: a command, its
 * arguments, and where the product it leaves behind will be. Keeping the
 * decision pure means the dispatch is testable without a compiler installed,
 * which matters because the interesting cases here are the refusals — a
 * `kind: "xcode"` with no scheme, a `kind` nobody supports — and those are
 * exactly the ones a machine with Xcode on it would never exercise.
 */
import path from "node:path";

export const BUILD_KINDS = ["gradle", "xcode", "npm"] as const;
export type BuildKind = (typeof BUILD_KINDS)[number];

export function isBuildKind(v: unknown): v is BuildKind {
  return typeof v === "string" && (BUILD_KINDS as readonly string[]).includes(v);
}

export type BuildPlan = {
  kind: BuildKind;
  /** The executable to run, resolved against the checkout when it lives there. */
  cmd: string;
  args: string[];
  /** Working directory, absolute. */
  cwd: string;
  /**
   * The thing being built, as it should read in an error row: a Gradle task,
   * an Xcode scheme, an npm script. `error: gradle exited 1` is a build that
   * might not have run; `error: assembleRelease failed` is a build that did.
   */
  target: string;
  /**
   * Where the product will be, relative to `cwd`, in the order they should be
   * searched. First existing match wins; `params.artifact` overrides all of it.
   */
  productDirs: string[];
  /** Extensions that count as the product, longest-first for `.app` vs `.apk`. */
  productExts: string[];
  /** `x-artifact-platform` for the upload, or null when the kind implies none. */
  platform: "android" | "ios" | null;
};

/**
 * What the machine must have for a kind to be claimable. The capability probe
 * asks these questions of the real filesystem; the mapping lives here so the
 * probe and the plan can never disagree about which binary a kind needs.
 */
export const KIND_BINARY: Record<BuildKind, string> = {
  gradle: "gradle",
  xcode: "xcodebuild",
  npm: "node",
};

/** Xcode projects generated from a `project.yml`. Bare `xcodegen` is not reliably on PATH. */
export const XCODEGEN = "/opt/homebrew/bin/xcodegen";

/** Where `npm pack` writes the tarball an npm build publishes. Under the checkout, so `git clean` takes it. */
export const PACK_DIR = ".fleet-pack";

const str = (params: Record<string, unknown> | undefined, key: string): string | undefined => {
  const v = params?.[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
};

/**
 * Turns a job's params into the command to run.
 *
 * Throws rather than substituting a default when the kind's one required
 * parameter is missing: an Xcode build with no scheme is not a build of
 * something reasonable, it is a build of whichever scheme `xcodebuild` happens
 * to list first, which would report a green build of the wrong target.
 */
export function planBuild(
  kind: BuildKind,
  params: Record<string, unknown> | undefined,
  repoDir: string,
  opts: { hasGradlew?: boolean; hasWorkspace?: string | null; hasProject?: string | null } = {},
): BuildPlan {
  if (kind === "gradle") {
    const task = str(params, "task") ?? "assembleRelease";
    // A repo's own wrapper is the version the repo was written against; the
    // system gradle is whatever this machine happens to have. Prefer the
    // wrapper wherever there is one, exactly as CI would.
    const cmd = opts.hasGradlew ? path.join(repoDir, "gradlew") : "gradle";
    return {
      kind, cmd, cwd: repoDir, target: task,
      args: [task, "--no-daemon", "--console=plain"],
      productDirs: ["app/build/outputs/apk", "build/outputs/apk", "app/build/outputs", "build/libs", "build"],
      productExts: [".apk", ".aab", ".jar"],
      platform: "android",
    };
  }

  if (kind === "xcode") {
    const scheme = str(params, "scheme");
    if (!scheme) throw new Error("build kind 'xcode' needs params.scheme");
    const configuration = str(params, "configuration") ?? "Debug";
    const destination = str(params, "destination") ?? "generic/platform=iOS Simulator";
    const derived = path.join(repoDir, ".fleet-derived-data");
    // -workspace and -project are mutually exclusive and xcodebuild errors on
    // both; a workspace wins because a repo that has one is a repo whose
    // schemes are defined there.
    const container = opts.hasWorkspace
      ? ["-workspace", opts.hasWorkspace]
      : opts.hasProject
        ? ["-project", opts.hasProject]
        : [];
    const args = [
      ...container,
      "-scheme", scheme,
      "-configuration", configuration,
      "-destination", destination,
      "-derivedDataPath", derived,
      "build",
    ];
    return {
      kind, cmd: "xcodebuild", args, cwd: repoDir, target: scheme,
      productDirs: [path.join(".fleet-derived-data", "Build", "Products")],
      productExts: [".app"],
      platform: "ios",
    };
  }

  // npm. `npm run <script>` rather than `npm build`, which is not a thing.
  //
  // The product is the tarball `npm pack` writes into PACK_DIR after the
  // script succeeds, not whatever the script left in dist/. A directory of
  // files is not an artifact the store can hold, and picking "the newest file
  // under dist" would publish one chunk of a bundle as if it were the build.
  const script = str(params, "task") ?? "build";
  return {
    kind, cmd: "npm", args: ["run", script], cwd: repoDir, target: script,
    productDirs: [PACK_DIR, "dist", "build", "out", "."],
    productExts: [".tgz", ".zip"],
    platform: null,
  };
}

/**
 * A stable, collision-free directory name for a repo's clone cache.
 *
 * The readable half is for whoever opens the cache directory; the hash half is
 * what makes it correct. Two remotes can absolutely end in `app.git` —
 * `github.com/a/app` and `github.com/b/app` — and a cache keyed on the basename
 * alone would fetch one repo's refs into the other's checkout and build the
 * wrong code under the right name.
 */
export function repoCacheName(repo: string, sha256Hex: (s: string) => string): string {
  const base = (repo.replace(/\/+$/, "").split(/[/\\:]/).pop() ?? "repo")
    .replace(/\.git$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 40);
  return `${base || "repo"}-${sha256Hex(repo).slice(0, 12)}`;
}
