// size-report: how big is this build, and what is big inside it.
//
// The cheapest workload in the fleet and one of the more useful. It touches no
// device, installs nothing, and needs no toolchain — it fetches the artifact a
// `build` job already published and reads its central directory. So it can run
// on every push, forever, and the value is entirely in the trend: a graph of
// download size per build answers "when did this get big" months later, which
// is a question nobody can answer retrospectively without having measured all
// along.
//
// ## Three numbers, because one number misleads
//
// `file_bytes` is the archive: what CI publishes and what the artifact store
// holds. `installed_bytes` is everything unpacked: roughly what the build
// occupies on the device. `download_bytes` is the sum of the compressed
// entries: closer to what a user waits for.
//
// They differ by a lot — an APK's native libraries compress well and its
// resources do not — and quoting one when somebody meant another is the usual
// way a size report misleads. So all three are on the row and each is named
// for what it is.
//
// The per-ABI grouping is the other deliberate choice. `lib/` being huge tells
// you nothing you did not know; `lib/arm64-v8a` being 18 MB of it tells you
// what to split.
import { writeFileSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readZipFile, summariseZip } from "../../zip-dir.js";
import type { Job, WorkloadCtx } from "../types.js";

export async function run(job: Job, ctx: WorkloadCtx): Promise<void> {
  const app = job.app;
  if (!app) throw new Error("size-report needs an app ref (name, build, sha256)");
  const top = Math.min(100, Math.max(1, Number(job.params?.top ?? 10)));

  const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-size-"));
  const archive = path.join(dir, `${app.name}.zip`);
  await ctx.fetchArtifact(app.sha256, archive);

  let summary;
  try {
    const { entries, fileBytes } = readZipFile(archive);
    summary = summariseZip(entries, fileBytes, top);
  } catch (e) {
    // A build that is not an archive is a real answer, not a crash: a macOS
    // binary or a raw .so would land here, and the reason should say which
    // artifact could not be read rather than surfacing a byte offset.
    throw new Error(
      `cannot read ${app.name}@${app.build} (${app.sha256.slice(0, 12)}) as an archive: ${(e as Error).message}`,
    );
  }

  const report = path.join(dir, `size-${job.job_id}.json`);
  writeFileSync(report, JSON.stringify({
    app: { name: app.name, build: app.build, sha256: app.sha256, platform: app.platform ?? null },
    ...summary,
  }, null, 2));
  const uploaded = await ctx.uploadArtifact(report, `size-${app.name}-${app.build}.json`);

  const mb = (n: number) => Math.round((n / 1048576) * 100) / 100;
  ctx.log(
    `size-report ${app.name}@${app.build}: ${mb(summary.file_bytes)} MB archive, ` +
    `${mb(summary.download_bytes)} MB download, ${mb(summary.installed_bytes)} MB installed, ` +
    `${summary.entries} files`,
  );
  for (const g of summary.groups.slice(0, 5)) ctx.log(`  ${g.group}: ${mb(g.bytes)} MB (${g.entries} files)`);

  await ctx.postResult({
    job_id: job.job_id,
    device_id: `host:${ctx.host}`,
    iter: 0,
    final: true,
    ok: true,
    metrics: {
      // artifact_bytes already means "the size of the produced app" on a build
      // row, so a size-report row uses the same name for the same quantity
      // rather than inventing a second one that means the same thing.
      artifact_bytes: summary.file_bytes,
      download_bytes: summary.download_bytes,
      installed_bytes: summary.installed_bytes,
      file_count: summary.entries,
      largest_entry_bytes: summary.largest[0]?.uncompressed ?? 0,
    },
    artifacts: [uploaded],
  });
}
