/**
 * Following a build log while the build runs.
 *
 * A twenty-minute Xcode build posts nothing between "claimed" and "finished",
 * and a lease that is not renewed in that window is swept out from under a
 * compile that was going fine. So the build's stdout goes to a file and this
 * tails it: every read gives back the whole lines that appeared since the last
 * one, which is what the workload turns into a beacon and a log line.
 *
 * The splitting is separated from the reading on purpose. A tail read lands
 * mid-line roughly always — 8 KB of `xcodebuild` output does not end on a
 * newline — and a partial line emitted as if it were whole is how a log tail
 * turns "error: no such module 'Foo'" into "error: no such modu". The
 * remainder is carried instead, and only flushed when the file is closed.
 */
import { open, type FileHandle } from "node:fs/promises";

/** How much of a log line reaches a beacon or an error field. */
export const MAX_LINE_CHARS = 300;

/**
 * Splits a freshly read chunk into whole lines, carrying the partial tail.
 *
 * `rest` is whatever followed the last newline; it is prepended to the next
 * chunk. A chunk with no newline at all yields no lines and a longer rest,
 * which is the correct answer for a compiler that is halfway through printing
 * a diagnostic.
 */
export function splitLines(rest: string, chunk: string): { lines: string[]; rest: string } {
  const text = rest + chunk;
  const parts = text.split(/\r?\n/);
  // split always yields one more element than there were newlines, and that
  // last element is the partial line (empty when the chunk ended cleanly).
  const tail = parts.pop() ?? "";
  return { lines: parts, rest: tail };
}

/**
 * The line worth showing out of a batch.
 *
 * Build tools print progress noise between the lines that mean something, and
 * the last line of a batch is often blank or a bare separator. Blank lines and
 * pure punctuation are skipped from the end; an all-noise batch answers null,
 * which the caller reports as "still building" rather than as an empty string
 * that looks like the build said something.
 */
export function lastMeaningfulLine(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = (lines[i] ?? "").trim();
    if (s === "") continue;
    if (/^[-=*_.\s]+$/.test(s)) continue;
    return s.length > MAX_LINE_CHARS ? `${s.slice(0, MAX_LINE_CHARS - 1)}…` : s;
  }
  return null;
}

/**
 * The first line that names what actually broke.
 *
 * This is what goes in the failing result row's `error`, and the whole point of
 * Task 1's "a build that fails must not look like a build that did not run":
 * `exit 1` is indistinguishable from a crashed agent, while
 * "> Task :app:compileDebugKotlin FAILED" says which target.
 *
 * The patterns are ordered by how specific they are, not by where they appear
 * in the log — Gradle's `FAILED` task line is above its generic `error:` lines
 * because the task name is the answer somebody wants and the `error:` under it
 * is the detail.
 */
export function failureLine(log: string): string | null {
  const lines = log.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  // npm, yarn and pnpm echo the script they are about to run behind a `> `,
  // so a build script that merely MENTIONS the word error — and a compiler
  // invocation naming an -Werror flag does — has its own command line matched
  // as if it were a diagnostic. Gradle's `> Task :x FAILED` is the one `> `
  // line that is a finding rather than an echo, and it is matched separately.
  const notEcho = lines.filter((l) => !/^>\s/.test(l) || /^>\s*Task\b/.test(l));
  const patterns: [RegExp, string[]][] = [
    [/^>\s*Task\s+\S+\s+FAILED$/, lines],              // gradle: the failing task, named
    [/^\*\*\s*(BUILD FAILED|ARCHIVE FAILED)/i, lines], // xcodebuild's banner
    [/^The following build commands failed:/i, lines], // xcodebuild's list header
    [/^FAILURE:\s/, lines],                            // gradle's summary header
    [/(^|\s)error:\s/i, notEcho],                      // clang/swiftc/kotlinc diagnostics
    [/^npm ERR!/, notEcho],                            // npm
  ];
  for (const [re, haystack] of patterns) {
    const hit = haystack.find((l) => re.test(l));
    if (hit) return hit.length > MAX_LINE_CHARS ? `${hit.slice(0, MAX_LINE_CHARS - 1)}…` : hit;
  }
  return null;
}

/**
 * An incremental reader over a file something else is still appending to.
 *
 * Holds a byte offset rather than re-reading the file, so a log that grows to
 * a couple of hundred megabytes — a verbose Gradle build does — costs the same
 * per tick as a quiet one.
 */
export class LogTail {
  private fh: FileHandle | null = null;
  private offset = 0;
  private rest = "";

  constructor(private readonly file: string) {}

  /**
   * Whole lines appended since the last call. Never throws: a log file that has
   * not been created yet, or that was removed, reads as "nothing new" — the
   * tail exists to keep a lease alive, and it must not be the thing that fails
   * a build that is compiling perfectly well.
   */
  async read(): Promise<string[]> {
    try {
      if (this.fh === null) this.fh = await open(this.file, "r");
      const out: string[] = [];
      for (;;) {
        const buf = Buffer.allocUnsafe(64 * 1024);
        const { bytesRead } = await this.fh.read(buf, 0, buf.length, this.offset);
        if (bytesRead === 0) break;
        this.offset += bytesRead;
        const split = splitLines(this.rest, buf.subarray(0, bytesRead).toString("utf8"));
        this.rest = split.rest;
        out.push(...split.lines);
      }
      return out;
    } catch {
      return [];
    }
  }

  /** Closes the handle and flushes a trailing line that never got its newline. */
  async close(): Promise<string[]> {
    const tail = await this.read();
    if (this.rest.trim() !== "") {
      tail.push(this.rest);
      this.rest = "";
    }
    try {
      await this.fh?.close();
    } catch {
      /* already gone */
    }
    this.fh = null;
    return tail;
  }
}
