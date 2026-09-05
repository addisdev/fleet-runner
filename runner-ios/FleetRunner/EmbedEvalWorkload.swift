import Foundation

/// The arithmetic half of an embedding eval: cosine similarity, ranking, and
/// what a recall number actually counts.
///
/// Kept free of the backend, the network and the clock, and mirroring the
/// Android runner's `EmbedMath` decision for decision — a recall figure is the
/// one output of this workload that looks equally plausible whether or not it
/// is right, so the two platforms have to agree on it by construction rather
/// than by both looking reasonable.
enum EmbedMath {

    /// Cosine similarity, full formula, so callers need not hold an invariant
    /// about pre-normalised inputs.
    ///
    /// NaN when either vector has no direction — zeros, or a NaN or infinity
    /// in the data. NaN rather than 0 on purpose: 0 is a real similarity
    /// ("orthogonal") and would let a broken embedding pass as a merely
    /// unrelated one.
    static func cosine(_ a: [Float], _ b: [Float]) -> Double {
        guard a.count == b.count, !a.isEmpty else { return .nan }
        var dot = 0.0, na = 0.0, nb = 0.0
        for i in 0..<a.count {
            let x = Double(a[i]), y = Double(b[i])
            dot += x * y
            na += x * x
            nb += y * y
        }
        guard na > 0, nb > 0, na.isFinite, nb.isFinite, dot.isFinite else { return .nan }
        return dot / (na.squareRoot() * nb.squareRoot())
    }

    /// True when the vector could be a real embedding: a finite, non-zero
    /// direction.
    static func hasDirection(_ v: [Float]) -> Bool {
        var n = 0.0
        for x in v {
            let d = Double(x)
            if !d.isFinite { return false }
            n += d * d
        }
        return n > 0 && n.isFinite
    }

    /// Document ids ordered by descending similarity to `query`. Documents
    /// whose similarity is NaN sort last rather than being dropped, so a top-10
    /// over a corpus of ten is still a top-10 when one of them is degenerate.
    static func rank(query: [Float], docIds: [String], docVectors: [[Float]]) -> [String] {
        let scored = docIds.indices.map { i -> (String, Double) in
            let c = cosine(query, docVectors[i])
            return (docIds[i], c.isNaN ? -Double.infinity : c)
        }
        return scored.sorted { $0.1 > $1.1 }.map(\.0)
    }

    /// Whether a query is a hit at `k`: at least one of its relevant documents
    /// appears in its top k.
    ///
    /// That is the definition the collector's schema pins for `recall_at_1` —
    /// "fraction of queries whose top hit is relevant" — so recall_at_5 and
    /// recall_at_10 have to be the same quantity at a wider k, or the three
    /// numbers would not belong to one series. A hit rate, not the proportion
    /// of each query's relevant set retrieved: a query with six relevant
    /// documents counts once, like every other query.
    static func hitAt(ranked: [String], relevant: Set<String>, k: Int) -> Bool {
        guard !relevant.isEmpty, k > 0 else { return false }
        for id in ranked.prefix(k) where relevant.contains(id) { return true }
        return false
    }
}

/// The assertion that keeps embed-eval honest.
///
/// The iOS Simulator once handed back an all-zero logits tensor for a vision
/// model without saying so, and the only reason it did not ship as a real
/// accuracy number was a second device disagreeing. An embedding model can fail
/// the same way — zeros, or one constant vector for every input — and the
/// recall it produces looks entirely plausible: some fixed fraction, stable
/// across runs, wrong.
///
/// So before a single document is scored, the backend embeds one string twice
/// and a different string once, and all three of these must hold: every vector
/// has a direction, the two identical strings come back at cosine 1, and the
/// different string does not. Failing any of them fails the job, loudly, with
/// the cosine actually seen.
enum EmbeddingSanity {
    /// Two embeddings of one string must land this close to 1. Not exactly 1:
    /// the same tokens through the same graph differ in the last bits across
    /// threading and accumulation order.
    static let identityTolerance = 1e-3
    /// Two *different* strings closer to 1 than this are taken as collapsed —
    /// one constant vector for every input, which passes the identity check
    /// perfectly and scores a corpus at chance.
    static let collapseTolerance = 1e-5

