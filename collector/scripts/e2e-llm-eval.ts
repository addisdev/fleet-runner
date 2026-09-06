/**
 * The judged chain, end to end: a collector, the real machine agent, a stub
 * judge, and one `llm-eval` job.
 *
 *   npx tsx scripts/e2e-llm-eval.ts
 *
 * Not part of `npm test`: it starts a second process (the machine agent, from
 * a sibling directory) and binds two extra ports, which is more than the
 * collector's suite should assume about a checkout. It is here rather than in
 * a scratch file because the thing it proves is not provable by unit tests —
 * that the artifacts, the capability routing, the scorer and the judge call
 * line up into one working chain.
 *
 * The judge is a stub rather than a real model, and deliberately so. What is
 * being checked is the plumbing and the arithmetic: that a rubric reaches the
 * endpoint, that PASS and FAIL are read from the first line, that judged items
 * land in `judge_score_pct` and never in `score_pct`. A real model would make
 * the run slow, non-deterministic, and dependent on a download — and would
 * check the model's taste rather than this code.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MACHINE = path.resolve(ROOT, "../runner-machine");
const TSX = path.join(ROOT, "node_modules/tsx/dist/cli.mjs");

let failed = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : detail ? ` — ${detail}` : ""}`);
  if (!cond) failed++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const a = srv.address();
      if (typeof a === "string" || a === null) return reject(new Error("no port"));
      srv.close(() => resolve(a.port));
    });
  });
}

/**
 * A judge that passes an answer mentioning "30 days" and fails one that does
 * not — a rule simple enough that the test knows the right answer, and shaped
 * exactly like what llama-server returns.
 */
