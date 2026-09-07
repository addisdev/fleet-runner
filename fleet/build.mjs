#!/usr/bin/env node
/**
 * Bundle `fleet` into one file, with the collector and the agent inside it.
 *
 *   node build.mjs            # -> dist/
 *   node build.mjs --dev      # unminified, with a sourcemap
 *
 * ## The layout it produces
 *
 *   dist/
 *     bin/fleet.mjs        everything: the CLI, the collector, the agent, the executor
 *     runner-web/          the browser runner, served at /runner
 *     dash/dist/           the dashboard, if it was built (optional)
 *
 * The directory shape is not arbitrary: it mirrors the checkout's, so that the
 * collector's own `path.resolve(dirname(import.meta.url), "../runner-web/...")`
 * lands in the right place without the source needing to know whether it is
 * running from a bundle. Code that has to ask "am I bundled?" is code that
 * behaves differently in the thing you shipped from the thing you tested.
 *
 * ## What stays outside
 *
 * Playwright, and only Playwright. It is four hundred megabytes of browser that
 * a brain on a Raspberry Pi has no use for, it is needed by four host workloads
 * out of thirty, and since src/browser.ts made the import dynamic an executor
 * without it starts fine and says so when asked to do web work. Marking it
 * external means the bundle references it and finds it if it is installed.
 *
 * Everything else goes in, including Fastify. A release that resolved its
 * dependencies at install time would be a release that can fail to install.
 */
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const OUT = path.join(HERE, "dist");
const dev = process.argv.includes("--dev");

// The version is baked in rather than read at runtime, because the file it
// would be read from is in the repository and the bundle is not.
const version = readFileSync(path.join(ROOT, "VERSION"), "utf8").trim();
writeFileSync(
  path.join(HERE, "src/version.ts"),
  `/**
 * The version, baked in.
 *
 * Written by build.mjs from the repository's VERSION file, so the shipped
 * binary carries a number rather than looking for a file that is not next to
 * it. \`scripts/version.mjs\` keeps it honest with the other seven places --
 * see its header for why the number matters at all.
 */
export const VERSION = ${JSON.stringify(version)};
`,
);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(path.join(OUT, "bin"), { recursive: true });

const result = await build({
  entryPoints: [path.join(HERE, "src/cli.ts")],
  outfile: path.join(OUT, "bin/fleet.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // node:sqlite, node:test and friends are resolved by the runtime; esbuild's
  // platform:node handles the `node:` prefix, and this catches the rest.
  external: ["playwright", "playwright-core"],
  minify: !dev,
  sourcemap: dev ? "inline" : false,
  legalComments: "none",
  banner: {
    js: [
      "#!/usr/bin/env node",
      // Bundled ESM has no `require`, and a few transitive dependencies still
      // reach for it. This is the standard shim, and it is here rather than in
      // a source file because it is a property of the bundle, not of the code.
      "import { createRequire as __createRequire } from 'node:module';",
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
  define: { "process.env.FLEET_BUNDLED": '"1"' },
  logLevel: "info",
  metafile: true,
});

// The browser runner: one HTML file the collector serves at /runner, copied
// rather than inlined so that it stays editable in a release -- which is how it
// is developed, and the whole reason it has no build step.
cpSync(path.join(ROOT, "collector/runner-web"), path.join(OUT, "runner-web"), { recursive: true });

// The dashboard, if somebody built it. Optional on purpose: the collector
// serves a "run the build" page without it and everything else keeps working,
// which is exactly the property a release should not quietly lose.
const dash = path.join(ROOT, "collector/dash/dist");
if (existsSync(dash)) {
  cpSync(dash, path.join(OUT, "dash/dist"), { recursive: true });
  console.log("  dashboard: bundled");
} else {
  console.log("  dashboard: NOT built (run `npm run dash:build` in collector/ first if you want it in the release)");
}

// The example job specs and the web specs the executor's defaults point at.
for (const [from, to] of [
  ["collector/examples", "examples"],
  ["collector/schemas", "schemas"],
]) {
  const src = path.join(ROOT, from);
  if (existsSync(src)) cpSync(src, path.join(OUT, to), { recursive: true });
}

const bytes = Object.values(result.metafile.outputs).reduce((a, o) => a + o.bytes, 0);
console.log(`\n  ${path.relative(process.cwd(), path.join(OUT, "bin/fleet.mjs"))}  ${(bytes / 1024 / 1024).toFixed(1)} MB`);
console.log(`  version ${version}`);
console.log(`\nTry it:  node ${path.relative(process.cwd(), path.join(OUT, "bin/fleet.mjs"))} doctor`);
