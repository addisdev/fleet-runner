package com.taylab.fleetrunner.ui

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PathMeasure
import android.provider.Settings
import android.util.AttributeSet
import android.view.View
import android.view.animation.PathInterpolator
import androidx.core.content.ContextCompat
import com.taylab.fleetrunner.R

/**
 * The mark's pulse, drawn left to right while the agent is in contact with the
 * collector.
 *
 * This is the same shape as the launcher icon, the dashboard's glyph and the
 * README banner — one flat run, one spike, one flat run — so the thing that
 * moves on a runner's home screen is recognisably the product's own mark rather
 * than a generic spinner. It answers "is this phone actually talking to
 * anything?" before a single word on the screen has been read.
 *
 * At rest it is the complete trace in the panel's line colour: a still,
 * finished drawing, not an empty box. That is also exactly what it shows when
 * the system's animator duration scale is zero — the Android equivalent of
 * prefers-reduced-motion, set by Developer options and by accessibility
 * tooling — because a loop that ignores that setting is a loop the user cannot
 * turn off.
 */
class PulseTraceView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyle: Int = 0,
) : View(context, attrs, defStyle) {

    private val trackPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val tracePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }

    private val path = Path()
    private val measure = PathMeasure()
    private var length = 0f
    private var sweep = 1f
    private var animator: ValueAnimator? = null

    /** True while the agent is registered and polling or running. */
    var active: Boolean = false
        set(value) {
            if (field == value) return
            field = value
            tracePaint.color = if (value) pulseColor else faintColor
            restart()
        }

    private val pulseColor = ContextCompat.getColor(context, R.color.fleet_pulse)
    private val faintColor = ContextCompat.getColor(context, R.color.fleet_ink_faint)

    init {
        trackPaint.color = ContextCompat.getColor(context, R.color.fleet_line)
        trackPaint.strokeWidth = dp(2f)
        tracePaint.color = faintColor
        tracePaint.strokeWidth = dp(2.5f)
        // Decoration: the headline beside it carries the same meaning in words.
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
        // DashPathEffect is not supported by the hardware pipeline.
        setLayerType(LAYER_TYPE_SOFTWARE, null)
    }

    private fun dp(v: Float) = v * resources.displayMetrics.density

    /**
     * Zero means "do not animate": the same signal the platform's own
     * transitions honour.
     */
    private fun animationsEnabled(): Boolean =
        Settings.Global.getFloat(
            context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f,
        ) != 0f

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        buildPath(w.toFloat(), h.toFloat())
        restart()
    }

    /** Authored against the 290x88 box the design uses, then scaled. */
    private fun buildPath(w: Float, h: Float) {
        val sx = w / 290f
        val sy = h / 88f
        path.reset()
        path.moveTo(0f, 44f * sy)
        path.lineTo(92f * sx, 44f * sy)
        path.lineTo(114f * sx, 14f * sy)
        path.lineTo(148f * sx, 80f * sy)
        path.lineTo(168f * sx, 44f * sy)
        path.lineTo(290f * sx, 44f * sy)
        measure.setPath(path, false)
        length = measure.length
    }

    private fun restart() {
        animator?.cancel()
        animator = null
        if (!active || !animationsEnabled() || length <= 0f) {
            sweep = 1f
            invalidate()
            return
        }
        animator = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 2200
            repeatCount = ValueAnimator.INFINITE
            // The dashboard's easing, so the web and the phone accelerate the
            // same way.
            interpolator = PathInterpolator(0.4f, 0f, 0.2f, 1f)
            addUpdateListener {
                sweep = it.animatedValue as Float
                invalidate()
            }
            start()
        }
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        restart()
    }

    override fun onDetachedFromWindow() {
        animator?.cancel()
        animator = null
        super.onDetachedFromWindow()
    }

    override fun onDraw(canvas: Canvas) {
        if (length <= 0f) return
        canvas.drawPath(path, trackPaint)
        // A dash of "drawn so far, then nothing" is how you trim a stroked path
        // without rebuilding it every frame — the same trick as the web's
        // stroke-dashoffset.
        tracePaint.pathEffect =
            if (sweep >= 1f) null
            else DashPathEffect(floatArrayOf(length * sweep, length), 0f)
        canvas.drawPath(path, tracePaint)
    }

}