    static let probe = "fleet runner embedding sanity probe"
    static let probeOther = "sphinx of black quartz judge my vow"

    /// nil when the backend looks sane; otherwise the message to fail with.
    static func check(_ repeatA: [Float], _ repeatB: [Float], _ other: [Float]) -> String? {
        if repeatA.isEmpty { return "embedding backend returned a zero-width vector" }
        guard repeatB.count == repeatA.count, other.count == repeatA.count else {
            return "embedding backend returned vectors of differing widths "
                + "(\(repeatA.count), \(repeatB.count), \(other.count))"
        }
        for (label, v) in [("first", repeatA), ("second", repeatB), ("control", other)]
        where !EmbedMath.hasDirection(v) {
            return "degenerate embedding: the \(label) probe vector is all zeros or not finite — "
                + "the model produced no embedding and any recall from it would be fiction"
        }
        let identity = EmbedMath.cosine(repeatA, repeatB)
        if identity.isNaN || abs(1.0 - identity) > identityTolerance {
            return "degenerate embedding: two embeddings of the same string came back at "
                + "cosine \(identity), not 1"
        }
        let control = EmbedMath.cosine(repeatA, other)
        if !control.isNaN, control > 1.0 - collapseTolerance {
            return "degenerate embedding: two different strings came back at cosine \(control) — "
                + "the model is returning one constant vector for every input"
        }
        return nil
    }
}

/// One corpus entry: an id to score against, and the text to embed.
struct CorpusEntry {
    let id: String
    let text: String
}

/// A parsed `{ docs, queries, relevant }` corpus. Entries may be
/// `{"id": …, "text": …}` objects or bare strings, in which case the id is the
/// entry's position — a corpus that names nothing is still scorable as long as
/// `relevant` refers to the same positions.
struct Corpus {
    let docs: [CorpusEntry]
    let queries: [CorpusEntry]
    let relevant: [String: Set<String>]

    static func parse(_ root: [String: Any]) throws -> Corpus {
        let docs = try entries(root["docs"], "docs")
        let queries = try entries(root["queries"], "queries")
        var relevant: [String: Set<String>] = [:]
        for (key, value) in (root["relevant"] as? [String: Any]) ?? [:] {
            relevant[key] = Set((value as? [Any] ?? []).map { String(describing: $0) })
        }
        guard !docs.isEmpty else { throw BenchUnavailable(message: "corpus has no docs") }
        guard !queries.isEmpty else { throw BenchUnavailable(message: "corpus has no queries") }
        return Corpus(docs: docs, queries: queries, relevant: relevant)
    }

    private static func entries(_ raw: Any?, _ what: String) throws -> [CorpusEntry] {
        guard let array = raw as? [Any] else {
            throw BenchUnavailable(message: "corpus is missing `\(what)`")
        }
        return try array.enumerated().map { i, element in
            if let text = element as? String { return CorpusEntry(id: String(i), text: text) }
            guard let object = element as? [String: Any] else {
                throw BenchUnavailable(message: "\(what)[\(i)] is neither a string nor an object")
            }
            guard let text = object["text"] as? String else {
                throw BenchUnavailable(message: "\(what)[\(i)] has no `text`")
            }
            let id = object["id"].map { String(describing: $0) } ?? String(i)
            return CorpusEntry(id: id, text: text)
        }
    }
}

/// embed-eval: embed a corpus on the device and report how well the resulting
/// vectors rank a set of queries against a reference relevance judgement.
///
/// Which embedding model, at which recall, at which throughput, on which
/// minimum device — the same question the vision eval asks about classifiers,
/// for the retrieval half of an on-device search feature. No new native code:
/// llama.cpp already exposes embeddings, so this is the existing GGUF backend
/// with its context opened in embedding mode.
///
/// The corpus is a JSON artifact fetched by `params.input_sha256` and verified
/// against that hash on the way in, like every other eval's input.
extension Workloads {

