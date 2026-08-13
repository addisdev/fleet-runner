// Thin JNI bench wrapper over llama.cpp, mirroring llama-bench's method:
// prefill = one batch decode of pp dummy tokens, decode = tg single-token
// decodes. Timings returned raw; Kotlin computes tok/s.
#include <jni.h>
#include <android/log.h>
#include <chrono>
#include <vector>

#include "llama.h"

#define TAG "fleetllama"
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

namespace {

struct FleetCtx {
    llama_model *model;
    llama_context *ctx;
};

double ms_since(std::chrono::steady_clock::time_point t0) {
    return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
}

} // namespace

extern "C" JNIEXPORT jlong JNICALL
Java_com_taylab_fleetrunner_backend_LlamaNative_nativeLoad(
        JNIEnv *env, jobject, jstring jpath, jint n_ctx, jint n_threads) {
    const char *path = env->GetStringUTFChars(jpath, nullptr);

    llama_backend_init();
    llama_model_params mparams = llama_model_default_params();
    llama_model *model = llama_model_load_from_file(path, mparams);
    env->ReleaseStringUTFChars(jpath, path);
    if (!model) {
        LOGE("model load failed");
        return 0;
    }

    llama_context_params cparams = llama_context_default_params();
    cparams.n_ctx = (uint32_t) n_ctx;
    cparams.n_batch = (uint32_t) n_ctx;
    cparams.n_threads = n_threads;
    cparams.n_threads_batch = n_threads;

    llama_context *ctx = llama_init_from_model(model, cparams);
    if (!ctx) {
        LOGE("context init failed");
        llama_model_free(model);
        return 0;
    }
    return (jlong) new FleetCtx{model, ctx};
}

extern "C" JNIEXPORT jdoubleArray JNICALL
Java_com_taylab_fleetrunner_backend_LlamaNative_nativeBench(
        JNIEnv *env, jobject, jlong handle, jint pp, jint tg) {
    auto *fc = (FleetCtx *) handle;
    if (!fc) return nullptr;
    llama_context *ctx = fc->ctx;

    const llama_vocab *vocab = llama_model_get_vocab(fc->model);
    llama_token tok = llama_vocab_bos(vocab);
    if (tok == LLAMA_TOKEN_NULL) tok = 0;

    llama_memory_clear(llama_get_memory(ctx), true);

    // Prefill: one batch of pp tokens.
    llama_batch batch = llama_batch_init(pp, 0, 1);
    for (int i = 0; i < pp; i++) {
        batch.token[i] = tok;
        batch.pos[i] = i;
        batch.n_seq_id[i] = 1;
        batch.seq_id[i][0] = 0;
        batch.logits[i] = (int8_t) (i == pp - 1);
    }
    batch.n_tokens = pp;

    auto t0 = std::chrono::steady_clock::now();
    int rc = llama_decode(ctx, batch);
    double prefill_ms = ms_since(t0);
    llama_batch_free(batch);
    if (rc != 0) {
        LOGE("prefill decode failed: %d", rc);
        return nullptr;
    }

    // Decode: tg tokens, one at a time.
    double ttft_ms = 0;
    llama_batch b1 = llama_batch_init(1, 0, 1);
    auto t1 = std::chrono::steady_clock::now();
    for (int j = 0; j < tg; j++) {
        b1.token[0] = tok;
        b1.pos[0] = pp + j;
        b1.n_seq_id[0] = 1;
        b1.seq_id[0][0] = 0;
        b1.logits[0] = 1;
        b1.n_tokens = 1;
        rc = llama_decode(ctx, b1);
        if (rc != 0) {
            LOGE("decode failed at token %d: %d", j, rc);
            llama_batch_free(b1);
            return nullptr;
        }
        if (j == 0) ttft_ms = prefill_ms + ms_since(t1);
    }
    double decode_ms = ms_since(t1);
    llama_batch_free(b1);

    jdouble out[3] = {prefill_ms, decode_ms, ttft_ms};
    jdoubleArray arr = env->NewDoubleArray(3);
    env->SetDoubleArrayRegion(arr, 0, 3, out);
    return arr;
}

extern "C" JNIEXPORT void JNICALL
Java_com_taylab_fleetrunner_backend_LlamaNative_nativeFree(JNIEnv *, jobject, jlong handle) {
    auto *fc = (FleetCtx *) handle;
    if (!fc) return;
    llama_free(fc->ctx);
    llama_model_free(fc->model);
    delete fc;
    llama_backend_free();
}
