/**
 * The skill tells agents which tool is which command and what each exit code
 * means; those tables are generated, and this is where they are kept honest.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderSkill } from "../src/skill.js";
import { WORK_COMMANDS } from "../src/work.js";
import { TOOLS } from "../src/mcp/tools.js";
import { FLEET } from "./helpers.js";

const file = path.join(FLEET, "../skills/fleet-runner/SKILL.md");
const text = readFileSync(file, "utf8");

test("SKILL.md's generated blocks match the code (npm run skill:gen)", () => {
  assert.equal(text, renderSkill(text));
});

test("every tool's command is one the CLI has", () => {
  for (const t of TOOLS) {
    const cmd = /^fleetr (\w+)/.exec(t.cli)?.[1];
    assert.ok(cmd && WORK_COMMANDS.has(cmd), `${t.name}: ${t.cli}`);
  }
});

test("the skill has frontmatter, the install marker, and stays short", () => {
  assert.match(text, /^---\nname: fleet-runner\ndescription: .{100,1024}\n---\n<!-- fleet-runner skill/);
  assert.ok(text.split("\n").length < 200, "a skill is read on every use; keep it short");
  assert.ok(!/(^|[^\w-])fleet (run|wait|job|devices) /m.test(text.replace(/`fleet` is the same program/, "")), "say fleetr, so the agent never reaches another tool's fleet");
});
