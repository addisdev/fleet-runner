package com.taylab.fleetrunner.workload

import android.content.Context
import com.taylab.fleetrunner.JobCancellation
import com.taylab.fleetrunner.backend.LlamaCppBackend
import com.taylab.fleetrunner.net.ArtifactCache
import com.taylab.fleetrunner.net.CollectorClient
import com.taylab.fleetrunner.protocol.FleetJson
import com.taylab.fleetrunner.protocol.JobSpec
import com.taylab.fleetrunner.protocol.Metrics
import com.taylab.fleetrunner.protocol.ResultPost
import com.taylab.fleetrunner.protocol.stringParam
import com.taylab.fleetrunner.telemetry.Telemetry
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.math.abs
import kotlin.math.sqrt

/**
 * The arithmetic half of an embedding eval: cosine similarity, ranking, and
 * what a recall number actually counts.
 *
 * Kept pure — no Context, no backend, no clock — for the same reason
 * [ThermalRun] is: a recall figure is the one output of this workload that
 * looks equally plausible whether or not it is right, so the part that decides
 * it runs in a JVM test in microseconds instead of only ever on a warm phone
 * with a 400 MB model attached.
 */
object EmbedMath {

    /**
     * Cosine similarity, full formula, so callers need not hold an invariant
     * about pre-normalised inputs.
     *
     * NaN when either vector has no direction — a zero vector, or one carrying
     * a NaN or an infinity. NaN rather than 0.0 on purpose: 0.0 is a real
     * similarity ("orthogonal") and would let a broken embedding pass as a
     * merely unrelated one.
     */
    fun cosine(a: FloatArray, b: FloatArray): Double {
        if (a.size != b.size || a.isEmpty()) return Double.NaN
        var dot = 0.0
        var na = 0.0
        var nb = 0.0
        for (i in a.indices) {
            val x = a[i].toDouble()
            val y = b[i].toDouble()
            dot += x * y
            na += x * x
            nb += y * y
        }
        if (na <= 0.0 || nb <= 0.0 || !na.isFinite() || !nb.isFinite() || !dot.isFinite()) {
            return Double.NaN
        }
        return dot / (sqrt(na) * sqrt(nb))
    }

    /** True when [v] could be a real embedding: same length as the rest, and
     *  carrying a finite, non-zero direction. */
    fun hasDirection(v: FloatArray): Boolean {
        var n = 0.0
        for (x in v) {
            val d = x.toDouble()
            if (!d.isFinite()) return false
            n += d * d
        }
        return n > 0.0 && n.isFinite()
    }

    /**
     * Document ids ordered by descending similarity to [query]. Documents whose
     * similarity is NaN sort last rather than being dropped, so the ranking
     * always has as many entries as the corpus has documents and a k of 10 over
     * a corpus of 10 is still a full ranking.
     */
    fun rank(query: FloatArray, docIds: List<String>, docVectors: List<FloatArray>): List<String> =
        docIds.indices
            .sortedByDescending { cosine(query, docVectors[it]).let { c -> if (c.isNaN()) Double.NEGATIVE_INFINITY else c } }
            .map { docIds[it] }

    /**
     * Whether a query is a hit at [k]: at least one of its relevant documents
     * appears in its top k.
     *
     * That is the definition the collector's schema pins for `recall_at_1` —
     * "fraction of queries whose top hit is relevant" — so recall_at_5 and
     * recall_at_10 have to be the same quantity at a wider k, or the three
     * numbers would not belong to one series. It is a hit rate, not the
     * proportion of each query's relevant set that was retrieved; a query with
     * six relevant documents counts once, like every other query.
     */
    fun hitAt(ranked: List<String>, relevant: Set<String>, k: Int): Boolean {
        if (relevant.isEmpty() || k <= 0) return false
        for (i in 0 until minOf(k, ranked.size)) {
            if (ranked[i] in relevant) return true
        }
        return false
    }
}

