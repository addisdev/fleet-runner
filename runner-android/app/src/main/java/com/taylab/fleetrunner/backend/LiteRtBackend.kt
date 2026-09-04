package com.taylab.fleetrunner.backend

import android.graphics.Bitmap
import com.taylab.fleetrunner.net.ArtifactCache
import com.taylab.fleetrunner.protocol.JobSpec
import com.taylab.fleetrunner.protocol.intParam
import com.taylab.fleetrunner.protocol.stringParam
import org.tensorflow.lite.Interpreter
import org.tensorflow.lite.gpu.GpuDelegate
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * LiteRT image classifier. Preprocessing is fixed by the job's params so
 * every device runs bit-identical input:
 *   params.input_layout   "nchw" | "nhwc"        (default nhwc)
 *   params.normalize      "imagenet" | "unit" | "raw"  (default imagenet)
 *   params.accelerator    "cpu" | "gpu"          (default cpu)
 *   params.n_threads      CPU threads             (default min(cores, 4))
 * Output is taken as logits/probabilities over classes; top-k by value.
 */
class LiteRtBackend(private val artifacts: ArtifactCache) : ModelBackend {
    override val name = "litert"

    private var interpreter: Interpreter? = null
    private var gpuDelegate: GpuDelegate? = null
    private var inputSize = 224
    private var layoutNchw = false
    private var normalize = "imagenet"
    private var numClasses = 0
    private var inputBuffer: ByteBuffer? = null

    var acceleratorUsed = "cpu"
        private set

    override fun load(job: JobSpec): Long {
        val model = job.model ?: throw IllegalArgumentException("litert job needs a model ref")
        require(model.format == "tflite") { "litert needs tflite, got ${model.format}" }
        val file = artifacts.ensure(model.sha256)

        layoutNchw = job.params.stringParam("input_layout") == "nchw"
        normalize = job.params.stringParam("normalize") ?: "imagenet"
        val wantGpu = job.params.stringParam("accelerator") == "gpu"

        val t0 = System.nanoTime()
        val nThreads = job.params.intParam("n_threads", minOf(Runtime.getRuntime().availableProcessors(), 4))
        var interp: Interpreter? = null
        if (wantGpu) {
            // The delegate can fail at construction (no GL/CL) or at first
            // allocation (delegate prepare). Either way: fall back to CPU and
            // say so in the report — a silent fallback would mislabel numbers.
            try {
                val gpu = GpuDelegate()
                val opts = Interpreter.Options().apply { numThreads = nThreads; addDelegate(gpu) }
                interp = Interpreter(file, opts).also { it.allocateTensors() }
                gpuDelegate = gpu
                acceleratorUsed = "gpu"
            } catch (t: Throwable) {
                interp?.close(); interp = null
                gpuDelegate?.close(); gpuDelegate = null
                acceleratorUsed = "cpu (gpu unavailable: ${t.message?.lineSequence()?.firstOrNull()?.take(80)})"
            }
        }
        if (interp == null) {
            interp = Interpreter(file, Interpreter.Options().apply { numThreads = nThreads })
            if (!wantGpu) acceleratorUsed = "cpu"
        }
        interpreter = interp

        val inShape = interp.getInputTensor(0).shape() // NHWC [1,H,W,3] or NCHW [1,3,H,W]
        inputSize = if (layoutNchw) inShape[2] else inShape[1]
        val outShape = interp.getOutputTensor(0).shape()
        numClasses = outShape.last()
        inputBuffer = ByteBuffer.allocateDirect(4 * 3 * inputSize * inputSize).order(ByteOrder.nativeOrder())
        return (System.nanoTime() - t0) / 1_000_000
    }

    val classes: Int get() = numClasses
    val size: Int get() = inputSize

    /** Classify one already-square bitmap; returns (topK indices, latency ms). */
    fun classify(bitmap: Bitmap, k: Int): Pair<IntArray, Long> {
        val interp = interpreter ?: error("load() not called")
        val scaled = if (bitmap.width != inputSize) Bitmap.createScaledBitmap(bitmap, inputSize, inputSize, true) else bitmap
        val buf = inputBuffer!!.also { it.rewind() }
        val pixels = IntArray(inputSize * inputSize)
        scaled.getPixels(pixels, 0, inputSize, 0, 0, inputSize, inputSize)

        val mean = floatArrayOf(0.485f, 0.456f, 0.406f)
        val std = floatArrayOf(0.229f, 0.224f, 0.225f)
        fun norm(v: Int, c: Int): Float = when (normalize) {
            "imagenet" -> (v / 255f - mean[c]) / std[c]
            "unit" -> v / 255f
            else -> v.toFloat()
        }
        if (layoutNchw) {
            for (c in 0 until 3) for (p in pixels) {
                val v = when (c) { 0 -> (p shr 16) and 0xFF; 1 -> (p shr 8) and 0xFF; else -> p and 0xFF }
                buf.putFloat(norm(v, c))
            }
        } else {
            for (p in pixels) {
                buf.putFloat(norm((p shr 16) and 0xFF, 0))
                buf.putFloat(norm((p shr 8) and 0xFF, 1))
                buf.putFloat(norm(p and 0xFF, 2))
            }
        }
        buf.rewind()

        val out = Array(1) { FloatArray(numClasses) }
        val t0 = System.nanoTime()
        interp.run(buf, out)
        val ms = (System.nanoTime() - t0) / 1_000_000
        val scores = out[0]
        val top = scores.indices.sortedByDescending { scores[it] }.take(k).toIntArray()
        return top to ms
    }

    override fun runIteration(job: JobSpec): IterResult {
        // Benchmark path: a blank frame, latency only.
        val blank = Bitmap.createBitmap(inputSize, inputSize, Bitmap.Config.ARGB_8888)
        val (_, ms) = classify(blank, 1)
        val fps = 1000.0 / ms.coerceAtLeast(1)
        return IterResult(prefillTokS = fps, decodeTokS = fps, ttftMs = ms.toDouble())
    }

    override fun unload() {
        interpreter?.close()
        interpreter = null
        gpuDelegate?.close()
        gpuDelegate = null
    }
}
