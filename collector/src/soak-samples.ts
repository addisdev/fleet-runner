/**
 * Parsing what a phone says about an app that is still running: `dumpsys
 * meminfo`, `dumpsys gfxinfo`, `logcat -b crash`, and the simulator's unified
 * log.
 *
 * Its own module, and pure, for the same reason am-start.ts is: the executor is
 * a long-running process with a main() loop and cannot be imported, so anything
 * only reachable from inside it is only ever tested by plugging in a phone.
 * These four functions decide every number an app-soak run stores, so they are
 * the pieces that have to be checkable without hardware.
 *
 * The rule they are all written around is the one the workload exists for: an
 * app-soak that samples nothing must not look like an app-soak that found
 * nothing wrong. Every parser here returns `problem` rather than a zero when it
 * has no measurement, because 0 MB, 0% jank and 0 crashes are all perfectly
 * plausible-looking values for "the tool printed a warning and I did not read
 * it".
 *
 * Three shapes cost real measurements if they are missed, and every function
 * below is tested against all three:
 *
 * 1. adb's shell transport converts LF to CRLF, so every line arrives with a
 *    trailing \r and any end-anchored pattern silently stops matching.
 * 2. The tool prints a complaint instead of data -- `No process found for:
 *    com.x` is what dumpsys says about an app that has just died, and it is
 *    exactly the moment a soak most needs to notice.
 * 3. The tool prints data that contains no measurement -- gfxinfo after a reset
 *    on a backgrounded app reports 0 frames rendered, and 0 janky frames out of
 *    0 is not 0% jank, it is no reading.
 */

/** Strip adb's CRLF once, at the door, so nothing below has to think about it. */
const lines = (out: string): string[] => out.replace(/\r/g, "").split("\n");

// ---------------------------------------------------------------------------
// dumpsys meminfo <pkg>  ->  PSS
// ---------------------------------------------------------------------------

export type MeminfoSample = {
  /** Total PSS in kilobytes, as dumpsys reports it. Null when there is none. */
  pssKb: number | null;
  /** The pid dumpsys found for the package, when it named one. */
  pid: number | null;
  /** Why there is no measurement here, or null when pssKb is usable. */
  problem: string | null;
};

/**
 * Total PSS for one package.
 *
 * dumpsys prints the number twice in different layouts depending on the
 * platform version, and this reads the App Summary form first because it is the
 * one that survived: Android 5 through 15 all print
 *
 *     TOTAL:    93052                        129892       TOTAL SWAP PSS:     1528
 *
 * under `App Summary`, while the older column table prints
 *
 *              TOTAL    93052    91392      132     1528   129892 ...
 *
 * with the same first number. The trap in both is the SWAP total on the same
 * line: a pattern looking anywhere in the line for "TOTAL" followed by digits
 * has two candidates and picks by luck. Anchoring to the line start and
 * refusing to let " SWAP" satisfy the optional " PSS" is what keeps the swap
 * figure -- typically a hundredth of the real one -- out of the memory column.
 */
export function parseMeminfo(out: string): MeminfoSample {
  const ls = lines(out);
  const text = ls.join("\n");

  // `** MEMINFO in pid 4242 [com.example.app] **`
  const pid = /^\*\* MEMINFO in pid (\d+)/m.exec(text);

  // The complaint dumpsys makes about an app that is not running. This is not
  // an error condition for a soak -- it is the measurement -- so it is named
  // rather than swallowed.
  if (/^No process found for:/m.test(text)) {
    return { pssKb: null, pid: null, problem: "no process found (the app is not running)" };
  }

  // `TOTAL:` / `TOTAL PSS:` / bare `TOTAL` at the start of a line, then the PSS
  // column. " SWAP" cannot satisfy the optional " PSS", so `TOTAL SWAP PSS:`
  // never matches here.
  const total = /^\s*TOTAL(?: PSS)?:?\s+(\d+)\b/m.exec(text);
  if (!total) {
    return {
      pssKb: null,
      pid: pid ? Number(pid[1]) : null,
      problem: text.trim() === ""
        ? "dumpsys meminfo printed nothing"
        : `dumpsys meminfo printed no PSS total (${text.trim().split("\n")[0].slice(0, 120)})`,
    };
  }
  return { pssKb: Number(total[1]), pid: pid ? Number(pid[1]) : null, problem: null };
}