/**
 * The assertion that keeps this workload honest.
 *
 * The iOS Simulator once handed back an all-zero logits tensor for a vision
 * model without saying so, and the only reason it did not ship as a real
 * accuracy number was a second device disagreeing. An embedding model can fail
 * the same way — a zero vector, or one constant vector for every input — and
 * the recall it produces looks entirely plausible: some fixed fraction, stable
 * across runs, wrong.
 *
 * So before a single document is scored, the backend is asked to embed the same
 * string twice and a different string once, and all three of these must hold:
 *
 *  * every vector has a direction (not zeros, no NaNs),
 *  * the two identical strings come back at cosine 1,
 *  * the different string does not.
 *
 * Failing any of them fails the job, loudly, with the cosine it actually saw.
 */
object EmbeddingSanity {

    /** Two embeddings of one string must land this close to cosine 1. Not
     *  exactly 1: the same tokens through the same graph can differ in the last
     *  bits or two across threading and accumulation order. */
    const val IDENTITY_TOLERANCE = 1e-3

    /** Two *different* strings closer to 1 than this are taken as collapsed —
     *  one constant vector for every input, which passes the identity check
     *  perfectly and scores a corpus at chance. */
    const val COLLAPSE_TOLERANCE = 1e-5

    /** A pair of strings with nothing in common, so a model that genuinely
     *  works cannot fail the collapse check by coincidence. */
    const val PROBE = "fleet runner embedding sanity probe"
    const val PROBE_OTHER = "sphinx of black quartz judge my vow"

    /** Null when the backend looks sane; otherwise the message to fail with. */
    fun check(repeatA: FloatArray, repeatB: FloatArray, other: FloatArray): String? {
        if (repeatA.isEmpty()) return "embedding backend returned a zero-width vector"
        if (repeatB.size != repeatA.size || other.size != repeatA.size) {
            return "embedding backend returned vectors of differing widths " +
                "(${repeatA.size}, ${repeatB.size}, ${other.size})"
        }
        for ((label, v) in listOf("first" to repeatA, "second" to repeatB, "control" to other)) {
            if (!EmbedMath.hasDirection(v)) {
                return "degenerate embedding: the $label probe vector is all zeros or not finite — " +
                    "the model produced no embedding and any recall from it would be fiction"
            }
        }
        val identity = EmbedMath.cosine(repeatA, repeatB)
        if (identity.isNaN() || abs(1.0 - identity) > IDENTITY_TOLERANCE) {
            return "degenerate embedding: two embeddings of the same string came back at " +
                "cosine $identity, not 1"
        }
        val control = EmbedMath.cosine(repeatA, other)
        if (!control.isNaN() && control > 1.0 - COLLAPSE_TOLERANCE) {
            return "degenerate embedding: two different strings came back at cosine $control — " +
                "the model is returning one constant vector for every input"
        }
        return null
    }
}

/** One corpus entry: an id to score against, and the text to embed. */
data class CorpusEntry(val id: String, val text: String)

/**
 * Parsed `{ docs, queries, relevant }` corpus. Entries may be
 * `{"id": ..., "text": ...}` objects or bare strings, in which case the id is
 * the entry's position — a corpus that names nothing is still scorable as long
 * as `relevant` refers to the same positions.
 */
data class Corpus(
    val docs: List<CorpusEntry>,
    val queries: List<CorpusEntry>,
    val relevant: Map<String, Set<String>>,
) {
    companion object {
        fun parse(root: JsonObject): Corpus {
            val docs = entries(root["docs"] as? JsonArray, "docs")
            val queries = entries(root["queries"] as? JsonArray, "queries")
            val relevant = (root["relevant"] as? JsonObject ?: JsonObject(emptyMap()))
                .mapValues { (_, v) ->
                    (v as? JsonArray)?.map { it.jsonPrimitive.content }?.toSet() ?: emptySet()
                }
            require(docs.isNotEmpty()) { "corpus has no docs" }
            require(queries.isNotEmpty()) { "corpus has no queries" }
            return Corpus(docs, queries, relevant)
        }

        private fun entries(arr: JsonArray?, what: String): List<CorpusEntry> {
            requireNotNull(arr) { "corpus is missing `$what`" }
            return arr.mapIndexed { i, el ->
                when (el) {
                    is JsonPrimitive -> CorpusEntry(i.toString(), el.content)
                    is JsonObject -> CorpusEntry(
                        id = el["id"]?.jsonPrimitive?.content ?: i.toString(),
                        text = el["text"]?.jsonPrimitive?.content
                            ?: throw IllegalArgumentException("$what[$i] has no `text`"),
                    )
                    else -> throw IllegalArgumentException("$what[$i] is neither a string nor an object")
                }
            }
        }
    }
}

