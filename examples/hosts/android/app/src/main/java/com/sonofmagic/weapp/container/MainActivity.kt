package com.sonofmagic.weapp.container

import android.app.Activity
import android.content.pm.ApplicationInfo
import android.content.res.Configuration
import android.os.Bundle
import android.util.Log
import android.view.Choreographer
import java.io.File
import java.nio.charset.StandardCharsets.UTF_8
import java.util.UUID
import org.json.JSONObject

/** The Activity main thread owns the isolate, EGL context and all bridge calls. */
class MainActivity : Activity() {
    private var handle: Long = 0
    private var surfaceView: GlesSnapshotView? = null
    private var windowObservations: AndroidWindowObservationCollector? = null
    private var glesRuntimeAttached = false
    private var startup: PortablePackStartup? = null
    private var live: PortablePackSession? = null
    private var resumed = false
    private var startupReceiptFrozen = false
    private var startupWindowObservation: AndroidWindowObservation? = null
    private var sessionId = "android-${UUID.randomUUID()}"
    private var frameScheduled = false
    private val frameCallback = object : Choreographer.FrameCallback {
        override fun doFrame(frameTimeNanos: Long) {
            frameScheduled = false
            if (!resumed || handle == 0L) return
            // frameTimeNanos is uptime, while native/JS timer deadlines are
            // Unix epoch time. Sample the wall clock when the pump executes.
            try { live?.pollTimers(UnixTimerClock.nowNs()) }
            catch (error: Throwable) { live?.reportFailure(error) }
            scheduleFrame()
        }
    }

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        val engine = intent.getStringExtra("weappContainerEngine") ?: "quickjs"
        val fixtureId = intent.getStringExtra("weappContainerFixtureId") ?: "portable-pack-reference-v1"
        sessionId = intent.getStringExtra("weappContainerSessionId") ?: sessionId
        for (base in listOf("portable-pack-execution.json", "portable-pack-interaction.json")) {
            for (name in listOf(base, "$base.pending")) {
                val stale = File(filesDir, name)
                check(!stale.exists() || stale.delete()) { "cannot clear stale execution receipt" }
            }
        }
        handle = nativeCreate()
        check(handle != 0L) { "native runtime creation failed" }
        val pack = PortablePack.load { path -> assets.open("portable-pack/$path").use { it.readBytes() } }
        val presenter = GlesSnapshotView(this)
        surfaceView = presenter
        presenter.onContextProbe = { probe -> Log.i("WEAPP_CONTAINER_GPU_PROBE", probe.toString()) }
        presenter.onProbe = { probe ->
            if (!startupReceiptFrozen) {
                startup?.surfaceIdentity()?.let { identity ->
                    val keys = identity.keys()
                    while (keys.hasNext()) { val key = keys.next(); probe.put(key, identity.get(key)) }
                }
                writeExecutionReceipt(probe)
                if (probe.optString("status") == "passed") startupReceiptFrozen = true
            }
            Log.i("WEAPP_CONTAINER_SURFACE_PROBE", probe.toString())
            // Terminal failure handling has its own required callback below.
        }
        presenter.onRuntimeContextReady = {
            val result = nativeAttachGlesContext(handle)
            glesRuntimeAttached = result == 0
            if (!glesRuntimeAttached) Log.w("WEAPP_CONTAINER_SURFACE_ATTACH", "Skia GLES context attach failed: $result")
            glesRuntimeAttached
        }
        presenter.onRuntimeFrame = { framebuffer, width, height ->
            if (!glesRuntimeAttached || nativeRenderGlesFramebuffer(handle, framebuffer, width, height) != 0) false
            else {
                val runtime = JSONObject(nativeCapabilities(handle).toString(UTF_8)).getJSONObject("runtime")
                runtime.optBoolean("gpuSurface") && runtime.optString("renderer") == "skia-gpu-gles"
            }
        }
        presenter.onRuntimeContextLost = { mode ->
            try {
                val result = when (mode) {
                    EglContextReleaseMode.DETACH_CURRENT -> nativeDetachGlesContext(handle)
                    EglContextReleaseMode.ABANDON -> nativeAbandonGlesContext(handle)
                }
                check(result == 0) { "Skia GLES context $mode failed: $result" }
            } finally { glesRuntimeAttached = false }
        }
        presenter.onFailure = { error ->
            Log.e("WEAPP_CONTAINER_SURFACE_FAILURE", "presentation suspended; runtime timers remain active", error)
            live?.reportPresentationFailure(error) ?: throw error
        }
        presenter.onPresented = { frameId, backend, geometry -> live?.presented(frameId, backend, geometry) }
        presenter.onSurfaceLost = { live?.surfaceLost() }
        presenter.onPointer = { action, id, x, y, timeMs, slop -> live?.pointerOnSurface(action, id, x, y, timeMs, slop) }
        windowObservations = AndroidWindowObservationCollector(window.decorView, presenter,
            onError = { error ->
                Log.e("WEAPP_CONTAINER_WINDOW_OBSERVATION", "invalid actual window observation", error)
                live?.reportFailure(error)
            },
            onGeometryReady = { if (live?.isRunnable() == true) presenter.presentLatestIfNeeded() },
            onDiagnostic = { diagnostic -> Log.i("WEAPP_CONTAINER_WINDOW_OBSERVATION", diagnostic.toString()) },
            onObservation = { observation ->
            if (live == null) {
                startupWindowObservation = observation
                // Modules execute only after Surface extent, Display, density,
                // orientation and actual Decor incoming WindowInsets are observed.
                val started = pack.start(object : PortablePackRuntime {
                    override fun loadManifest(manifest: ByteArray, config: ByteArray): ByteArray = nativeLoadManifestWithConfig(handle, manifest, config)
                    override fun dispatch(envelope: ByteArray): ByteArray = nativeDispatch(handle, envelope)
                }, width = observation.windowWidth, height = observation.windowHeight, engine = engine,
                    sessionId = sessionId, fixtureId = fixtureId, windowObservation = observation,
                    pageRenderMode = "native-gpu", onOperation = ::logOperation)
                val snapshot = nativeRenderSnapshot(handle)
                started.recordSnapshot(snapshot)
                startup = started
                writeExecutionReceipt()
                live = PortablePackSession(started, object : PortablePackSessionRuntime {
                    override fun dispatch(envelope: ByteArray): ByteArray = nativeDispatch(handle, envelope)
                    override fun resize(width: Int, height: Int): ByteArray = nativeResizeViewport(handle, width, height)
                    override fun updateWindowMetrics(metrics: ByteArray): ByteArray = nativeUpdateWindowMetrics(handle, metrics)
                    override fun pollTimers(nowNs: Long): ByteArray = nativePollTimers(handle, nowNs)
                    override fun presentationState(): ByteArray = nativePresentationState(handle)
                    override fun acknowledgePresentation(revision: Long): ByteArray = nativeAcknowledgePresentation(handle, revision)
                    override fun inspect(): ByteArray = if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
                        nativeInspectState(handle) else nativePresentationState(handle)
                }, nativePresentationState(handle), onFrame = presenter::presentFrame, onReceipt = ::writeInteractionReceipt)
                live!!.synchronizeWindow(observation, resumed)
                presenter.markRuntimeSessionReady()
                presenter.presentFrame(CommittedFrame.parse(nativePresentationState(handle)))
                logOperation("render.snapshot", started.snapshotSummary())
                // Separate API probes cannot replace the manifest frame.
                val canvas = JSONObject().put("name", "wx.canvas.draw").put("canvasId", "main").put("width", 1).put("height", 1)
                    .put("commands", org.json.JSONArray("""[{"op":"setFillStyle","args":["#0a141e"]},{"op":"fillRect","args":[0,0,1,1]}]"""))
                logOperation("canvas.draw", nativeDispatch(handle, apiEnvelope("android-canvas", canvas)))
                logOperation("canvas.snapshot", nativeCanvasSnapshot(handle, "main".toByteArray(UTF_8)))
                logOperation("api.call", nativeDispatch(handle, apiEnvelope("android-api", JSONObject().put("name", "wx.canIUse").put("capability", "wx.getStorage"))))
            } else {
                live!!.synchronizeWindow(observation, resumed)
            }
            scheduleFrame()
        })
        setContentView(presenter)
        logOperation("capabilities", nativeCapabilities(handle))
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        // A paused window may have changed density/extent/insets. Resume
        // user hooks only after a new valid observation refreshes native APIs.
        windowObservations?.refresh(force = true)
        scheduleFrame()
    }

    override fun onConfigurationChanged(configuration: Configuration) {
        super.onConfigurationChanged(configuration)
        windowObservations?.refresh()
    }

    override fun onPause() {
        resumed = false
        Choreographer.getInstance().removeFrameCallback(frameCallback)
        frameScheduled = false
        live?.setForeground(false)
        super.onPause()
    }

    override fun onDestroy() {
        resumed = false
        Choreographer.getInstance().removeFrameCallback(frameCallback)
        frameScheduled = false
        try { live?.close() } finally {
            live = null
            try {
                windowObservations?.close()
                windowObservations = null
                surfaceView?.close()
            } finally {
                surfaceView = null
                if (handle != 0L) { nativeFree(handle); handle = 0 }
                startup = null
                super.onDestroy()
            }
        }
    }

    private fun scheduleFrame() {
        if (!frameScheduled && resumed && live?.canPumpTimers() == true && handle != 0L) {
            frameScheduled = true
            Choreographer.getInstance().postFrameCallback(frameCallback)
        }
    }

    /** Embedding UI may invoke this after resolving a surface/context fault. */
    fun retryPresentation() {
        check(android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) { "presentation retry requires the main thread" }
        if (!resumed || live?.canPumpTimers() != true) return
        if (surfaceView?.preparePresentationRetry() == true) live?.retryPresentation()
        scheduleFrame()
    }

    private fun logOperation(operation: String, payload: ByteArray) {
        check(payload.isNotEmpty()) { "$operation returned an empty response" }
        Log.i("WEAPP_CONTAINER_SMOKE", "$operation bytes=${payload.size} json=${payload.toString(UTF_8)}")
    }

    private fun atomicReceipt(name: String, value: JSONObject) {
        val target = File(filesDir, name)
        val pending = File(filesDir, "$name.pending")
        pending.outputStream().use { stream -> stream.write(value.toString().toByteArray(UTF_8)); stream.flush(); stream.fd.sync() }
        check(pending.renameTo(target)) { "cannot atomically publish $name" }
    }

    private fun writeExecutionReceipt(probe: JSONObject? = null) {
        if (startupReceiptFrozen) return
        val evidence = (startup ?: return).executionEvidence(probe)
        val receipt = evidence.getJSONArray("receipts").getJSONObject(0).put("schemaVersion", 1).put("fixture", evidence.getJSONObject("fixture"))
        receipt.put("windowObservation", startupWindowObservation?.raw() ?: JSONObject.NULL)
            .put("displayMetrics", JSONObject(nativeInspectState(handle).toString(UTF_8)).opt("displayMetrics") ?: JSONObject.NULL)
        atomicReceipt("portable-pack-execution.json", receipt)
    }

    private fun writeInteractionReceipt(receipt: JSONObject) {
        // This App is an embedding example. Page state and layout diagnostics
        // are persisted only for debuggable development builds.
        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) atomicReceipt("portable-pack-interaction.json", receipt)
    }

    private fun apiEnvelope(requestId: String, payload: JSONObject): ByteArray = JSONObject()
        .put("protocolVersion", "1.0").put("sessionId", sessionId).put("requestId", requestId)
        .put("kind", "request").put("op", "api.call").put("payload", payload).toString().toByteArray(UTF_8)

    private external fun nativeCreate(): Long
    private external fun nativeCapabilities(handle: Long): ByteArray
    private external fun nativeLoadManifestWithConfig(handle: Long, manifest: ByteArray, config: ByteArray): ByteArray
    private external fun nativeDispatch(handle: Long, envelope: ByteArray): ByteArray
    private external fun nativeRenderSnapshot(handle: Long): ByteArray
    private external fun nativePresentationState(handle: Long): ByteArray
    private external fun nativeAcknowledgePresentation(handle: Long, revision: Long): ByteArray
    private external fun nativeInspectState(handle: Long): ByteArray
    private external fun nativeResizeViewport(handle: Long, width: Int, height: Int): ByteArray
    private external fun nativeUpdateWindowMetrics(handle: Long, observation: ByteArray): ByteArray
    private external fun nativePollTimers(handle: Long, nowNs: Long): ByteArray
    private external fun nativeCanvasSnapshot(handle: Long, canvasId: ByteArray): ByteArray
    private external fun nativeAttachGlesContext(handle: Long): Int
    private external fun nativeRenderGlesFramebuffer(handle: Long, framebuffer: Int, width: Int, height: Int): Int
    private external fun nativeDetachGlesContext(handle: Long): Int
    private external fun nativeAbandonGlesContext(handle: Long): Int
    private external fun nativeFree(handle: Long)

    companion object { init { System.loadLibrary("weapp_container") } }
}
