/**
 * Who this brain is, across restarts.
 *
 * The collector already had an identity: `SERVER_INSTANCE`, a random string
 * regenerated every time the process starts. That is the right answer to "did
 * the collector restart?", which is what the SSE `hello` frame uses it for --
 * a client that sees it change refetches everything.
 *
 * It is the wrong answer to "which collector is this?", and that question now
 * has to be answerable, because a device can register with more than one. When
 * an agent tells brain B "I am busy for someone else", B has to be able to tell
 * whether that someone else is a brain it knows; when a dashboard shows two
 * fleets side by side, the two need names a person recognises. Neither works
 * with an id that changes every restart.
 *
 * So there are three identifiers and they answer three different questions:
 *
 * | | Stable across | Answers |
 * |---|---|---|
 * | `id` | forever, per data directory | which collector is this |
 * | `name` | until somebody renames it | what do I call it |
 * | `instance` | one process lifetime | did it restart |
 *
 * `instance` stays where it was, in api/stream.ts, because it belongs to the
 * stream that uses it. This module owns the two that outlive the process.
 *
 * The id is tied to the **data directory** rather than to the machine, because
 * the data directory is what a collector actually is. Copy it to a new machine
 * and it is the same brain with the same history; run a second collector on one
 * machine with its own directory and it is a different brain, which is exactly
 * what the test suite does.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";

export type Identity = {
  /** 16 hex characters. Never changes once written. */
  id: string;
  /** Editable. Defaults to the machine's hostname. */
  name: string;
  /** When the identity file was first written. */
  created_at: string;
};

const FILE = "collector.json";

/** A hostname a person would recognise, with the noise taken off. */
export function defaultName(host: string = hostname()): string {
  const clean = host
    .replace(/\.(local|lan|home|internal)$/i, "")
    .trim();
  return clean || "fleet";
}

/**
 * Read this data directory's identity, creating it on first run.
 *
 * Not cached: it is two syscalls on a file of eighty bytes, and caching it
 * would mean a rename from the dashboard did not take effect until a restart.
 */
export function identity(dataDir: string): Identity {
  const file = path.join(dataDir, FILE);
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Identity>;
      // An id is the one field that cannot be regenerated: doing so would make
      // this a different brain to every peer that has seen it. A file without
      // one is treated as absent rather than repaired in place, so the
      // rewrite below is the only path that ever writes an id.
      if (typeof parsed.id === "string" && /^[0-9a-f]{16}$/.test(parsed.id)) {
        return {
          id: parsed.id,
          name: typeof parsed.name === "string" && parsed.name ? parsed.name : defaultName(),
          created_at: typeof parsed.created_at === "string" ? parsed.created_at : new Date().toISOString(),
        };
      }
    } catch {
      // A truncated or hand-edited file is not a reason to refuse to start.
      // Falling through rewrites it, which loses a name and never an id --
      // because a file we could not read had no id we could trust anyway.
    }
  }
  const fresh: Identity = {
    id: randomBytes(8).toString("hex"),
    name: defaultName(),
    created_at: new Date().toISOString(),
  };
  write(dataDir, fresh);
  return fresh;
}

/** Rename this brain. The id is untouched, on purpose. */
export function rename(dataDir: string, name: string): Identity {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("a brain's name cannot be empty");
  if (trimmed.length > 64) throw new Error("a brain's name is at most 64 characters");
  const next = { ...identity(dataDir), name: trimmed };
  write(dataDir, next);
  return next;
}

/**
 * Write via a temporary file and a rename, so a crash mid-write cannot leave a
 * half-written identity -- which on the next start would be read as "no id",
 * and would silently fork this brain's identity in every peer that knew it.
 */
function write(dataDir: string, value: Identity): void {
  mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}