/**
 * embed-eval: embed a corpus on the device and report how well the resulting
 * vectors rank a set of queries against a reference relevance judgement.
 *
 * Which embedding model, at which recall, at which throughput, on which
 * minimum device — the same question the vision eval asks about classifiers,
 * for the retrieval half of an on-device search feature. No new native code:
 * llama.cpp already exposes embeddings, so this is the existing GGUF backend
 * with its context opened in embedding mode.
 *
 * The corpus is a JSON artifact fetched by `params.input_sha256` and verified
 * against that hash on the way in, like every other eval's input.
 */
class EmbedEvalEngine(
    private val context: Context,
    private val client: CollectorClient,
    private val deviceId: String,
) {
    fun run(job: JobSpec) {
        val corpusSha = job.params.stringParam("input_sha256")
        val cache = ArtifactCache(context, client)
        val backend = LlamaCppBackend(cache)
        val batteryStart = Telemetry.batteryPct(context)
        try {
            requireNotNull(corpusSha) { "embed eval needs params.input_sha256 (the corpus)" }

            val loadMs = backend.loadForEmbedding(job)
            val corpus = Corpus.parse(
                FleetJson.parseToJsonElement(cache.ensure(corpusSha).readText()).jsonObject,
            )

            // Before anything is scored. A degenerate backend must fail the job
            // rather than produce a plausible-looking recall.
            val probeA = backend.embed(EmbeddingSanity.PROBE)
            val probeB = backend.embed(EmbeddingSanity.PROBE)
            val probeOther = backend.embed(EmbeddingSanity.PROBE_OTHER)
            EmbeddingSanity.check(probeA, probeB, probeOther)?.let { throw IllegalStateException(it) }
            val dim = probeA.size

            val latencies = mutableListOf<Double>()
            val thermals = mutableListOf<String>()

            /** Embeds one entry, timing it and refusing a degenerate vector. */
            fun embedOne(entry: CorpusEntry, what: String): FloatArray {
                val t0 = System.nanoTime()
                val v = backend.embed(entry.text)
                latencies += (System.nanoTime() - t0) / 1_000_000.0
                if (v.size != dim) {
                    throw IllegalStateException(
                        "$what '${entry.id}' embedded to width ${v.size}, expected $dim",
                    )
                }
                if (!EmbedMath.hasDirection(v)) {
                    throw IllegalStateException(
                        "degenerate embedding: $what '${entry.id}' came back all zeros or not finite",
                    )
                }
                return v
            }

            /** Posts a cancellation row and returns true when the job is over. */
            fun cancelled(): Boolean {
                if (!JobCancellation.isCancelled(job.jobId)) return false
                backend.unload()
                client.postResult(
                    ResultPost(
                        kind = "result", jobId = job.jobId, deviceId = deviceId,
                        iter = 0, final = true, ok = false,
                        device = Telemetry.descriptor(context), error = "cancelled",
                    ),
                )
                return true
            }

            // --- embed the corpus -------------------------------------------
            val docVectors = ArrayList<FloatArray>(corpus.docs.size)
            val docsStartedAt = System.nanoTime()
            corpus.docs.forEachIndexed { i, doc ->
                // Cancellation lands between documents: no half-embedded doc,
                // and no recall computed over a truncated corpus.
                if (cancelled()) return
                docVectors += embedOne(doc, "doc")
                if (i % 20 == 0) thermals += Telemetry.thermal(context)
                if ((i + 1) % 20 == 0) {
                    client.postResult(
                        ResultPost(kind = "result", jobId = job.jobId, deviceId = deviceId, iter = i + 1, ok = true),
                    )
                }
            }
            // Throughput over the documents only, and over embedding time only:
            // the download, the model load and the query side are all real costs
            // but none of them is what "docs per second" is asked about.
            val docsSeconds = (System.nanoTime() - docsStartedAt) / 1e9
            val docsPerS = corpus.docs.size / docsSeconds.coerceAtLeast(1e-9)

            // --- score the queries ------------------------------------------
            var scored = 0
            var hits1 = 0
            var hits5 = 0
            var hits10 = 0
            val perQuery = buildJsonArray {
                corpus.queries.forEach { query ->
                    if (cancelled()) return
                    val relevant = corpus.relevant[query.id] ?: emptySet()
                    val vec = embedOne(query, "query")
                    // A query the corpus made no judgement about cannot be
                    // right or wrong, so it is excluded rather than counted as
                    // a miss — otherwise a corpus with gaps reads as a worse
                    // model.
                    if (relevant.isEmpty()) return@forEach
                    val ranked = EmbedMath.rank(vec, corpus.docs.map { it.id }, docVectors)
                    val h1 = EmbedMath.hitAt(ranked, relevant, 1)
                    val h5 = EmbedMath.hitAt(ranked, relevant, 5)
                    val h10 = EmbedMath.hitAt(ranked, relevant, 10)
                    scored++
                    if (h1) hits1++
                    if (h5) hits5++
                    if (h10) hits10++
                    add(buildJsonObject {
                        put("query", query.id)
                        put("top10", buildJsonArray { ranked.take(10).forEach { add(JsonPrimitive(it)) } })
                        put("relevant", buildJsonArray { relevant.forEach { add(JsonPrimitive(it)) } })
                        put("hit1", h1); put("hit5", h5); put("hit10", h10)
                    })
                }
            }
            backend.unload()

            check(scored > 0) {
                "no query in the corpus has a `relevant` entry, so there is nothing to score"
            }

            val sorted = latencies.toDoubleArray().also { it.sort() }
            val report = buildJsonObject {
                put("job_id", job.jobId); put("device_id", deviceId)
                put("model", job.model?.name); put("backend", "llama.cpp")
                put("dim", dim); put("docs", corpus.docs.size)
                put("queries", corpus.queries.size); put("queries_scored", scored)
                put("recall_at_1", hits1.toDouble() / scored)
                put("recall_at_5", hits5.toDouble() / scored)
                put("recall_at_10", hits10.toDouble() / scored)
                put("docs_per_s", docsPerS)
                put("embed_p50_ms", Percentile.of(sorted, 50))
                put("embed_p95_ms", Percentile.of(sorted, 95))
                put("load_ms", loadMs)
                put("per_query", perQuery)
            }
            val sha = client.uploadArtifact(report.toString().toByteArray(), "${job.jobId}-embed-eval.json")

            client.postResult(
                ResultPost(
                    kind = "result", jobId = job.jobId, deviceId = deviceId,
                    iter = 0, final = true, ok = true,
                    device = Telemetry.descriptor(context),
                    metrics = Metrics(
                        loadMs = loadMs,
                        recallAt1 = hits1.toDouble() / scored,
                        recallAt5 = hits5.toDouble() / scored,
                        recallAt10 = hits10.toDouble() / scored,
                        docsPerS = docsPerS,
                        dim = dim,
                        // Per-embedding latency across the whole run, documents
                        // and queries alike: it is one operation, and a query
                        // embed is what a search actually pays at request time.
                        p50Ms = Percentile.of(sorted, 50),
                        p95Ms = Percentile.of(sorted, 95),
                        peakMemMb = Telemetry.pssMb(), memMethod = "pss",
                        thermal = thermals,
                        batteryStartPct = batteryStart, batteryEndPct = Telemetry.batteryPct(context),
                    ),
                    artifacts = listOf(sha),
                ),
            )
        } catch (e: Exception) {
            backend.unload()
            client.postResult(
                ResultPost(
                    kind = "result", jobId = job.jobId, deviceId = deviceId,
                    iter = 0, final = true, ok = false,
                    device = Telemetry.descriptor(context),
                    error = e.message ?: e.javaClass.simpleName,
                ),
            )
        }
    }
}