    static func runEmbedEval(job: JobSpec, client: CollectorClient, deviceId: String,
                             artifacts: ArtifactCache) async {
        func fail(_ m: String) async {
            try? await client.postResult(ResultPost(kind: "result", jobId: job.jobId, deviceId: deviceId,
                                                    iter: 0, final: true, ok: false,
                                                    device: Telemetry.descriptor(), error: m))
        }
        #if canImport(llama)
        guard let modelRef = job.model, modelRef.format == "gguf" else {
            await fail("embed eval needs a gguf model ref"); return
        }
        guard let corpusSha = job.params?.inputSha256 else {
            await fail("embed eval needs params.input_sha256 (the corpus)"); return
        }
        let nCtx = Int32(job.params?.nCtx ?? 512)
        let nThreads = Int32(job.params?.nThreads ?? min(ProcessInfo.processInfo.activeProcessorCount, 6))
        let batteryStart = Telemetry.batteryPct()

        do {
            let modelFile = try await artifacts.ensure(sha256: modelRef.sha256)
            let corpusFile = try await artifacts.ensure(sha256: corpusSha)
            let root = try JSONSerialization.jsonObject(with: Data(contentsOf: corpusFile)) as? [String: Any]
            let corpus = try Corpus.parse(root ?? [:])

            // Detached, like every other workload here: the embedding loop must
            // not block the main actor, and above all not the 60-second beacon
            // that renews this job's lease.
            let outcome: Result<[String: Any], Error> = await Task.detached {
                do {
                    let backend = LlamaCppBackend()
                    defer { backend.unload() }
                    guard let loadMs = backend.load(path: modelFile.path, nCtx: nCtx,
                                                    nThreads: nThreads, embeddings: true) else {
                        throw BenchUnavailable(message: "llama.cpp failed to load \(modelRef.name)")
                    }

                    // Before anything is scored. A degenerate backend fails the
                    // job rather than producing a plausible-looking recall.
                    let probeA = try backend.embed(EmbeddingSanity.probe)
                    let probeB = try backend.embed(EmbeddingSanity.probe)
                    let probeOther = try backend.embed(EmbeddingSanity.probeOther)
                    if let problem = EmbeddingSanity.check(probeA, probeB, probeOther) {
                        throw BenchUnavailable(message: problem)
                    }
                    let dim = probeA.count

                    var latencies: [Double] = []
                    var thermals: [String] = []

                    func embedOne(_ entry: CorpusEntry, _ what: String) throws -> [Float] {
                        let t0 = DispatchTime.now()
                        let v = try backend.embed(entry.text)
                        latencies.append(Double(DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1e6)
                        guard v.count == dim else {
                            throw BenchUnavailable(
                                message: "\(what) '\(entry.id)' embedded to width \(v.count), expected \(dim)")
                        }
                        guard EmbedMath.hasDirection(v) else {
                            throw BenchUnavailable(
                                message: "degenerate embedding: \(what) '\(entry.id)' came back all zeros or not finite")
                        }
                        return v
                    }

                    var docVectors: [[Float]] = []
                    docVectors.reserveCapacity(corpus.docs.count)
                    let docsStart = DispatchTime.now()
                    for (i, doc) in corpus.docs.enumerated() {
                        // Iteration boundary: a beacon may have found the lease
                        // gone. No half-embedded document, and no recall
                        // computed over a truncated corpus.
                        if CancellationRegistry.shared.isCancelled(job.jobId) { throw JobCancelled() }
                        docVectors.append(try embedOne(doc, "doc"))
                        if i % 20 == 0 { thermals.append(Telemetry.thermal()) }
                        if (i + 1) % 20 == 0 {
                            try? await client.postResult(ResultPost(kind: "result", jobId: job.jobId,
                                                                    deviceId: deviceId, iter: i + 1, ok: true))
                        }
                    }
                    // Throughput over the documents and over embedding time
                    // only: the download, the model load and the query side are
                    // all real costs, but none of them is what "docs per
                    // second" is asked about.
                    let docsSeconds = Double(DispatchTime.now().uptimeNanoseconds - docsStart.uptimeNanoseconds) / 1e9
                    let docsPerS = Double(corpus.docs.count) / max(docsSeconds, 1e-9)

                    let docIds = corpus.docs.map(\.id)
                    var scored = 0, hits1 = 0, hits5 = 0, hits10 = 0
                    var perQuery: [[String: Any]] = []
                    for query in corpus.queries {
                        if CancellationRegistry.shared.isCancelled(job.jobId) { throw JobCancelled() }
                        let relevant = corpus.relevant[query.id] ?? []
                        let vec = try embedOne(query, "query")
                        // A query the corpus made no judgement about cannot be
                        // right or wrong, so it is excluded rather than counted
                        // as a miss — otherwise a corpus with gaps reads as a
                        // worse model.
                        if relevant.isEmpty { continue }
                        let ranked = EmbedMath.rank(query: vec, docIds: docIds, docVectors: docVectors)
                        let h1 = EmbedMath.hitAt(ranked: ranked, relevant: relevant, k: 1)
                        let h5 = EmbedMath.hitAt(ranked: ranked, relevant: relevant, k: 5)
                        let h10 = EmbedMath.hitAt(ranked: ranked, relevant: relevant, k: 10)
                        scored += 1
                        if h1 { hits1 += 1 }
                        if h5 { hits5 += 1 }
                        if h10 { hits10 += 1 }
                        let row: [String: Any] = [
                            "query": query.id, "top10": Array(ranked.prefix(10)),
                            "relevant": Array(relevant),
                            "hit1": h1, "hit5": h5, "hit10": h10,
                        ]
                        perQuery.append(row)
                    }
                    guard scored > 0 else {
                        throw BenchUnavailable(
                            message: "no query in the corpus has a `relevant` entry, so there is nothing to score")
                    }

                    return .success([
                        "job_id": job.jobId, "device_id": deviceId, "model": modelRef.name,
                        "backend": "llama.cpp", "dim": dim,
                        "docs": corpus.docs.count, "queries": corpus.queries.count,
                        "queries_scored": scored,
                        "recall_at_1": Double(hits1) / Double(scored),
                        "recall_at_5": Double(hits5) / Double(scored),
                        "recall_at_10": Double(hits10) / Double(scored),
                        "docs_per_s": docsPerS,
                        "embed_p50_ms": Percentile.of(latencies, 50) ?? 0,
                        "embed_p95_ms": Percentile.of(latencies, 95) ?? 0,
                        "load_ms": loadMs, "thermal": thermals, "per_query": perQuery,
                    ])
                } catch { return .failure(error) }
            }.value

            switch outcome {
            case .failure(let error): await fail(error.localizedDescription)
            case .success(let report):
                let data = try JSONSerialization.data(withJSONObject: report)
                let sha = try await client.uploadArtifact(data, name: "\(job.jobId)-embed-eval.json")
                var m = Metrics()
                m.loadMs = report["load_ms"] as? Int64
                m.recallAt1 = report["recall_at_1"] as? Double
                m.recallAt5 = report["recall_at_5"] as? Double
                m.recallAt10 = report["recall_at_10"] as? Double
                m.docsPerS = report["docs_per_s"] as? Double
                m.dim = report["dim"] as? Int
                // Per-embedding latency across the whole run, documents and
                // queries alike: it is one operation, and a query embed is what
                // a search actually pays at request time.
                m.p50Ms = report["embed_p50_ms"] as? Double
                m.p95Ms = report["embed_p95_ms"] as? Double
                m.peakMemMb = Telemetry.physFootprintMb()
                m.memMethod = "phys_footprint"
                m.thermal = report["thermal"] as? [String]
                m.batteryStartPct = batteryStart
                m.batteryEndPct = Telemetry.batteryPct()
                try? await client.postResult(ResultPost(kind: "result", jobId: job.jobId, deviceId: deviceId,
                                                        iter: 0, final: true, ok: true,
                                                        device: Telemetry.descriptor(), metrics: m,
                                                        artifacts: [sha]))
            }
        } catch { await fail(error.localizedDescription) }
        #else
        await fail("llama.cpp not built into this binary (llama.xcframework missing at build time)")
        #endif
    }
}
