// Watching a device while a host job drives it.
//
// The UI-test artifact viewer answers "what did it look like when it failed".
// This answers "what is it doing right now", which is a different question and
// the one you actually have while a flow is running. Reading a JUnit file to
// work out where a Maestro flow got stuck is slower than watching it get stuck.
//
// Three decisions shape the whole module.
//
// **Nothing is persisted.** Frames live in a bounded in-memory ring per job and
// are dropped when the job ends. The collector runs on a 2016 MacBook whose
// database already carries every measurement the fleet has ever taken; adding a
// video stream to it would trade a permanent cost for a transient benefit. If a
// run is worth keeping, the executor already uploads a recording as an artifact
// on failure — that is the durable path, and this is not it.
//
// **The producer pushes, the browser pulls.** The executor POSTs JPEG frames as
// it captures them; browsers read an MJPEG stream. MJPEG rather than SSE or a
// WebSocket because an `<img>` tag renders it with no client code at all, it
// degrades to a still frame rather than an error when the producer stalls, and
// the dashboard is a single-operator tool where a dependency-free path is worth
// more than efficiency.
//
// **A viewer must never slow a run down.** Every write to a viewer socket is
// best-effort and a broken pipe only drops that viewer. A closed browser tab
// must not be able to make a device test fail, so nothing here propagates an
// error back to the producer.
import type { FastifyInstance, FastifyReply } from "fastify";
import { requireToken } from "./guard.js";

// One frame at a time is all a viewer can see; a couple more absorb the jitter
// between a producer's capture loop and a viewer's render. Beyond that a slow
// viewer would only ever be shown stale frames, so the ring stays tiny and the
// newest frame always wins.
const RING = 3;
// A producer that stops sending has finished, crashed, or lost its device.
// After this, viewers are closed rather than left watching a frozen image that
// looks like a hung app rather than a hung stream.
const PRODUCER_IDLE_MS = 15_000;
// A cap so a runaway producer cannot exhaust memory: roughly a large phone
// screenshot. Anything bigger is refused rather than truncated, because half a
// JPEG renders as a corrupt image and reads as a broken device.
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const BOUNDARY = "fleetframe";

type Stream = {
  frames: Buffer[];
  lastAt: number;
  viewers: Set<FastifyReply>;
  timer?: NodeJS.Timeout;
};

const streams = new Map<string, Stream>();

function get(jobId: string): Stream {
  let s = streams.get(jobId);
  if (!s) {
    s = { frames: [], lastAt: Date.now(), viewers: new Set() };
    streams.set(jobId, s);
  }
  return s;
}

function writeFrame(reply: FastifyReply, frame: Buffer) {
  try {
    reply.raw.write(
      `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`,
    );
    reply.raw.write(frame);
    reply.raw.write("\r\n");
  } catch {
    // The viewer is gone. Its own close handler removes it; nothing propagates
    // to the producer, which is mid-test and must not care.
  }
}

/** Close a stream out: end every viewer and forget the job. */
function close(jobId: string) {
  const s = streams.get(jobId);
  if (!s) return;
  if (s.timer) clearInterval(s.timer);
  for (const v of s.viewers) {
    try {
      v.raw.end();
    } catch {
      /* already gone */
    }
  }
  streams.delete(jobId);
}

/** Called from the job-close path so a finished job stops streaming. */
export function endMirror(jobId: string) {
  close(jobId);
}

export function registerMirror(app: FastifyInstance) {
  // The producer. Raw JPEG bytes, one frame per request: the executor is
  // shelling out to screencap or scrcpy and posting what comes back, and a
  // frame-per-request needs no framing protocol on either side.
  app.post("/api/jobs/:id/mirror", { bodyLimit: MAX_FRAME_BYTES }, async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const { id } = req.params as { id: string };
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0)
      return reply.code(400).send({ error: "expected raw JPEG bytes" });
    if (body.length > MAX_FRAME_BYTES)
      return reply.code(413).send({ error: `frame larger than ${MAX_FRAME_BYTES} bytes` });

    const s = get(id);
    s.frames.push(body);
    while (s.frames.length > RING) s.frames.shift();
    s.lastAt = Date.now();

    for (const v of s.viewers) writeFrame(v, body);

    // Started on first frame rather than on stream creation, so a job that
    // never produces one costs nothing.
    if (!s.timer) {
      s.timer = setInterval(() => {
        const cur = streams.get(id);
        if (cur && Date.now() - cur.lastAt > PRODUCER_IDLE_MS) close(id);
      }, 5_000);
      s.timer.unref();
    }
    return reply.code(204).send();
  });

  // The viewer. An <img src> renders this directly.
  app.get("/api/jobs/:id/mirror", async (req, reply) => {
    const { id } = req.params as { id: string };
    const s = streams.get(id);
    // 404 rather than an empty stream: the dashboard uses this to decide
    // whether to show the panel at all, and an <img> that never paints is
    // indistinguishable from a device with a black screen.
    if (!s) return reply.code(404).send({ error: "nothing streaming for this job" });

    reply.raw.writeHead(200, {
      "content-type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      "cache-control": "no-store",
      connection: "close",
      // The frames are already stale by the time they arrive; a proxy holding
      // them makes the picture wrong rather than merely late.
      pragma: "no-cache",
    });

    s.viewers.add(reply);
    // Whatever the producer sent most recently, so a viewer joining mid-run
    // paints immediately instead of waiting for the next capture.
    const latest = s.frames[s.frames.length - 1];
    if (latest) writeFrame(reply, latest);

    const remove = () => s.viewers.delete(reply);
    req.raw.on("close", remove);
    req.raw.on("error", remove);
    return reply;
  });

  // Whether a panel is worth showing, without opening a stream to find out.
  app.get("/api/jobs/:id/mirror/status", async (req) => {
    const { id } = req.params as { id: string };
    const s = streams.get(id);
    return {
      streaming: !!s,
      viewers: s?.viewers.size ?? 0,
      age_ms: s ? Date.now() - s.lastAt : null,
    };
  });
}
