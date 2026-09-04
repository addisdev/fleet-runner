/**
 * Log tailing. The failure this guards against is subtle and silent: a tail
 * read lands mid-line almost always, and a partial line reported as if it were
 * whole turns "error: no such module 'Foo'" into "error: no such modu" in the
 * one place somebody goes looking when a nightly is red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { splitLines, lastMeaningfulLine, failureLine, LogTail, MAX_LINE_CHARS } from "../src/logtail.js";

test("a chunk ending on a newline leaves no remainder", () => {
  assert.deepEqual(splitLines("", "a\nb\n"), { lines: ["a", "b"], rest: "" });
});

test("a chunk ending mid-line carries the partial forward", () => {
  const first = splitLines("", "compiling Foo.swift\nerror: no such mod");
  assert.deepEqual(first.lines, ["compiling Foo.swift"]);
  assert.equal(first.rest, "error: no such mod");
  // The next read completes it, and only then is it a line.
  const second = splitLines(first.rest, "ule 'Bar'\n");
  assert.deepEqual(second.lines, ["error: no such module 'Bar'"]);
  assert.equal(second.rest, "");
});

test("a chunk with no newline at all yields nothing and grows the remainder", () => {
  const r = splitLines("abc", "def");
  assert.deepEqual(r.lines, []);
  assert.equal(r.rest, "abcdef");
});

test("CRLF logs split on the line, not on the carriage return", () => {
  assert.deepEqual(splitLines("", "a\r\nb\r\n"), { lines: ["a", "b"], rest: "" });
});

test("the meaningful line skips blanks and rules from the end", () => {
  assert.equal(lastMeaningfulLine(["> Task :app:compileDebugKotlin", "", "   ", "-----"]),
    "> Task :app:compileDebugKotlin");
  assert.equal(lastMeaningfulLine([]), null);
  assert.equal(lastMeaningfulLine(["", "  ", "===="]), null);
});

test("a very long line is truncated rather than sent whole to a beacon", () => {
  const line = lastMeaningfulLine(["x".repeat(1000)]);
  assert.ok(line !== null);
  assert.equal(line.length, MAX_LINE_CHARS);
  assert.ok(line.endsWith("…"));
});

test("the failing gradle task wins over the error under it", () => {
  const log = [
    "> Task :app:compileDebugKotlin",
    "e: /src/Foo.kt:3:1 error: unresolved reference: bar",
    "> Task :app:compileDebugKotlin FAILED",
    "FAILURE: Build failed with an exception.",
  ].join("\n");
  assert.equal(failureLine(log), "> Task :app:compileDebugKotlin FAILED");
});

test("xcodebuild's banner is found even though it is not the last line", () => {
  const log = ["Compiling Foo.swift", "** BUILD FAILED **", "", "The following build commands failed:"].join("\n");
  assert.equal(failureLine(log), "** BUILD FAILED **");
});

test("a clang diagnostic is the answer when nothing more specific exists", () => {
  assert.equal(failureLine("cc foo.c\nfoo.c:2:5: error: expected ';'\n"), "foo.c:2:5: error: expected ';'");
});

test("npm's own prefix is recognised", () => {
  assert.equal(failureLine("npm ERR! missing script: build\n"), "npm ERR! missing script: build");
});

test("npm's echo of the script it ran is not a diagnostic", () => {
  // Caught against a real collector: npm prints the command behind `> `, so a
  // build script whose text merely contains the word "error" had its own
  // command line reported as the failure and the actual diagnostic below it
  // was never reached.
  const log = [
    "> tiny@1.0.0 build",
    "> node -e \"console.error('src/index.js:2:5: error: expected ;')\"",
    "",
    "src/index.js:2:5: error: expected ';'",
  ].join("\n");
  assert.equal(failureLine(log), "src/index.js:2:5: error: expected ';'");
});

test("gradle's FAILED task is still found despite living behind the same `> `", () => {
  const log = ["> Task :app:assemble", "> Task :app:assemble FAILED"].join("\n");
  assert.equal(failureLine(log), "> Task :app:assemble FAILED");
});

test("a log that named nothing answers null rather than a plausible line", () => {
  // The caller falls back to "<target> failed", which is honest. Returning the
  // last line here would put "Done." in the error field of a failed build.
  assert.equal(failureLine("Compiling...\nLinking...\nDone.\n"), null);
});

test("LogTail returns only what was appended since the last read", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "frm-tail-"));
  const file = path.join(dir, "build.log");
  await writeFile(file, "one\ntwo\n");
  const tail = new LogTail(file);
  assert.deepEqual(await tail.read(), ["one", "two"]);
  assert.deepEqual(await tail.read(), []);
  await appendFile(file, "three\n");
  assert.deepEqual(await tail.read(), ["three"]);
  assert.deepEqual(await tail.close(), []);
});

test("LogTail flushes a trailing line that never got its newline, on close", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "frm-tail-"));
  const file = path.join(dir, "build.log");
  await writeFile(file, "done\nBUILD FAILED");
  const tail = new LogTail(file);
  assert.deepEqual(await tail.read(), ["done"]);
  assert.deepEqual(await tail.close(), ["BUILD FAILED"]);
});

test("a log file that does not exist reads as nothing new, never as an error", async () => {
  // The tail exists to keep a lease alive. It must never be the thing that
  // fails a build that is compiling perfectly well.
  const dir = await mkdtemp(path.join(tmpdir(), "frm-tail-"));
  const tail = new LogTail(path.join(dir, "never-created.log"));
  assert.deepEqual(await tail.read(), []);
  assert.deepEqual(await tail.close(), []);
});
