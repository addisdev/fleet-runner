// Rewrite the generated blocks of skills/fleet-runner/SKILL.md, or with
// --check, fail if they are out of date.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderSkill } from "../src/skill.js";

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../skills/fleet-runner/SKILL.md");
const text = readFileSync(file, "utf8");
const next = renderSkill(text);
if (process.argv.includes("--check")) {
  if (next !== text) {
    console.error(`${file} is out of date: run \`npm run skill:gen\` in fleet/`);
    process.exit(1);
  }
} else if (next !== text) {
  writeFileSync(file, next);
  console.log(`rewrote ${path.relative(process.cwd(), file)}`);
}
