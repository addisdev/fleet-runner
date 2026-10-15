/**
 * The generated parts of skills/fleet-runner/SKILL.md.
 *
 * The skill is prose a person edits, except for the tables an agent acts on:
 * which tool is which command, and what each exit code means. Those come from
 * the tool table and EXIT, so a renamed tool or a new exit code cannot leave
 * the skill telling agents something the binary no longer does. A test fails
 * when the file and this disagree; `npm run skill:gen` rewrites it.
 */
import { TOOLS } from "./mcp/tools.js";
import { EXIT } from "./work.js";

const EXIT_MEANING: Record<keyof typeof EXIT, string> = {
  passed: "passed: every device ran it and passed",
  failed: "failed, mixed or cancelled: read `failing_step` and `error` before doing anything else",
  usage: "usage error or invalid spec: fix the flags or the spec; `--validate` names each problem",
  pending: "still running when `--timeout` ran out: `fleetr wait ID` picks it up again",
  skipped: "skipped: nothing ran (no build for the device, no matching device). Never report this as a pass",
  error: "refused or unreachable: no permission, unknown workload or job, or no collector. Report it; do not work around it",
};

function block(name: string): string {
  if (name === "tools") {
    const rows = TOOLS.map((t) => `| \`${t.name}\` | \`${t.cli}\` | ${t.needs} | ${t.annotations.readOnlyHint ? "no" : t.annotations.destructiveHint ? "yes, destructive" : "yes"} |`);
    return ["| MCP tool | Command | Scope | Changes anything |", "|---|---|---|---|", ...rows].join("\n");
  }
  if (name === "exits") {
    return (Object.keys(EXIT) as (keyof typeof EXIT)[]).map((k) => `- **${EXIT[k]}** ${EXIT_MEANING[k]}.`).join("\n");
  }
  throw new Error(`unknown generated block ${name}`);
}

/** The skill with every generated block rewritten. */
export function renderSkill(text: string): string {
  const seen = new Set<string>();
  const out = text.replace(/(<!-- generated:([\w-]+) -->\n)[\s\S]*?(\n<!-- \/generated:\2 -->)/g, (_, open, name, close) => {
    seen.add(name);
    return `${open}${block(name)}${close}`;
  });
  for (const name of ["tools", "exits"]) if (!seen.has(name)) throw new Error(`SKILL.md has no generated:${name} block (or it is not LF-terminated)`);
  return out;
}
