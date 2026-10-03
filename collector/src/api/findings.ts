/**
 * The night-QA findings routes. The logic lives in src/findings.ts; this file
 * is the HTTP surface over it.
 *
 *   POST /findings                       executors post an ExploreFinding here
 *   GET  /api/findings                   the list (?app= &check= &status= &since= &limit=)
 *   GET  /api/findings/precision         per app x check, how often a person said "real"
 *   GET  /api/findings/digest            the morning digest, as text and as data
 *   GET  /api/findings/issues            every issue composed, dry run or filed
 *   GET  /api/findings/:id               one finding
 *   POST /api/findings/:id/verdict       a person's judgement (token-guarded)
 *
 * ## Guard posture
 *
 * `POST /findings` is open, exactly like `POST /results`: it is the executor
 * reporting work, and the collector's access control for executors is the
 * network (see README and FLEET_BIND), not the dashboard token. The verdict is
 * different -- it is a person's decision, and it decides which checks run
 * tomorrow night -- so it carries the same speed bump as cancel and ack.
 */
import type { FastifyInstance } from "fastify";
import {
  LIMITS,
  buildDigest,
  fileIssue,
  findingDetail,
  issueOptions,
  listFindings,
  listIssues,
  precision,
  setVerdict,
  storeFinding,
  validateFinding,
} from "../findings.js";
import { FINDINGS_REPOS, FINDINGS_REPOS_ERROR, GITHUB_ISSUES_ARMED, GITHUB_TOKEN } from "../config.js";
import type { Verdict } from "../workloads/explore/types.js";
import { requireToken } from "./guard.js";

type Announce = (event: { type: string; [k: string]: unknown }) => void;

/** A path id, or null when it is not a positive whole number. */
const idOf = (raw: string): number | null => (/^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : null);

export function registerFindings(app: FastifyInstance, announce: Announce) {
  app.post("/findings", { bodyLimit: LIMITS.body }, async (req, reply) => {
    const checked = validateFinding(req.body);
    if (!checked.ok) return reply.code(checked.status).send({ error: checked.error });

    const opts = issueOptions();
    const out = storeFinding(checked.finding, opts);
    announce({ type: "finding", id: out.finding.id, app: out.finding.app, new: out.isNew });

    // Filing is the one slow, outside call, so it happens after the row is
    // committed and after the executor has its answer. The executor does not
    // care whether GitHub was reachable; the audit list does, and records it.
    if (out.issue?.state === "pending") {
      fileIssue(out.finding.id, out.issue, opts)
        .then((r) => {
          app.log.info({ finding: out.finding.id, repo: r.repo, state: r.state, url: r.url }, "night-qa issue");
          announce({ type: "finding", id: out.finding.id, issue: r.state });
        })
        .catch((e) => app.log.error(e, "night-qa issue filing failed"));
    } else if (out.issue) {
      app.log.info({ finding: out.finding.id, repo: out.issue.repo, state: out.issue.state }, "night-qa issue recorded, not filed");
    }

    return reply.code(out.isNew ? 201 : 200).send({
      id: out.finding.id,
      new: out.isNew,
      seen_count: out.finding.seen_count,
      // Not part of the contract the workload needs; handy in its log.
      issue: out.finding.issue?.state ?? null,
    });
  });

  app.get("/api/findings", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const out = listFindings({ app: q.app, check: q.check, status: q.status, since: q.since, limit: Number(q.limit) || undefined });
    if (!out.ok) return reply.code(400).send({ error: out.error });
    return out.body;
  });

  // Literal paths before /:id. Fastify would prefer them anyway; ordering them
  // first says so to the next reader too.
  app.get("/api/findings/precision", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return precision({ app: q.app || undefined, min: q.min !== undefined ? Number(q.min) || undefined : undefined });
  });

  app.get("/api/findings/digest", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const hours = Math.min(168, Math.max(1, Number(q.hours ?? 12) || 12));
    return buildDigest(hours);
  });

  app.get("/api/findings/issues", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return {
      // Said on the page, so nobody has to read the environment to know
      // whether anything left the building.
      armed: GITHUB_ISSUES_ARMED && !!GITHUB_TOKEN,
      repos: FINDINGS_REPOS,
      repos_error: FINDINGS_REPOS_ERROR,
      issues: listIssues(Number(q.limit) || 100),
    };
  });

  app.get("/api/findings/:id", async (req, reply) => {
    const id = idOf((req.params as { id: string }).id);
    const f = id === null ? null : findingDetail(id);
    if (!f) return reply.code(404).send({ error: "no such finding" });
    return f;
  });

  app.post("/api/findings/:id/verdict", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const id = idOf((req.params as { id: string }).id);
    if (id === null) return reply.code(404).send({ error: "no such finding" });
    const b = (req.body ?? {}) as { verdict?: unknown; note?: unknown; duplicate_of?: unknown };
    if (!("verdict" in b)) return reply.code(400).send({ error: "verdict is required (or null to reopen)" });
    if (b.note !== undefined && b.note !== null && typeof b.note !== "string")
      return reply.code(400).send({ error: "note must be a string" });
    const dup = b.duplicate_of === undefined || b.duplicate_of === null ? null : Number(b.duplicate_of);
    if (dup !== null && !(Number.isInteger(dup) && dup > 0))
      return reply.code(400).send({ error: "duplicate_of must be a finding id" });

    const note = typeof b.note === "string" && b.note.trim() ? b.note.trim() : null;
    const out = setVerdict(id, (b.verdict ?? null) as Verdict | null, note, dup);
    if (!out.ok) return reply.code(out.status).send({ error: out.error });
    announce({ type: "finding", id, verdict: out.finding.verdict });
    return { ok: true, finding: out.finding };
  });
}
