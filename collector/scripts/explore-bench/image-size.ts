// Does a big screenshot reach the model at full size, or does the server
// shrink it first?
//
// The same screenshot is sent twice, once as captured and once halved. If the
// server reports the same prompt-token count for both, it is resizing images
// on its own and every "max_pixels" setting on our side is moot -- which is
// worth knowing before tuning it. A phone screenshot is 2.6 megapixels; the
// plan's phase 0 asks for this check above 1 MP.
//
//   npx tsx scripts/explore-bench/image-size.ts --base-url http://ultra.local:4000 --model pilot --png shot.png
import { readFileSync } from "node:fs";
import path from "node:path";
import { decodePng, boxResize } from "../../src/workloads/explore/image.js";
import { PNG } from "pngjs";

async function tokensFor(base: string, model: string, png: Buffer): Promise<number | null> {
  const res = await fetch(`${base.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(process.env.FLEET_EXPLORE_API_KEY ? { authorization: `Bearer ${process.env.FLEET_EXPLORE_API_KEY}` } : {}) },
    body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: [
      { type: "text", text: "Describe this screen in one word." },
      { type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } },
    ] }] }),
    signal: AbortSignal.timeout(300_000),
  });
  const body = await res.json() as { usage?: { prompt_tokens?: number } };
  return body.usage?.prompt_tokens ?? null;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const a = process.argv.slice(2);
  const get = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const full = readFileSync(get("--png")!);
  const src = decodePng(full);
  const half = boxResize(src, Math.floor(src.width / 2), Math.floor(src.height / 2));
  const out = new PNG({ width: half.width, height: half.height });
  half.data.copy(out.data);
  const base = get("--base-url") ?? "http://127.0.0.1:8091", model = get("--model") ?? "pilot";
  const tFull = await tokensFor(base, model, full);
  const tHalf = await tokensFor(base, model, PNG.sync.write(out));
  const mp = (w: number, h: number) => ((w * h) / 1e6).toFixed(2);
  console.log(`full ${src.width}x${src.height} (${mp(src.width, src.height)} MP): ${tFull} prompt tokens`);
  console.log(`half ${half.width}x${half.height} (${mp(half.width, half.height)} MP): ${tHalf} prompt tokens`);
  console.log(tFull !== null && tHalf !== null && tFull > tHalf * 1.5
    ? "the full-size image reached the model at a higher resolution: the server is not capping it"
    : "both sizes cost about the same: the server is resizing images itself (check its max image tokens / pixels setting)");
}
