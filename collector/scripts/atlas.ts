// `npm run atlas -- <command>`: the Screen Atlas outside the queue (src/atlas.ts).
//
//   atlas capture --recipe <atlas.json> --checkout <app repo> --platform ios --device <udid|serial>
//                 --version <v> [--root ~/atlas] [--work <dir>]
//       Run the app's own screen walk on one device and file it under <root>/<app>/<v>/<platform>/.
//   atlas import <shots dir> --recipe <atlas.json> --platform ios --version <v> [--device <name>] [--root]
//       File shots a walk already wrote (no device touched).
//   atlas diff <app> <from> <to> [--root] [--out <dir>] [--threshold 0.1] [--platform ios]
//       Pixel diff per screen and variant; writes diff.json and report.html (default <root>/<app>/<to>/diff-from-<from>/).
//   atlas store <app> <version> [--root] [--to ultra:mnt/photos/atlas] [--catalog ultra:screen-atlas]
//       Copy a version to the NAS, verify every sha256 there, and put its index.json on ultra's own disk for the lake.
//   atlas ls [<app>] [--root]
//
// The same work as the `atlas` workload, for a person or a session; the workload is what the lab queues.
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  capturePlatform, diffDir, diffVersions, folderBytes, loadRecipe, normalizeShots, readIndex, storeAtlas, versionDir, writeIndex,
} from "../src/atlas.js";

const argv = process.argv.slice(2);
const cmd = argv.shift();
const flags: Record<string, string> = {};
const pos: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[++i] ?? "";
  else pos.push(argv[i]);
}
const home = (p: string) => p.replace(/^~(?=\/|$)/, os.homedir());
const root = home(flags.root ?? process.env.ATLAS_ROOT ?? "~/atlas");
const need = (k: string) => {
  const v = flags[k];
  if (!v) { console.error(`atlas ${cmd}: --${k} is required`); process.exit(2); }
  return v;
};

async function main(): Promise<number> {
  switch (cmd) {
    case "capture": {
      const recipe = loadRecipe(home(need("recipe")));
      const work = home(flags.work ?? mkdtempSync(path.join(os.tmpdir(), "atlas-")));
      const r = await capturePlatform({
        recipe, platform: need("platform"), checkout: home(need("checkout")), root, version: need("version"),
        device: need("device"), work, log: (l) => console.log(l),
      });
      console.log(`atlas: ${r.entries.length} shots in ${r.captureS} s (walk exit ${r.exit}); left out ${r.leftOut.length}: ${r.leftOut.slice(0, 5).join(", ")}`);
      if (r.index) console.log(`atlas: ${r.dir}/index.html (${(folderBytes(r.dir) / 1e6).toFixed(1)} MB)`);
      return r.entries.length > 0 ? 0 : 1;
    }
    case "import": {
      const src = home(pos[0] ?? "");
      if (!src || !existsSync(src)) { console.error("atlas import <shots dir> ..."); return 2; }
      const recipe = loadRecipe(home(need("recipe")));
      const platform = need("platform");
      const version = need("version");
      const pr = recipe.platforms[platform];
      if (!pr) { console.error(`the recipe has no platform ${platform}`); return 2; }
      const dir = versionDir(root, recipe.app, version);
      const { entries, leftOut } = normalizeShots(src, dir, platform, pr);
      writeIndex(dir, {
        app: recipe.app, version, commit: flags.commit ?? null, platform, entries,
        meta: { device: flags.device ?? "unknown", captured_at: new Date().toISOString(), capture_s: Number(flags["capture-s"] ?? 0), left_out: leftOut },
      });
      console.log(`atlas: ${entries.length} shots filed in ${dir}; left out ${leftOut.length}`);
      return entries.length > 0 ? 0 : 1;
    }
    case "diff": {
      const [app, from, to] = pos;
      if (!app || !from || !to) { console.error("atlas diff <app> <from> <to>"); return 2; }
      const out = home(flags.out ?? diffDir(root, app, from, to));
      const d = diffVersions(versionDir(root, app, from), versionDir(root, app, to), out, {
        thresholdPct: flags.threshold ? Number(flags.threshold) : undefined, only: flags.platform,
      });
      const c = d.counts;
      console.log(`atlas diff ${app} ${from} -> ${to}: ${c.changed} changed, ${c.resized} resized, ${c.new} new, ${c.gone} gone, ${c.same} same`);
      console.log(`atlas: ${out}/report.html`);
      return 0;
    }
    case "store": {
      const [app, version] = pos;
      if (!app || !version) { console.error("atlas store <app> <version>"); return 2; }
      const r = await storeAtlas(versionDir(root, app, version), app, version,
        flags.to ?? process.env.ATLAS_STORE ?? "ultra:mnt/photos/atlas", flags.catalog ?? process.env.ATLAS_CATALOG ?? "ultra:screen-atlas");
      console.log(`atlas: ${r.verified} of ${r.files} shots verified at ${r.dest}`);
      return 0;
    }
    case "ls": {
      const apps = pos[0] ? [pos[0]] : existsSync(root) ? readdirSync(root) : [];
      for (const a of apps) {
        const adir = path.join(root, a);
        if (!existsSync(adir)) continue;
        for (const v of readdirSync(adir).sort()) {
          const i = readIndex(path.join(adir, v));
          if (i) console.log(`${a} ${v}  ${i.counts.shots} shots, ${i.counts.screens} screens  ${Object.keys(i.platforms).join(",")}  ${i.commit?.slice(0, 10) ?? ""}`);
        }
      }
      return 0;
    }
    default:
      console.error("atlas capture|import|diff|store|ls (see the top of collector/scripts/atlas.ts)");
      return 2;
  }
}

main().then((c) => process.exit(c), (e) => { console.error(`atlas: ${(e as Error).message}`); process.exit(1); });
