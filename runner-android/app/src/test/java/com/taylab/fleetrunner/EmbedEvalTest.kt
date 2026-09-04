package com.taylab.fleetrunner

import com.taylab.fleetrunner.protocol.FleetJson
import com.taylab.fleetrunner.workload.Corpus
import com.taylab.fleetrunner.workload.EmbedMath
import com.taylab.fleetrunner.workload.EmbeddingSanity
import com.taylab.fleetrunner.workload.Percentile
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The embed-eval arithmetic, with vectors written out by hand.
 *
 * A recall figure is the one output of this workload that looks exactly as
 * plausible whether or not it is right: 0.71 is a believable number for a good
 * model, for a broken model and for a bug in the ranking. Nothing about a run
 * on a real device would reveal any of the three, so the deciding arithmetic is
 * pinned here instead, where a wrong answer is a red test rather than a
 * published metric.
 */
class EmbedEvalTest {

    private fun v(vararg xs: Double) = FloatArray(xs.size) { xs[it].toFloat() }

    // --- cosine -----------------------------------------------------------

    @Test
    fun `a vector is at cosine 1 with itself`() {
        val a = v(0.3, -0.4, 0.5)
        assertEquals(1.0, EmbedMath.cosine(a, a), 1e-9)
    }

    @Test
    fun `magnitude does not change the angle`() {
        // Cosine is direction only, so an unnormalised pair must score the same
        // as its normalised one -- the engine feeds raw backend output straight
        // in and never normalises first.
        assertEquals(1.0, EmbedMath.cosine(v(1.0, 2.0, 3.0), v(10.0, 20.0, 30.0)), 1e-9)
    }

    @Test
    fun `orthogonal is zero and opposite is minus one`() {
        assertEquals(0.0, EmbedMath.cosine(v(1.0, 0.0), v(0.0, 1.0)), 1e-9)
        assertEquals(-1.0, EmbedMath.cosine(v(1.0, 0.0), v(-1.0, 0.0)), 1e-9)
    }

    @Test
    fun `a zero vector has no angle, and that is NaN rather than zero`() {
        // 0.0 is a real similarity ("unrelated"), so returning it for a broken
        // embedding would let the failure pass as an ordinary bad match.
        assertTrue(EmbedMath.cosine(v(0.0, 0.0), v(1.0, 1.0)).isNaN())
        assertTrue(EmbedMath.cosine(v(0.0, 0.0), v(0.0, 0.0)).isNaN())
    }

    @Test
    fun `NaN and infinity in a vector do not produce a similarity`() {
        assertTrue(EmbedMath.cosine(floatArrayOf(Float.NaN, 1f), v(1.0, 1.0)).isNaN())
        assertTrue(EmbedMath.cosine(floatArrayOf(Float.POSITIVE_INFINITY, 1f), v(1.0, 1.0)).isNaN())
    }

    @Test
    fun `vectors of different widths are never compared`() {
        assertTrue(EmbedMath.cosine(v(1.0, 0.0), v(1.0, 0.0, 0.0)).isNaN())
    }

    // --- ranking ----------------------------------------------------------

    @Test
    fun `documents rank by descending similarity to the query`() {
        val docs = listOf(v(1.0, 0.0), v(0.7, 0.7), v(0.0, 1.0), v(-1.0, 0.0))
        val ids = listOf("a", "b", "c", "d")
        assertEquals(listOf("a", "b", "c", "d"), EmbedMath.rank(v(1.0, 0.0), ids, docs))
    }

    @Test
    fun `a ranking always covers the whole corpus`() {
        // Including documents that could not be scored: dropping them would
        // silently shrink k, so a top-10 over ten documents would stop being a
        // top-10 the moment one of them was degenerate.
        val docs = listOf(v(1.0, 0.0), v(0.0, 0.0), v(0.9, 0.1))
        val ranked = EmbedMath.rank(v(1.0, 0.0), listOf("a", "zero", "c"), docs)
        assertEquals(3, ranked.size)
        assertEquals(listOf("a", "c", "zero"), ranked)
    }

    // --- recall -----------------------------------------------------------

    @Test
    fun `recall at 1 is whether the top hit is relevant`() {
        val ranked = listOf("d3", "d1", "d2")
        assertTrue(EmbedMath.hitAt(ranked, setOf("d3"), 1))
        assertFalse(EmbedMath.hitAt(ranked, setOf("d1"), 1))
    }

