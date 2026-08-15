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
    func load(path: String, nCtx: Int32, nThreads: Int32) -> Int64? {
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

    func unload() {
        if let ctx { llama_free(ctx) }
        if let model { llama_model_free(model) }
        ctx = nil
        model = nil
        llama_backend_free()
    }
}
#endif
