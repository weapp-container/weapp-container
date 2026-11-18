package com.sonofmagic.weapp.container

import android.content.res.Configuration
import android.graphics.Point
import android.os.Build
import android.os.Looper
import android.view.View
import android.view.ViewTreeObserver
import android.view.WindowInsets
import org.json.JSONObject

/** Owns the example Activity's Decor Insets listener for its entire lifetime. */
internal class AndroidWindowObservationCollector(
    private val decor: View,
    private val surface: GlesSnapshotView,
    onObservation: (AndroidWindowObservation) -> Unit,
    private val onGeometryReady: () -> Unit,
    private val onError: (Throwable) -> Unit,
    private val onDiagnostic: (JSONObject) -> Unit,
) {
    private var closed = false
    private var lastError: String? = null
    private var lastPending: String? = null
    private val coordinator = WindowObservationCoordinator<WindowInsets, AndroidWindowObservation>(
        requestFrame = { if (!closed) decor.postInvalidateOnAnimation() },
        publish = { observation ->
            surface.acceptWindowObservation(observation)
            lastError = null
            lastPending = null
            reportReady()
            onObservation(observation)
        },
    )
    private val preDrawListener = ViewTreeObserver.OnPreDrawListener {
        if (!closed) {
            if (coordinator.afterLayout { incoming -> readAfterLayout(incoming) }) onGeometryReady()
            reportPending()
        }
        true
    }
    private val layoutListener = ViewTreeObserver.OnGlobalLayoutListener {
        if (!closed) coordinator.geometryChanged()
    }
    private val attachListener = object : View.OnAttachStateChangeListener {
        override fun onViewAttachedToWindow(view: View) {
            if (!closed) {
                // A new Window attachment cannot reuse the previous root's
                // Insets. A Surface-only recreation can retain this epoch.
                coordinator.refresh(force = true)
                view.requestApplyInsets()
            }
        }
        override fun onViewDetachedFromWindow(view: View) { coordinator.surfaceLost() }
    }

    init {
        // Child dispatch can stop at a fitsSystemWindows parent. Capture at
        // Decor before its default onApplyWindowInsets policy consumes data.
        // Never return raw Insets in place of the default Decor result.
        decor.setOnApplyWindowInsetsListener { view, incoming ->
            coordinator.dispatchInsets(WindowInsets(incoming)) { view.onApplyWindowInsets(incoming) }
        }
        decor.addOnAttachStateChangeListener(attachListener)
        decor.viewTreeObserver.addOnPreDrawListener(preDrawListener)
        decor.viewTreeObserver.addOnGlobalLayoutListener(layoutListener)
        surface.onSurfaceGeometryChanged = {
            if (surface.observedSurfaceExtent() == null) coordinator.surfaceLost()
            coordinator.geometryChanged()
        }
        decor.requestApplyInsets()
    }

    fun refresh(force: Boolean = false) {
        checkMainThread()
        if (closed) return
        coordinator.refresh(force)
        decor.requestApplyInsets()
        reportPending()
    }

    fun close() {
        checkMainThread()
        if (closed) return
        closed = true
        coordinator.close()
        decor.setOnApplyWindowInsetsListener(null)
        decor.removeOnAttachStateChangeListener(attachListener)
        if (decor.viewTreeObserver.isAlive) {
            decor.viewTreeObserver.removeOnPreDrawListener(preDrawListener)
            decor.viewTreeObserver.removeOnGlobalLayoutListener(layoutListener)
        }
        surface.onSurfaceGeometryChanged = null
    }

    private fun reportPending() {
        val reason = coordinator.pendingReason() ?: return
        if (reason == lastPending) return
        lastPending = reason
        onDiagnostic(JSONObject().put("schemaVersion", 1).put("status", "pending")
            .put("code", "WINDOW_OBSERVATION_PENDING").put("reason", reason)
            .put("insetsEpoch", coordinator.insetsEpoch))
    }

    private fun reportReady() {
        onDiagnostic(JSONObject().put("schemaVersion", 1).put("status", "ready")
            .put("code", "WINDOW_OBSERVATION_READY").put("insetsEpoch", coordinator.insetsEpoch)
            .put("insetsBoundary", "Decor incoming dispatch before default onApplyWindowInsets")
            .put("geometryBoundary", "preDraw after layout; holder SurfaceFrame/callback/View extent agree"))
    }

    @Suppress("DEPRECATION")
    private fun readAfterLayout(insets: WindowInsets): AndroidWindowObservation? {
        checkMainThread()
        // A preDraw listener can precede SurfaceView's own updateSurface.
        // Refuse an old buffer until its real callback/frame and new layout agree.
        if (!decor.isAttachedToWindow || !surface.isAttachedToWindow || decor.isLayoutRequested || surface.isLayoutRequested) return null
        val extent = surface.observedSurfaceExtent() ?: return null
        val actualDisplay = surface.display ?: return null
        return try {
            val screen = Point()
            actualDisplay.getRealSize(screen)
            val surfaceOrigin = IntArray(2)
            val windowOrigin = IntArray(2)
            surface.getLocationOnScreen(surfaceOrigin)
            decor.getLocationOnScreen(windowOrigin)
            val status: ObservedInsets
            val system: ObservedInsets
            val cutout: ObservedInsets
            val source: String
            if (Build.VERSION.SDK_INT >= 30) {
                val statusValue = insets.getInsetsIgnoringVisibility(WindowInsets.Type.statusBars())
                val systemValue = insets.getInsetsIgnoringVisibility(WindowInsets.Type.systemBars())
                val cutoutValue = insets.getInsetsIgnoringVisibility(WindowInsets.Type.displayCutout())
                status = ObservedInsets(statusValue.left, statusValue.top, statusValue.right, statusValue.bottom)
                system = ObservedInsets(systemValue.left, systemValue.top, systemValue.right, systemValue.bottom)
                cutout = ObservedInsets(cutoutValue.left, cutoutValue.top, cutoutValue.right, cutoutValue.bottom)
                source = "Decor incoming WindowInsets.getInsetsIgnoringVisibility(statusBars/systemBars/displayCutout)"
            } else {
                system = ObservedInsets(insets.stableInsetLeft, insets.stableInsetTop, insets.stableInsetRight, insets.stableInsetBottom)
                status = ObservedInsets(0, insets.stableInsetTop, 0, 0)
                val value = if (Build.VERSION.SDK_INT >= 28) insets.displayCutout else null
                cutout = if (value == null) ObservedInsets(0, 0, 0, 0)
                    else ObservedInsets(value.safeInsetLeft, value.safeInsetTop, value.safeInsetRight, value.safeInsetBottom)
                source = "Decor incoming WindowInsets.stableInsets; statusBarHeight uses stable top (API26-29 limitation)"
            }
            val orientation = when (surface.resources.configuration.orientation) {
                Configuration.ORIENTATION_PORTRAIT -> "portrait"
                Configuration.ORIENTATION_LANDSCAPE -> "landscape"
                else -> error("unknown configuration orientation")
            }
            AndroidWindowObservation(extent.first, extent.second, screen.x, screen.y,
                surface.resources.displayMetrics.density.toDouble(), actualDisplay.rotation, orientation,
                windowOrigin[0], windowOrigin[1], surfaceOrigin[0], surfaceOrigin[1], status, system, cutout, source)
        } catch (error: Throwable) {
            if (lastError != error.message) { lastError = error.message; onError(error) }
            null
        }
    }

    private fun checkMainThread() {
        check(Looper.myLooper() == Looper.getMainLooper()) { "window observation must stay on main thread" }
    }
}