// ---------------------------------------------------------------------------
// dumpsys gfxinfo <pkg>  ->  janky frame percentage
// ---------------------------------------------------------------------------

export type GfxinfoSample = {
  /** Frames the app rendered in the window. */
  totalFrames: number | null;
  /** Of those, how many missed their deadline. */
  jankyFrames: number | null;
  /** jankyFrames as a percentage of totalFrames, computed here rather than read. */
  jankPct: number | null;
  problem: string | null;
};

/**
 * Janky frames for one package, over whatever window the last `gfxinfo <pkg>
 * reset` opened.
 *
 * Two details, both of which produce a wrong number rather than no number.
 *
 * The percentage is COMPUTED from the two counts, not read out of the
 * parentheses dumpsys prints. dumpsys rounds that figure to two decimals and,
 * on some builds, formats it in the device's locale -- `5,00%` on a phone set
 * to German -- which parseFloat reads as 5 on one device and 5.0 on another
 * only by accident.
 *
 * And `Janky frames:` is anchored so that Android 12's second line,
 * `Janky frames (legacy): 60 (4.00%)`, cannot be read as the first. The legacy
 * figure uses the old deadline and runs materially lower; a parser that took
 * whichever line it saw last would report a different metric on Android 12 than
 * on Android 11 under the same field name.
 */
export function parseGfxinfo(out: string): GfxinfoSample {
  const text = lines(out).join("\n");

  if (/^No process found for:/m.test(text)) {
    return { totalFrames: null, jankyFrames: null, jankPct: null, problem: "no process found (the app is not running)" };
  }

  const total = /^\s*Total frames rendered:\s*(\d+)\s*$/m.exec(text);
  const janky = /^\s*Janky frames:\s*(\d+)\b/m.exec(text);
  if (!total || !janky) {
    return {
      totalFrames: total ? Number(total[1]) : null,
      jankyFrames: janky ? Number(janky[1]) : null,
      jankPct: null,
      problem: text.trim() === ""
        ? "dumpsys gfxinfo printed nothing"
        : "dumpsys gfxinfo printed no frame counts (the app may not have a hardware-accelerated window)",
    };
  }

  const totalFrames = Number(total[1]);
  const jankyFrames = Number(janky[1]);
  if (totalFrames === 0) {
    // A backgrounded app draws nothing, and 0 of 0 is not 0% jank. Reporting a
    // zero here is how a soak whose app sat behind the launcher all night
    // produces the best jank figure the fleet has ever recorded.
    return { totalFrames, jankyFrames, jankPct: null, problem: "no frames rendered in this window (the app drew nothing)" };
  }
  return { totalFrames, jankyFrames, jankPct: (jankyFrames / totalFrames) * 100, problem: null };
}

// ---------------------------------------------------------------------------
// logcat -b crash -d  ->  crashes belonging to one package
// ---------------------------------------------------------------------------

export type CrashSample = {
  count: number;
  /** One short line per crash, for the result row and the report. */
  signatures: string[];
  /** Set when the buffer could not be read at all -- NOT when it was empty. */
  problem: string | null;
};

/**
 * Crashes for one package in the crash buffer.
 *
 * Both kinds count, because both kill the app and only one of them is a Java
 * exception:
 *
 *   managed -- `E AndroidRuntime: Process: com.x, PID: 4242` under a
 *              FATAL EXCEPTION banner.
 *   native  -- a tombstone, `F DEBUG : pid: 4242, ... >>> com.x <<<`, followed
 *              by the signal line.
 *
 * The package filter is the point of taking a package argument at all. The
 * crash buffer is device-wide: a soak on com.x that counted every crash in it
 * would attribute the launcher's overnight restart to the app under test, and
 * an app-soak's crash count is the number somebody ships or does not ship on.
 *
 * An EMPTY buffer is not a problem -- it is the good case -- so `problem` stays
 * null for it. It is set only when logcat itself failed, because "0 crashes"
 * and "I could not look" must never render as the same result.
 */
