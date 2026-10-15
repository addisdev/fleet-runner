/**
 * GET /metrics: the fleet in Prometheus text format.
 *
 * For the dashboards and alerting a company already runs. The collector's own
 * alert rules stay the source of truth for "page someone"; this is for graphs
 * and for the people whose on-call tooling is Grafana, not this dashboard.
 *
 * Every number is computed from the database on scrape. A scrape every 15 s
 * costs a handful of indexed COUNTs, and nothing has to be kept in step.
 */
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { APP_VERSION } from "../../version.js";
import { AGE, deviceStatus, isExpired } from "../shared.js";

type Sample = [labels: Record<string, string>, value: number];

const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');

function family(name: string, type: "gauge" | "counter", help: string, samples: Sample[]): string {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`];
  for (const [labels, value] of samples) {
    const l = Object.entries(labels).map(([k, v]) => `${k}="${esc(v)}"`).join(",");
    lines.push(`${name}${l ? `{${l}}` : ""} ${Number.isFinite(value) ? value : 0}`);
  }
  return lines.join("\n");
}

export function metricsText(): string {
  const devices = db.prepare(`SELECT ttl_s, ${AGE("last_seen")} AS age_s FROM devices`).all() as { ttl_s: number | null; age_s: number | null }[];
  const byStatus: Record<string, number> = { online: 0, stale: 0, offline: 0 };
  for (const d of devices) if (!isExpired(d, d.age_s)) byStatus[deviceStatus(d.age_s)]++;

  const jobs = db.prepare("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status").all() as { status: string; n: number }[];
  const jobCounts: Record<string, number> = { waiting: 0, queued: 0, claimed: 0, done: 0, failed: 0, cancelled: 0 };
  for (const j of jobs) jobCounts[j.status] = j.n;

  const oldest = db.prepare(`SELECT MAX(${AGE("created_at")}) AS s FROM jobs WHERE status = 'queued'`).get() as { s: number | null };
  const finished = db
    .prepare("SELECT workload, status, COUNT(*) AS n FROM jobs WHERE finished_at >= datetime('now', '-1 day') GROUP BY workload, status")
    .all() as { workload: string; status: string; n: number }[];
  const executors = db.prepare(`SELECT COUNT(*) AS n FROM executors WHERE ${AGE("last_seen")} <= 120`).get() as { n: number };
  const success = db
    .prepare(
      `SELECT claimed_by AS device, SUM(status = 'done') AS ok, COUNT(*) AS n FROM jobs
       WHERE finished_at >= datetime('now', '-1 day') AND claimed_by IS NOT NULL AND status IN ('done','failed')
       GROUP BY claimed_by`,
    )
    .all() as { device: string; ok: number; n: number }[];
  const alerts = db.prepare("SELECT severity, COUNT(*) AS n FROM alerts WHERE state = 'open' GROUP BY severity").all() as { severity: string; n: number }[];
  const artifacts = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM artifacts").get() as { n: number; bytes: number };

  return [
    family("fleet_build_info", "gauge", "The collector's version.", [[{ version: APP_VERSION }, 1]]),
    family("fleet_devices", "gauge", "Devices on the shelf by status (expired ephemeral agents excluded).", Object.entries(byStatus).map(([status, n]) => [{ status }, n])),
    family("fleet_jobs", "gauge", "Jobs in the table by status.", Object.entries(jobCounts).map(([status, n]) => [{ status }, n])),
    family("fleet_queue_oldest_seconds", "gauge", "Age of the oldest queued job; 0 when nothing is queued.", [[{}, oldest.s ?? 0]]),
    family("fleet_jobs_finished_24h", "gauge", "Jobs that finished in the last 24 hours, by workload and status.", finished.map((f) => [{ workload: f.workload, status: f.status }, f.n])),
    family("fleet_executors_live", "gauge", "Host executors that polled in the last two minutes.", [[{}, executors.n]]),
    family("fleet_device_success_ratio_24h", "gauge", "done / (done + failed) per device over the last 24 hours.", success.map((s) => [{ device_id: s.device }, s.n ? s.ok / s.n : 0])),
    family("fleet_alerts_open", "gauge", "Open alerts by severity.", alerts.map((a) => [{ severity: a.severity }, a.n])),
    family("fleet_artifacts", "gauge", "Artifacts recorded.", [[{}, artifacts.n]]),
    family("fleet_artifact_bytes", "gauge", "Total size of recorded artifacts.", [[{}, artifacts.bytes]]),
  ].join("\n\n") + "\n";
}

export function registerMetrics(app: FastifyInstance): void {
  app.get("/metrics", async (_req, reply) => reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8").send(metricsText()));
}
