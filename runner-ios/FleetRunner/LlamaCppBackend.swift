#if canImport(llama)
import Foundation
import llama

/// llama.cpp over the C API, mirroring the Android JNI wrapper bench-for-bench:
/// prefill = one batch decode of pp BOS tokens, decode = tg single-token
/// decodes. Numbers are llama-bench-comparable across the fleet.
final class LlamaCppBackend {
    private var model: OpaquePointer?
    private var ctx: OpaquePointer?

    /// Returns load time in ms, or nil on failure.
    ///
    /// `embeddings` builds the context for embedding extraction instead of
    /// generation (embed-eval). A llama.cpp context does one or the other, so
    /// it is a load-time decision rather than a per-call one.
    func load(path: String, nCtx: Int32, nThreads: Int32, embeddings: Bool = false) -> Int64? {
        let t0 = DispatchTime.now()
        llama_backend_init()
        var mparams = llama_model_default_params()
        #if targetEnvironment(simulator)
        mparams.n_gpu_layers = 0 // Metal in the simulator is unreliable for ggml
        #endif
        guard let m = llama_model_load_from_file(path, mparams) else { return nil }
        var cparams = llama_context_default_params()
        cparams.n_ctx = UInt32(nCtx)
        cparams.n_batch = UInt32(nCtx)
        cparams.n_threads = nThreads
        cparams.n_threads_batch = nThreads
        // Mean pooling rather than none, so a document is one vector. With
        // LLAMA_POOLING_TYPE_NONE llama.cpp returns per-token states and every
        // caller invents its own pooling rule, which is how two runners end up
        // producing different vectors from the same model and the recall
        // numbers quietly stop being comparable across the fleet. The Android
        // JNI wrapper makes the same choice, for the same reason.
        if embeddings {
            cparams.embeddings = true
            cparams.pooling_type = LLAMA_POOLING_TYPE_MEAN
        }
        guard let c = llama_init_from_model(m, cparams) else {
            llama_model_free(m)
            return nil
        }
        model = m
        ctx = c
        return Int64((DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1_000_000)
    }

    /// Returns (prefillMs, decodeMs, ttftMs), or nil on decode failure.
    func bench(pp: Int32, tg: Int32) -> (Double, Double, Double)? {
        guard let ctx, let model else { return nil }
        let vocab = llama_model_get_vocab(model)
        var tok = llama_vocab_bos(vocab)
        if tok == LLAMA_TOKEN_NULL { tok = 0 }

        llama_memory_clear(llama_get_memory(ctx), true)

        var batch = llama_batch_init(pp, 0, 1)
        for i in 0..<Int(pp) {
            batch.token[i] = tok
            batch.pos[i] = llama_pos(i)
            batch.n_seq_id[i] = 1
            batch.seq_id[i]![0] = 0
            batch.logits[i] = i == Int(pp) - 1 ? 1 : 0
        }
        batch.n_tokens = pp

        let t0 = DispatchTime.now()
        let prefillRc = llama_decode(ctx, batch)
        let prefillMs = Double(DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1e6
        llama_batch_free(batch)
        guard prefillRc == 0 else { return nil }

        var ttftMs = 0.0
        var single = llama_batch_init(1, 0, 1)
        let t1 = DispatchTime.now()
        for j in 0..<Int(tg) {
            single.token[0] = tok
            single.pos[0] = llama_pos(Int(pp) + j)
            single.n_seq_id[0] = 1
            single.seq_id[0]![0] = 0
            single.logits[0] = 1
            single.n_tokens = 1
            guard llama_decode(ctx, single) == 0 else {
                llama_batch_free(single)
                return nil
            }
            if j == 0 {
                ttftMs = prefillMs + Double(DispatchTime.now().uptimeNanoseconds - t1.uptimeNanoseconds) / 1e6
            }
        }
        let decodeMs = Double(DispatchTime.now().uptimeNanoseconds - t1.uptimeNanoseconds) / 1e6
        llama_batch_free(single)
        return (prefillMs, decodeMs, ttftMs)
    }

    /// Greedy generation until EOG or maxTokens (batch/pipeline workloads).
    func generate(prompt: String, maxTokens: Int32) throws -> String {
        guard let ctx, let model else { throw CollectorError.http(0, "model not loaded") }
        let vocab = llama_model_get_vocab(model)
        let utf8 = Array(prompt.utf8)
        let nPrompt = -llama_tokenize(vocab, prompt, Int32(utf8.count), nil, 0, true, true)
        guard nPrompt > 0 else { throw CollectorError.http(0, "tokenize failed") }
        var tokens = [llama_token](repeating: 0, count: Int(nPrompt))
        guard llama_tokenize(vocab, prompt, Int32(utf8.count), &tokens, nPrompt, true, true) >= 0 else {
            throw CollectorError.http(0, "tokenize failed")
        }
        llama_memory_clear(llama_get_memory(ctx), true)

        var batch = llama_batch_init(nPrompt, 0, 1)
        for i in 0..<Int(nPrompt) {
            batch.token[i] = tokens[i]; batch.pos[i] = llama_pos(i)
            batch.n_seq_id[i] = 1; batch.seq_id[i]![0] = 0
            batch.logits[i] = i == Int(nPrompt) - 1 ? 1 : 0
        }
        batch.n_tokens = nPrompt
        let rc = llama_decode(ctx, batch)
        llama_batch_free(batch)
        guard rc == 0 else { throw CollectorError.http(0, "prefill failed") }

        let sampler = llama_sampler_init_greedy()
        defer { llama_sampler_free(sampler) }
        var single = llama_batch_init(1, 0, 1)
        defer { llama_batch_free(single) }
        var out = ""
        var pos = Int(nPrompt)
        var piece = [CChar](repeating: 0, count: 256)
        for _ in 0..<Int(maxTokens) {
            let tok = llama_sampler_sample(sampler, ctx, -1)
            if llama_vocab_is_eog(vocab, tok) { break }
            let len = llama_token_to_piece(vocab, tok, &piece, 256, 0, true)
            if len > 0 { out += String(decoding: piece[0..<Int(len)].map { UInt8(bitPattern: $0) }, as: UTF8.self) }
            single.token[0] = tok; single.pos[0] = llama_pos(pos); pos += 1
            single.n_seq_id[0] = 1; single.seq_id[0]![0] = 0; single.logits[0] = 1
            single.n_tokens = 1
            guard llama_decode(ctx, single) == 0 else { break }
        }
        return out
    }

    /// One mean-pooled embedding vector for `text` (embed-eval).
    ///
    /// Requires a context opened with `embeddings: true`. A context built for
    /// generation keeps no embedding tensor, and this throws rather than
    /// handing back a vector of zeros — a plausible-looking zero vector is
    /// precisely the failure embed-eval exists to refuse.
    func embed(_ text: String) throws -> [Float] {
        guard let ctx, let model else { throw CollectorError.http(0, "model not loaded") }
        let vocab = llama_model_get_vocab(model)
        let utf8 = Array(text.utf8)
        let nMax = -llama_tokenize(vocab, text, Int32(utf8.count), nil, 0, true, true)
        guard nMax > 0 else { throw BenchUnavailable(message: "embed tokenize failed") }
        var tokens = [llama_token](repeating: 0, count: Int(nMax))
        guard llama_tokenize(vocab, text, Int32(utf8.count), &tokens, nMax, true, true) >= 0 else {
            throw BenchUnavailable(message: "embed tokenize failed")
        }
        // A document longer than the context is truncated rather than refused:
        // one long document should not cost the corpus its recall number, and
        // the cut is identical on every device because n_ctx comes from the job.
        let nTokens = min(Int(nMax), Int(llama_n_ctx(ctx)))
        guard nTokens > 0 else { throw BenchUnavailable(message: "embed produced no tokens") }

        llama_memory_clear(llama_get_memory(ctx), true)
        var batch = llama_batch_init(Int32(nTokens), 0, 1)
        defer { llama_batch_free(batch) }
        for i in 0..<nTokens {
            batch.token[i] = tokens[i]
            batch.pos[i] = llama_pos(i)
            batch.n_seq_id[i] = 1
            batch.seq_id[i]![0] = 0
            // Every token is an output: mean pooling averages the states of the
            // tokens that were asked for, so marking only the last would pool a
            // single state and quietly call it a document embedding.
            batch.logits[i] = 1
        }
        batch.n_tokens = Int32(nTokens)

        // BERT-shaped embedding models are encoder-only and llama_decode
        // refuses them; generative GGUFs are decoder-only and llama_encode
        // refuses those.
        let encoderOnly = llama_model_has_encoder(model) && !llama_model_has_decoder(model)
        let rc = encoderOnly ? llama_encode(ctx, batch) : llama_decode(ctx, batch)
        guard rc == 0 else {
            throw BenchUnavailable(message: "embed \(encoderOnly ? "encode" : "decode") failed: \(rc)")
        }

        var raw: UnsafeMutablePointer<Float>? = llama_get_embeddings_seq(ctx, 0)
        if raw == nil { raw = llama_get_embeddings_ith(ctx, Int32(nTokens - 1)) }
        guard let vector = raw else {
            throw BenchUnavailable(
                message: "no embedding tensor; context was not built with embeddings=true")
        }
        let dim = Int(llama_model_n_embd(model))
        guard dim > 0 else { throw BenchUnavailable(message: "model reports n_embd \(dim)") }
        return Array(UnsafeBufferPointer(start: vector, count: dim))
    }

    func unload() {
        if let ctx { llama_free(ctx) }
        if let model { llama_model_free(model) }
        ctx = nil
        model = nil
        llama_backend_free()
    }
}
#endif