    @Test
    fun `a wider k finds a relevant document further down`() {
        val ranked = (1..12).map { "d$it" }
        assertFalse(EmbedMath.hitAt(ranked, setOf("d7"), 1))
        assertFalse(EmbedMath.hitAt(ranked, setOf("d7"), 5))
        assertTrue(EmbedMath.hitAt(ranked, setOf("d7"), 10))
        assertFalse("d11 is outside the top ten", EmbedMath.hitAt(ranked, setOf("d11"), 10))
    }

    @Test
    fun `k is a boundary, not an approximation`() {
        val ranked = (1..10).map { "d$it" }
        assertTrue("d5 is the fifth", EmbedMath.hitAt(ranked, setOf("d5"), 5))
        assertFalse("d6 is the sixth", EmbedMath.hitAt(ranked, setOf("d6"), 5))
    }

    @Test
    fun `one relevant document in the window is a hit, and it counts once`() {
        // A hit rate, not a proportion retrieved: this is what the collector's
        // schema pins recall_at_1 to ("fraction of queries whose top hit is
        // relevant"), so the wider ks have to be the same quantity or the three
        // numbers do not belong to one series. A query with six relevant
        // documents counts exactly as much as a query with one.
        val ranked = listOf("d1", "d2", "d3", "d4", "d5")
        assertTrue(EmbedMath.hitAt(ranked, setOf("d4", "d9", "d17"), 5))
        assertTrue(EmbedMath.hitAt(ranked, setOf("d1", "d2", "d3", "d4", "d5"), 5))
    }

    @Test
    fun `a query with no relevant documents can never be a hit`() {
        assertFalse(EmbedMath.hitAt(listOf("d1"), emptySet(), 10))
    }

    @Test
    fun `k larger than the corpus is not an error`() {
        assertTrue(EmbedMath.hitAt(listOf("d1", "d2"), setOf("d2"), 10))
        assertFalse(EmbedMath.hitAt(listOf("d1", "d2"), setOf("d3"), 10))
    }

    @Test
    fun `recall over a whole query set is the fraction that hit`() {
        // The engine's accumulation, done by hand: three queries, two of which
        // put a relevant document first.
        val queries = listOf(
            listOf("a", "b", "c") to setOf("a"),
            listOf("b", "a", "c") to setOf("a"),
            listOf("c", "a", "b") to setOf("c"),
        )
        val hits1 = queries.count { (ranked, rel) -> EmbedMath.hitAt(ranked, rel, 1) }
        val hits5 = queries.count { (ranked, rel) -> EmbedMath.hitAt(ranked, rel, 5) }
        assertEquals(2.0 / 3.0, hits1.toDouble() / queries.size, 1e-9)
        assertEquals(1.0, hits5.toDouble() / queries.size, 1e-9)
    }

    // --- the degeneracy assertion -----------------------------------------

    @Test
    fun `a working backend passes the sanity check`() {
        val a = v(0.1, 0.9, -0.3)
        val other = v(-0.8, 0.2, 0.5)
        assertNull(EmbeddingSanity.check(a, a.copyOf(), other))
    }

    @Test
    fun `an all-zero embedding fails the job`() {
        // The failure this check exists for. The iOS Simulator returned an
        // all-zero logits tensor for a vision model silently, and a plausible
        // recall computed from zeros is indistinguishable from a real one.
        val zero = v(0.0, 0.0, 0.0)
        val message = EmbeddingSanity.check(zero, zero.copyOf(), v(1.0, 0.0, 0.0))
        assertNotNull("zeros must not pass", message)
        assertTrue(message!!, message.contains("degenerate"))
    }

    @Test
    fun `a non-finite embedding fails the job`() {
        val bad = floatArrayOf(Float.NaN, 1f, 2f)
        assertNotNull(EmbeddingSanity.check(bad, bad.copyOf(), v(1.0, 0.0, 0.0)))
    }

    @Test
    fun `two embeddings of the same string must come back at cosine 1`() {
        val a = v(1.0, 0.0, 0.0)
        val drifted = v(0.0, 1.0, 0.0)
        val message = EmbeddingSanity.check(a, drifted, v(0.0, 0.0, 1.0))
        assertNotNull("a non-deterministic backend must not be scored", message)
        assertTrue(message!!, message.contains("same string"))
    }

