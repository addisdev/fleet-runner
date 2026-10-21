#!/usr/bin/python3
"""Carry a LAN address to a brain that listens on loopback only.

    lan-forward.py LISTEN_HOST:PORT TARGET_HOST:PORT

Why this exists: on ultra (macOS 27, application firewall on, stealth mode) a
Homebrew `node` accepts connections on loopback and times out on the LAN, even
though `socketfilterfw --getappblocked` says incoming connections to its path
are permitted (measured 2026-10-21). The entry probably holds an older build's
ad-hoc signature; whatever the cause, fixing it needs an administrator, and
every `brew upgrade` could undo it. `/usr/bin/python3` is a platform binary the
firewall lets through, so the brain binds 127.0.0.1 and this process, under
launchd, is the only thing on the LAN address. The Homelab Map's page server on ultra runs on /usr/bin/python3
for the same reason.

It is a byte pipe, nothing more: no HTTP parsing, so long-polls, uploads of
any size and streamed downloads pass through untouched. Each direction is
copied until its reader sees EOF, then the other side's write half is closed,
so a client that half-closes after sending a body still gets its response.

Standard library only, so it runs on the interpreter macOS ships.
"""
import asyncio
import signal
import sys

CHUNK = 256 * 1024
# A connection idle in both directions this long is dropped. Device long-polls
# are far shorter (the collector answers within a minute), so this only reaps
# peers that vanished without a FIN.
IDLE_SECONDS = 15 * 60


def parse(spec):
    host, _, port = spec.rpartition(":")
    if not host or not port.isdigit():
        raise SystemExit(f"lan-forward: expected HOST:PORT, got {spec!r}")
    return host, int(port)


async def pipe(reader, writer, activity):
    try:
        while True:
            data = await reader.read(CHUNK)
            if not data:
                break
            activity[0] = asyncio.get_running_loop().time()
            writer.write(data)
            await writer.drain()
    except (ConnectionError, OSError):
        pass
    finally:
        try:
            if writer.can_write_eof():
                writer.write_eof()
        except (ConnectionError, OSError, RuntimeError):
            pass


async def handle(client_reader, client_writer, target):
    peer = client_writer.get_extra_info("peername")
    try:
        up_reader, up_writer = await asyncio.wait_for(asyncio.open_connection(*target), 10)
    except (OSError, asyncio.TimeoutError) as e:
        print(f"lan-forward: {peer} -> {target[0]}:{target[1]} refused: {e}", file=sys.stderr, flush=True)
        client_writer.close()
        return
    loop = asyncio.get_running_loop()
    activity = [loop.time()]
    a = asyncio.ensure_future(pipe(client_reader, up_writer, activity))
    b = asyncio.ensure_future(pipe(up_reader, client_writer, activity))
    try:
        while not (a.done() and b.done()):
            await asyncio.wait({a, b} - {t for t in (a, b) if t.done()}, timeout=30)
            if loop.time() - activity[0] > IDLE_SECONDS:
                break
    finally:
        for t in (a, b):
            t.cancel()
        for w in (client_writer, up_writer):
            try:
                w.close()
            except Exception:
                pass


async def main():
    if len(sys.argv) != 3:
        raise SystemExit(__doc__.strip().splitlines()[2].strip())
    listen, target = parse(sys.argv[1]), parse(sys.argv[2])
    server = await asyncio.start_server(lambda r, w: handle(r, w, target), *listen, reuse_address=True)
    print(f"lan-forward: {listen[0]}:{listen[1]} -> {target[0]}:{target[1]}", file=sys.stderr, flush=True)
    stop = asyncio.get_running_loop().create_future()
    for sig in (signal.SIGTERM, signal.SIGINT):
        asyncio.get_running_loop().add_signal_handler(sig, lambda: stop.done() or stop.set_result(None))
    async with server:
        await stop


if __name__ == "__main__":
    asyncio.run(main())