export function parseCrashLogcat(out: string, pkg: string): CrashSample {
  const ls = lines(out);
  const text = ls.join("\n");

  // logcat's own failures. `-b crash` on a device whose buffer is off answers
  // "Unable to open log device", and a dead adb connection answers "error:".
  const failure = /^(?:error:|logcat: |Unable to open log device)/m.exec(text);
  if (failure) {
    return { count: 0, signatures: [], problem: `logcat could not be read: ${text.trim().split("\n")[0].slice(0, 140)}` };
  }

  const esc = pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const signatures: string[] = [];

  // Managed crashes. The Process: line is what names the package, and the
  // exception line that follows it is what a person actually wants to read.
  for (const [i, l] of ls.entries()) {
    if (!new RegExp(`Process:\\s*${esc},\\s*PID:\\s*\\d+`).test(l)) continue;
    let sig = "FATAL EXCEPTION";
    for (const next of ls.slice(i + 1, i + 6)) {
      const m = /AndroidRuntime:\s+((?:[\w$.]+\.)?\w*(?:Exception|Error)\b.*)$/.exec(next);
      if (m) { sig = m[1].trim().slice(0, 160); break; }
    }
    signatures.push(sig);
  }

  // Native crashes. `>>> com.x <<<` is how a tombstone names the process, and
  // the signal line is the signature worth keeping.
  for (const [i, l] of ls.entries()) {
    if (!new RegExp(`>>>\\s*${esc}\\s*<<<`).test(l)) continue;
    let sig = "native crash";
    for (const next of ls.slice(i, i + 8)) {
      const m = /(signal\s+\d+\s*\([A-Z]+\)[^\n]*)/.exec(next);
      if (m) { sig = m[1].trim().slice(0, 160); break; }
    }
    signatures.push(sig);
  }

  return { count: signatures.length, signatures, problem: null };
}

// ---------------------------------------------------------------------------
// simctl spawn <udid> log show  ->  crashes on an iOS simulator
// ---------------------------------------------------------------------------

/**
 * Crashes for one app in a simulator's unified log.
 *
 * `bundleOrName` is matched loosely on purpose: ReportCrash names the
 * EXECUTABLE ("Aliquant"), SpringBoard names the BUNDLE ID
 * ("UIKitApplication:com.taylab.aliquant[0x1234]"), and a caller generally has
 * only one of the two. Passing either finds the crash.
 *
 * Same rule as the logcat parser: an empty log is zero crashes, but a `log
 * show` that failed is a `problem`. That distinction matters more here than on
 * Android, because `log show` fails for entirely ordinary reasons -- an
 * unbooted simulator, a malformed predicate -- and prints its complaint on
 * stdout with a zero exit status, so nothing upstream notices.
 */
export function parseSimCrashLog(out: string, bundleOrName: string): CrashSample {
  const ls = lines(out);
  const text = ls.join("\n");

  if (/^log:\s|Invalid predicate|error: unable to |Failed to (?:open|access)/m.test(text)) {
    return { count: 0, signatures: [], problem: `log show could not be read: ${text.trim().split("\n")[0].slice(0, 140)}` };
  }

  const needle = bundleOrName.toLowerCase();
  // The executable name out of a bundle id, so "com.taylab.aliquant" also
  // matches ReportCrash's "aliquant".
  const leaf = needle.split(".").pop() ?? needle;
  const signatures: string[] = [];

  for (const l of ls) {
    const low = l.toLowerCase();
    // ReportCrash: "Saved crash report for Aliquant[4242] version 1.0 (1) to ..."
    const saved = /Saved crash report for ([^[]+)\[(\d+)\]/.exec(l);
    if (saved && (low.includes(needle) || saved[1].trim().toLowerCase() === leaf)) {
      signatures.push(`crash report saved for ${saved[1].trim()}[${saved[2]}]`);
      continue;
    }
    // SpringBoard / launchd: "Application 'UIKitApplication:com.x[...]' crashed."
    // and "Service exited due to SIGSEGV".
    if (low.includes(needle) || low.includes(`:${leaf}[`)) {
      const m = /(crashed\.?|exited due to (?:signal )?SIG[A-Z]+|exited abnormally[^\n]*)/i.exec(l);
      if (m) signatures.push(m[1].trim().slice(0, 160));
    }
  }

  return { count: signatures.length, signatures, problem: null };
}