    @Test
    fun `last-bit differences between two runs of one string are tolerated`() {
        // Threading and accumulation order genuinely move the last bits; the
        // check must catch a broken model, not a busy one.
        val a = v(0.5, 0.5, 0.5)
        val b = v(0.5000001, 0.4999999, 0.5)
        assertNull(EmbeddingSanity.check(a, b, v(-1.0, 0.3, 0.2)))
    }

    @Test
    fun `a model that returns one constant vector fails even though it is self-consistent`() {
        // The subtler half. A constant output passes "identical strings embed
        // to cosine 1" perfectly -- everything embeds to everything -- and
        // scores the corpus at chance, which reads as a mediocre model rather
        // than a broken one.
        val constant = v(0.2, 0.2, 0.2)
        val message = EmbeddingSanity.check(constant, constant.copyOf(), constant.copyOf())
        assertNotNull("a collapsed model must not be scored", message)
        assertTrue(message!!, message.contains("constant vector"))
    }

    @Test
    fun `a backend that changes its embedding width fails the job`() {
        assertNotNull(EmbeddingSanity.check(v(1.0, 0.0), v(1.0, 0.0, 0.0), v(0.0, 1.0)))
    }

    @Test
    fun `a zero-width vector fails the job`() {
        assertNotNull(EmbeddingSanity.check(FloatArray(0), FloatArray(0), FloatArray(0)))
    }

    @Test
    fun `two genuinely different texts are allowed to be very similar`() {
        // Near-duplicates are ordinary in a real corpus; only an exact collapse
        // is the failure.
        val a = v(1.0, 0.0, 0.0)
        val nearly = v(0.9999, 0.01, 0.0)
        assertNull(EmbeddingSanity.check(a, a.copyOf(), nearly))
    }

    // --- percentiles ------------------------------------------------------

    @Test
    fun `percentiles use the same nearest-rank indexing as the vision eval`() {
        val sorted = DoubleArray(100) { (it + 1).toDouble() }
        assertEquals(51.0, Percentile.of(sorted, 50), 1e-9)
        assertEquals(96.0, Percentile.of(sorted, 95), 1e-9)
    }

    @Test
    fun `a percentile of a single sample is that sample`() {
        assertEquals(7.0, Percentile.of(doubleArrayOf(7.0), 95), 1e-9)
    }

    @Test
    fun `no samples is not zero milliseconds`() {
        assertTrue(Percentile.of(DoubleArray(0), 50).isNaN())
    }

    @Test
    fun `the top percentile never runs off the end of the array`() {
        assertEquals(3.0, Percentile.of(doubleArrayOf(1.0, 2.0, 3.0), 100), 1e-9)
    }

    // --- corpus parsing ---------------------------------------------------

    private fun corpus(json: String) =
        Corpus.parse(FleetJson.parseToJsonElement(json).jsonObject)

    @Test
    fun `a corpus of id-and-text objects parses`() {
        val c = corpus(
            """
            {"docs":[{"id":"d1","text":"alpha"},{"id":"d2","text":"beta"}],
             "queries":[{"id":"q1","text":"al"}],
             "relevant":{"q1":["d1"]}}
            """.trimIndent(),
        )
        assertEquals(listOf("d1", "d2"), c.docs.map { it.id })
        assertEquals("alpha", c.docs[0].text)
        assertEquals(setOf("d1"), c.relevant["q1"])
    }

    @Test
    fun `bare strings are indexed by position`() {
        val c = corpus("""{"docs":["alpha","beta"],"queries":["al"],"relevant":{"0":["1"]}}""")
        assertEquals(listOf("0", "1"), c.docs.map { it.id })
        assertEquals("beta", c.docs[1].text)
        assertEquals(setOf("1"), c.relevant["0"])
    }

    @Test
    fun `a query with no judgement is absent rather than empty`() {
        val c = corpus("""{"docs":["a"],"queries":["q"],"relevant":{}}""")
        assertNull(c.relevant["0"])
    }

    @Test(expected = IllegalArgumentException::class)
    fun `a corpus with no docs is refused`() {
        corpus("""{"docs":[],"queries":["q"],"relevant":{}}""")
    }

    @Test(expected = IllegalArgumentException::class)
    fun `a corpus missing queries is refused`() {
        corpus("""{"docs":["a"],"relevant":{}}""")
    }

    @Test(expected = IllegalArgumentException::class)
    fun `a document with no text is refused rather than embedded as empty`() {
        corpus("""{"docs":[{"id":"d1"}],"queries":["q"],"relevant":{}}""")
    }
}
