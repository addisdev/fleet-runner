package com.taylab.fleetrunner

import com.taylab.fleetrunner.workload.Percentile
import com.taylab.fleetrunner.workload.RequestEvent
import com.taylab.fleetrunner.workload.RequestTimeline
import com.taylab.fleetrunner.workload.VantageEngine
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The vantage phase mapping, driven by a fake clock.
 *
 * "connect_ms quietly included the TLS handshake" produces entirely
 * reasonable-looking numbers on every device in the fleet at once, and nothing
 * about running the workload would reveal it — the only way to see it is to
 * write the timestamps down and check what comes out. So the mapping from
 * OkHttp's events to the five reported phases is pinned here, at the same
 * definitions the iOS runner takes from URLSessionTaskMetrics.
 */
class VantageTimingTest {

    private val t0 = 5_000_000_000L
    private fun ms(n: Long) = t0 + n * 1_000_000L

    /** A full HTTPS request over a fresh connection, in milliseconds after t0. */
    private fun freshHttps() = RequestTimeline().apply {
        mark(RequestEvent.CALL_START, ms(0))
        mark(RequestEvent.DNS_START, ms(2))
        mark(RequestEvent.DNS_END, ms(22)) //  20 ms dns
        mark(RequestEvent.CONNECT_START, ms(25))
        mark(RequestEvent.TLS_START, ms(65)) //  40 ms tcp
        mark(RequestEvent.TLS_END, ms(125)) //   60 ms tls
        mark(RequestEvent.CONNECT_END, ms(126))
        mark(RequestEvent.RESPONSE_START, ms(210)) // 210 ms ttfb
        mark(RequestEvent.CALL_END, ms(340)) //      340 ms load
    }

    // --- the five phases --------------------------------------------------

    @Test
    fun `each phase is the span between its own two events`() {
        val p = freshHttps().phases()
        assertEquals(20.0, p.dnsMs!!, 1e-6)
        assertEquals(60.0, p.tlsMs!!, 1e-6)
    }

    @Test
    fun `connect_ms is TCP only and stops where the handshake starts`() {
        // The whole reason this is tested. Apple's connectEnd sits AFTER the
        // handshake, so connectStart -> connectEnd would have Android report
        // TCP while iOS reports TCP + TLS under one column name, with the
        // handshake then counted twice on one platform and once on the other.
        val p = freshHttps().phases()
        assertEquals(40.0, p.connectMs!!, 1e-6)
        assertEquals("connect and tls do not overlap", 100.0, p.connectMs + p.tlsMs!!, 1e-6)
    }

    @Test
    fun `a plain http request ends its connect at connectEnd and reports no tls`() {
        val t = RequestTimeline().apply {
            mark(RequestEvent.CALL_START, ms(0))
            mark(RequestEvent.DNS_START, ms(1))
            mark(RequestEvent.DNS_END, ms(11))
            mark(RequestEvent.CONNECT_START, ms(12))
            mark(RequestEvent.CONNECT_END, ms(42))
            mark(RequestEvent.RESPONSE_START, ms(60))
            mark(RequestEvent.CALL_END, ms(70))
        }.phases()
        assertEquals(30.0, t.connectMs!!, 1e-6)
        assertNull("no handshake happened", t.tlsMs)
    }

    @Test
    fun `ttfb and load are measured from the start of the call`() {
        // Both are anchored at callStart, not at connectStart: what the caller
        // waited for includes the name lookup and the socket. Same anchor as
        // URLSessionTaskMetrics' fetchStart.
        val p = freshHttps().phases()
        assertEquals(210.0, p.ttfbMs!!, 1e-6)
        assertEquals(340L, p.loadMs!!)
    }

    @Test
    fun `load_ms covers the body, not just the headers`() {
        val p = freshHttps().phases()
        assertTrue("the body took time after the first byte", p.loadMs!! > p.ttfbMs!!)
    }

    // --- absent phases ----------------------------------------------------

    @Test
    fun `a reused connection reports no dns, connect or tls at all`() {
        // Not zero. A pooled connection resolved no name and opened no socket,
        // and 0 ms would read as "instant" -- a much more flattering claim than
        // "did not happen", and one that would drag every median down.
        val p = RequestTimeline().apply {
            mark(RequestEvent.CALL_START, ms(0))
            mark(RequestEvent.RESPONSE_START, ms(30))
            mark(RequestEvent.CALL_END, ms(45))
        }.phases()
        assertNull(p.dnsMs)
        assertNull(p.connectMs)
        assertNull(p.tlsMs)
        assertEquals(30.0, p.ttfbMs!!, 1e-6)
        assertEquals(45L, p.loadMs!!)
    }