function stubJudge(port: number) {
  const seen: string[] = [];
  const server = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const parsed = JSON.parse(body) as { messages: { content: string }[] };
      const prompt = parsed.messages[0].content;
      seen.push(prompt);
      const answer = /ANSWER: ([\s\S]*)$/.exec(prompt)?.[1] ?? "";
      const verdict = /30 days/i.test(answer) ? "PASS" : "FAIL";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { content: `${verdict}\nBecause the policy window ${verdict === "PASS" ? "is" : "is not"} stated.` } }],
      }));
    });
  });
  return new Promise<{ seen: string[]; close: () => void }>((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve({ seen, close: () => server.close() }));
  });
}

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), "fleet-llmeval-e2e-"));
  const port = await freePort();
  const judgePort = await freePort();
  const BASE = `http://127.0.0.1:${port}`;
  const JUDGE = `http://127.0.0.1:${judgePort}`;
  let collector: ChildProcess | undefined;
  let agent: ChildProcess | undefined;
  let judge: { seen: string[]; close: () => void } | undefined;

  try {
    collector = spawn(process.execPath, [TSX, "src/server.ts"], {
      cwd: ROOT,
      env: {
        ...process.env, FLEET_PORT: String(port),
        FLEET_DATA_DIR: path.join(dir, "data"), FLEET_ARTIFACT_DIR: path.join(dir, "artifacts"),
        FLEET_LOG_FILE: path.join(dir, "c.log"), FLEET_SWEEP_MS: "60000", FLEET_SCHEDULER_TICK_MS: "60000",
      },
      stdio: "ignore",
    });
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up */ }
      await sleep(300);
    }
    judge = await stubJudge(judgePort);

    agent = spawn(process.execPath, [TSX, "src/agent.ts"], {
      cwd: MACHINE,
      env: { ...process.env, FLEET_URL: BASE, FLEET_DEVICE_ID: "e2e-machine" },
      stdio: "ignore",
    });
    let device: any = null;
    for (let i = 0; i < 90 && !device; i++) {
      try {
        const r = await fetch(`${BASE}/api/devices/e2e-machine`);
        if (r.ok) device = await r.json();
      } catch { /* not yet */ }
      if (!device) await sleep(500);
    }
    check("the machine agent registers", !!device);
    check("it declares llm-eval", (device?.capabilities ?? []).includes("llm-eval"),
      JSON.stringify(device?.capabilities));

    // --- the two artifacts a judged run needs --------------------------------
    const evalSet = [
      { id: "capital", prompt: "Capital of France?", score: { kind: "exact", expect: "Paris" } },
      { id: "shape", prompt: "Give me the order id.", score: { kind: "regex", pattern: "^ORD-\\d{4}$" } },
      { id: "structured", prompt: "Return JSON with city and country.", score: { kind: "json", require_keys: ["city", "country"] } },
      { id: "policy", prompt: "What is the refund policy?", score: { kind: "judge", rubric: "must state the refund window" } },
      { id: "policy2", prompt: "Can I return this?", score: { kind: "judge", rubric: "must state the refund window" } },
    ];
    const completions = {
      capital: "Paris",
      shape: "ORD-9999",
      // Fenced JSON, which is what a model actually emits.
      structured: 'Sure:\n```json\n{"city":"Paris","country":"FR"}\n```',
      policy: "You can request a refund within 30 days of delivery.",
      // A refusal, so refusal_pct has something to find, and one the stub
      // judge will fail.
      policy2: "I cannot help with that.",
    };

    const upload = async (name: string, body: unknown) => {
      const file = path.join(dir, name);
      await writeFile(file, JSON.stringify(body));
      const res = await fetch(`${BASE}/artifacts`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "x-artifact-name": name },
        body: await (await import("node:fs/promises")).readFile(file),
      });
      const j = await res.json() as { sha256: string };
      return j.sha256;
    };
    const setSha = await upload("eval-set.json", evalSet);
    const compSha = await upload("completions.json", completions);

    // --- run it ---------------------------------------------------------------
    const jobId = `e2e-llm-eval-${Date.now().toString(36)}`;
    const res = await fetch(`${BASE}/jobs`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema: 1, job_id: jobId, workload: "llm-eval", executor: "device",
        params: {
          eval_set_sha256: setSha,
          completions_sha256: compSha,
          judge_endpoint: JUDGE,
          judge_model: "stub-judge",
        },
        targets: { device_id: "e2e-machine" },
      }),
    });
    check("the collector accepts an llm-eval job", res.ok, `${res.status} ${await res.text()}`);

    let job: any = null;
    for (let i = 0; i < 120; i++) {
      job = await (await fetch(`${BASE}/api/jobs/${jobId}`)).json();
      if (["done", "failed", "cancelled"].includes(job.status)) break;
      await sleep(1000);
    }
    check("the job finishes", job?.status === "done", `${job?.status}: ${job?.last_error ?? ""}`);

    const final = (job?.results ?? []).find((r: any) => r.payload?.final === true);
    const m = final?.payload?.metrics ?? {};
    // Three deterministic items, all correct.
    check("score_pct covers only the deterministic items", m.score_pct === 100, JSON.stringify(m.score_pct));
    check("scored_items counts them", m.scored_items === 3, String(m.scored_items));
    check("judged_items is counted separately", m.judged_items === 2, String(m.judged_items));
    // The stub passes the one mentioning 30 days and fails the refusal.
    check("judge_score_pct is the judged half alone", m.judge_score_pct === 50, String(m.judge_score_pct));
    check("the judge model is named on the row", m.judge_model === "stub-judge", String(m.judge_model));
    // One refusal out of five completions.
    check("refusal_pct counts refusals independently of correctness",
      Math.round(m.refusal_pct) === 20, String(m.refusal_pct));
    check("the judge was actually asked, once per judged item", judge!.seen.length === 2, String(judge!.seen.length));
    check("the rubric reached the judge", judge!.seen.every((p) => /must state the refund window/.test(p)));
    check("a per-item report is uploaded", Array.isArray(final?.payload?.artifacts) && final.payload.artifacts.length === 1,
      JSON.stringify(final?.payload?.artifacts));

    // --- the refusal that matters: a judged set with no judge -----------------
    const noJudgeId = `e2e-llm-eval-nojudge-${Date.now().toString(36)}`;
    await fetch(`${BASE}/jobs`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema: 1, job_id: noJudgeId, workload: "llm-eval", executor: "device",
        params: { eval_set_sha256: setSha, completions_sha256: compSha },
        targets: { device_id: "e2e-machine" },
      }),
    });
    let nj: any = null;
    for (let i = 0; i < 90; i++) {
      nj = await (await fetch(`${BASE}/api/jobs/${noJudgeId}`)).json();
      if (["done", "failed", "cancelled"].includes(nj.status)) break;
      await sleep(1000);
    }
    // The important one. Scoring the deterministic subset and calling it the
    // score would report a different measurement under the same name.
    check("a set needing a judge with no endpoint FAILS rather than scoring the rest",
      nj?.status === "failed", `${nj?.status}`);
    const njRow = (nj?.results ?? []).find((r: any) => r.payload?.final === true);
    check("and says why", /judge_endpoint/.test(njRow?.payload?.error ?? ""), njRow?.payload?.error ?? "");
  } finally {
    agent?.kill("SIGTERM");
    collector?.kill("SIGTERM");
    judge?.close();
    await rm(dir, { recursive: true, force: true });
  }

  console.log(failed === 0 ? "\nllm-eval e2e: ALL PASS" : `\nllm-eval e2e: ${failed} FAILURE(S)`);
  return failed === 0 ? 0 : 1;
}

process.exit(await main());