    @Test
    fun `an IP literal skips dns but still connects`() {
        val p = RequestTimeline().apply {
            mark(RequestEvent.CALL_START, ms(0))
            mark(RequestEvent.CONNECT_START, ms(1))
            mark(RequestEvent.CONNECT_END, ms(21))
            mark(RequestEvent.RESPONSE_START, ms(40))
            mark(RequestEvent.CALL_END, ms(50))
        }.phases()
        assertNull(p.dnsMs)
        assertEquals(20.0, p.connectMs!!, 1e-6)
    }

    @Test
    fun `a request that never got a response reports the phases it did reach`() {
        // A refused connection is this device's answer about this URL, which is
        // data worth keeping: the DNS lookup that succeeded still happened.
        val p = RequestTimeline().apply {
            mark(RequestEvent.CALL_START, ms(0))
            mark(RequestEvent.DNS_START, ms(1))
            mark(RequestEvent.DNS_END, ms(15))
            mark(RequestEvent.CONNECT_START, ms(16))
            mark(RequestEvent.CALL_END, ms(5_016)) // callFailed, five seconds later
        }.phases()
        assertEquals(14.0, p.dnsMs!!, 1e-6)
        assertNull("the socket never opened", p.connectMs)
        assertNull("no byte ever arrived", p.ttfbMs)
        assertEquals(5_016L, p.loadMs!!)
    }

    @Test
    fun `a timeline with nothing in it reports nothing`() {
        val p = RequestTimeline().phases()
        assertNull(p.dnsMs); assertNull(p.connectMs); assertNull(p.tlsMs)
        assertNull(p.ttfbMs); assertNull(p.loadMs)
    }

    // --- repeated events --------------------------------------------------

    @Test
    fun `a retried connection is charged from the first attempt to the last`() {
        // Happy eyeballs, or a second address from a multi-A record: OkHttp
        // fires connectStart more than once. What getting connected actually
        // cost is the whole span, not the attempt that happened to win.
        val p = RequestTimeline().apply {
            mark(RequestEvent.CALL_START, ms(0))
            mark(RequestEvent.CONNECT_START, ms(10)) // first attempt
            mark(RequestEvent.CONNECT_START, ms(60)) // second, after the first stalled
            mark(RequestEvent.CONNECT_END, ms(90))
            mark(RequestEvent.RESPONSE_START, ms(120))
            mark(RequestEvent.CALL_END, ms(130))
        }.phases()
        assertEquals(80.0, p.connectMs!!, 1e-6)
    }

    @Test
    fun `the last end wins so a retried phase is not cut short`() {
        val p = RequestTimeline().apply {
            mark(RequestEvent.CALL_START, ms(0))
            mark(RequestEvent.DNS_START, ms(1))
            mark(RequestEvent.DNS_END, ms(5))
            mark(RequestEvent.DNS_END, ms(30)) // second lookup after the first failed
            mark(RequestEvent.CALL_END, ms(40))
        }.phases()
        assertEquals(29.0, p.dnsMs!!, 1e-6)
    }

    @Test
    fun `a duration is never negative`() {
        // Out-of-order marks would otherwise produce a negative millisecond
        // count, which is not a slow request -- it is nonsense, and it would
        // poison a median rather than announce itself.
        val p = RequestTimeline().apply {
            mark(RequestEvent.CALL_START, ms(100))
            mark(RequestEvent.RESPONSE_START, ms(50))
            mark(RequestEvent.CALL_END, ms(60))
        }.phases()
        assertEquals(0.0, p.ttfbMs!!, 1e-9)
        assertEquals(0L, p.loadMs!!)
    }

    // --- what counts as an ok row -----------------------------------------

    @Test
    fun `a 500 is a row that is not ok`() {
        // And not a failed job: a site being down is exactly what this workload
        // exists to notice.
        assertFalse(VantageEngine.ok(500))
        assertFalse(VantageEngine.ok(503))
    }

    @Test
    fun `a 404 is the server answering too, and it is not ok either`() {
        assertFalse(VantageEngine.ok(404))
        assertFalse(VantageEngine.ok(429))
    }

    @Test
    fun `2xx and 3xx are ok`() {
        assertTrue(VantageEngine.ok(200))
        assertTrue(VantageEngine.ok(204))
        // Redirects are not followed, so a 301 is a row of its own with honest
        // phases rather than a hidden extra hop inside someone else's ttfb.
        assertTrue(VantageEngine.ok(301))
        assertTrue(VantageEngine.ok(304))
    }

    // --- the run summary --------------------------------------------------

    @Test
    fun `the summary median is over the rows that answered`() {
        // One refused connection must not pull the summary toward a timeout
        // that was never a latency; it contributes no sample at all.
        val ttfbOfOkRows = listOf(120.0, 90.0, 150.0)
        assertEquals(120.0, Percentile.ofUnsorted(ttfbOfOkRows, 50), 1e-9)
    }
}
