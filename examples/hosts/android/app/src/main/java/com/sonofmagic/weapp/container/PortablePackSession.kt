package com.sonofmagic.weapp.container

import java.nio.charset.StandardCharsets.UTF_8
import kotlin.math.hypot
import org.json.JSONArray
import org.json.JSONObject

/** One complete native transaction per operation. No view-node JNI calls. */
internal interface PortablePackSessionRuntime {
    fun dispatch(envelope: ByteArray): ByteArray
    fun resize(width: Int, height: Int): ByteArray
    fun updateWindowMetrics(metrics: ByteArray): ByteArray
    fun pollTimers(nowNs: Long): ByteArray
    fun presentationState(): ByteArray
    fun acknowledgePresentation(revision: Long): ByteArray
    fun inspect(): ByteArray
}

/** Immutable notification identifying a frame already owned by Rust. */
internal data class CommittedFrame(val sessionId: String, val frameId: Long, val viewRevision: Long, val renderRevision: Long,
    val width: Int, val height: Int) {
    companion object {
        fun parse(bytes: ByteArray): CommittedFrame {
            val value = JSONObject(bytes.toString(UTF_8))
            check(value.opt("schemaVersion") == 1) { "unsupported presentation metadata" }
            val frame = value.getJSONObject("frame")
            val viewport = frame.getJSONObject("viewport")
            val id = PortablePack.integer(frame.opt("frame_id"))
            val revision = PortablePack.integer(value.opt("viewRevision"))
            val renderRevision = PortablePack.integer(value.opt("renderRevision"))
            val width = PortablePack.integer(viewport.opt("width"))
            val height = PortablePack.integer(viewport.opt("height"))
            check(id != null && id > 0 && revision != null && revision >= 0 && renderRevision != null && renderRevision > 0 &&
                width != null && width in 1..Int.MAX_VALUE.toLong() && height != null && height in 1..Int.MAX_VALUE.toLong()) {
                "invalid committed frame metadata"
            }
            val window = value.getJSONObject("viewport")
            check(PortablePack.integer(window.opt("width")) == width && PortablePack.integer(window.opt("height")) == height) {
                "committed frame and host viewport differ"
            }
            return CommittedFrame(value.getString("sessionId"), id, revision, renderRevision, width.toInt(), height.toInt())
        }
    }
}

/**
 * Main-thread owner of an already started portable pack. Surface pixels,
 * committed hit tree, providers and AppService all refer to this one session.
 * The receipt is explicitly development diagnostics and excludes RGBA bytes.
 */
internal class PortablePackSession(
    private val started: PortablePackStartup,
    private val runtime: PortablePackSessionRuntime,
    initialPresentation: ByteArray,
    private val onFrame: (CommittedFrame) -> Unit,
    private val onReceipt: (JSONObject) -> Unit,
) {
    private val owner = Thread.currentThread()
    private var closed = false
    private var suspended = false
    private var presentationSuspended = false
    // app.lifecycle(launch) already invoked the initial App.onShow before
    // page.push. Taking ownership must not replay it after the first render.
    private var foreground = true
    private var revision = 0L
    private var sequence = 0L
    private var presentationSequence = 0L
    private var frameId = 1L
    private val render = started.renderPayload()
    private var width = render.getJSONObject("viewport").getInt("width")
    private var height = render.getJSONObject("viewport").getInt("height")
    private var surface = JSONObject.NULL as Any
    private var windowObservation: AndroidWindowObservation? = null
    private var inspected = JSONObject()
    private var committedFrame: CommittedFrame? = null
    private var presentationEffectsDirty = false
    private val operations = ArrayDeque<JSONObject>()
    private val lifecycle = ArrayDeque<JSONObject>()
    private val diagnostics = ArrayDeque<JSONObject>()
    private var pointer: Pointer? = null

    private data class Pointer(val id: Int, val x: Double, val y: Double, val timeMs: Long, var moved: Boolean = false)

    init {
        lifecycle.addLast(JSONObject().put("sequence", 0).put("event", "show").put("source", "launch"))
        validatePresentation(initialPresentation)
        inspect()
        publish()
    }

    fun canPumpTimers(): Boolean { checkOwner(); return !closed && !suspended && foreground }
    fun isRunnable(): Boolean { checkOwner(); return canPumpTimers() && !presentationSuspended }

    fun pointerOnSurface(action: String, id: Int, x: Double, y: Double, timeMs: Long, slop: Double) {
        checkOwner()
        val current = surface as? JSONObject ?: return
        val scaleX = width.toDouble() / current.getInt("width")
        val scaleY = height.toDouble() / current.getInt("height")
        pointer(action, id, x * scaleX, y * scaleY, timeMs, slop * maxOf(scaleX, scaleY))
    }

    fun setForeground(visible: Boolean) {
        checkOwner()
        if (closed || foreground == visible) return
        // Consume once before user hooks; a thrown callback must not replay a
        // platform lifecycle transition or leave a stale gesture active.
        foreground = visible
        pointer = null
        val event = if (visible) "show" else "hide"
        lifecycle.addLast(JSONObject().put("sequence", sequence + 1).put("event", event))
        while (lifecycle.size > 32) lifecycle.removeFirst()
        transaction {
            val payload = JSONObject().put("event", event)
            if (visible) payload.put("options", JSONObject().put("path", started.route))
            dispatch("app.lifecycle", payload)
            if (visible) renderFrame()
        }
    }

    fun resize(physicalWidth: Int, physicalHeight: Int, density: Double, screenX: Int, screenY: Int) {
        checkOwner()
        check(physicalWidth > 0 && physicalHeight > 0 && density.isFinite() && density > 0) { "invalid surface geometry" }
        val logicalWidth = kotlin.math.floor(physicalWidth / density + 0.5)
        val logicalHeight = kotlin.math.floor(physicalHeight / density + 0.5)
        check(logicalWidth in 1.0..Int.MAX_VALUE.toDouble() && logicalHeight in 1.0..Int.MAX_VALUE.toDouble()) { "invalid logical surface geometry" }
        val prior = surface as? JSONObject
        surface = JSONObject().put("width", physicalWidth).put("height", physicalHeight).put("density", density)
            .put("screenX", screenX).put("screenY", screenY)
            .put("presentedFrameId", prior?.opt("presentedFrameId") ?: 0)
            .put("presentationSequence", presentationSequence).put("backend", prior?.opt("backend") ?: JSONObject.NULL)
        pointer = null
        if (closed) return
        if (width == logicalWidth.toInt() && height == logicalHeight.toInt()) { publish(); return }
        transaction {
            val request = JSONObject().put("width", logicalWidth).put("height", logicalHeight)
            val response = runtime.resize(logicalWidth.toInt(), logicalHeight.toInt())
            record("host.resize", request, response)
            validateBatch(response)
            width = logicalWidth.toInt()
            height = logicalHeight.toInt()
            renderFrame()
        }
    }

    /** Insets/density/display changes cross native even when viewport is unchanged. */
    fun updateWindowObservation(observation: AndroidWindowObservation): Boolean {
        checkOwner()
        if (closed || suspended) return false
        if (windowObservation == observation) return true
        transaction {
            val response = runtime.updateWindowMetrics(observation.metrics().toString().toByteArray(UTF_8))
            record("host.windowMetrics", observation.metrics(), response)
            validateBatch(response)
            val viewportChanged = width != observation.windowWidth || height != observation.windowHeight
            windowObservation = observation
            val prior = surface as? JSONObject
            surface = observation.geometry().put("presentedFrameId", prior?.opt("presentedFrameId") ?: 0)
                .put("presentationSequence", presentationSequence).put("backend", prior?.opt("backend") ?: JSONObject.NULL)
            pointer = null
            width = observation.windowWidth
            height = observation.windowHeight
            if (viewportChanged) renderFrame()
        }
        return !closed && !suspended
    }

    /** A resumed App/Page must observe current metrics in its onShow hook. */
    fun synchronizeWindow(observation: AndroidWindowObservation, visible: Boolean) {
        checkOwner()
        if (updateWindowObservation(observation)) setForeground(visible)
    }

    /** Called only after the owning window successfully swaps this frame. */
    fun presented(presentedFrameId: Long, backend: String, geometry: JSONObject) {
        checkOwner()
        if (closed) return
        if (presentedFrameId != frameId) {
            reportPresentationFailure(IllegalStateException("presented frame $presentedFrameId differs from committed $frameId"))
            return
        }
        presentationSequence += 1
        surface = JSONObject(geometry.toString()).put("presentedFrameId", presentedFrameId)
            .put("presentationSequence", presentationSequence).put("backend", backend)
        try {
            val committed = checkNotNull(committedFrame) { "presentation has no committed metadata" }
            val response = runtime.acknowledgePresentation(committed.renderRevision)
            record("host.presentation", JSONObject().put("renderRevision", committed.renderRevision).put("gpuCompletion", "not-waited"), response)
            validateBatch(response)
            val current = CommittedFrame.parse(runtime.presentationState())
            check(current.sessionId == started.sessionId && current.renderRevision == committed.renderRevision) {
                "presentation acknowledgement changed the committed frame"
            }
            presentationEffectsDirty = current.viewRevision != committed.viewRevision
            presentationSuspended = false
            inspect()
            publish()
        } catch (error: Throwable) { reportPresentationFailure(error) }
    }

    fun surfaceLost() {
        checkOwner()
        if (closed) return
        val previous = surface as? JSONObject ?: return
        surface = JSONObject(previous.toString()).put("presentedFrameId", 0).put("backend", JSONObject.NULL)
        publish()
    }

    /** Single pointer only. A second contact cancels the gesture explicitly. */
    fun pointer(action: String, id: Int, x: Double, y: Double, timeMs: Long, slop: Double) {
        checkOwner()
        if (!isRunnable()) return
        if (!x.isFinite() || !y.isFinite() || !slop.isFinite() || slop < 0) { fail(IllegalArgumentException("invalid pointer coordinates")); return }
        val current = pointer
        val events = JSONArray()
        fun event(type: String, contact: Pointer, active: Boolean): JSONObject {
            val touch = JSONObject().put("identifier", contact.id).put("clientX", x).put("clientY", y).put("pageX", x).put("pageY", y)
            return JSONObject().put("type", type).put("x", x).put("y", y).put("timeStamp", timeMs)
                .put("detail", if (type == "tap") JSONObject().put("x", x).put("y", y) else JSONObject())
                .put("touches", if (active) JSONArray().put(touch) else JSONArray())
                .put("changedTouches", JSONArray().put(touch))
        }
        when (action) {
            "down" -> {
                if (current != null) return
                val next = Pointer(id, x, y, timeMs)
                pointer = next
                events.put(event("touchstart", next, true))
            }
            "move" -> {
                if (current == null || current.id != id) return
                current.moved = current.moved || hypot(x - current.x, y - current.y) > slop
                events.put(event("touchmove", current, true))
            }
            "up" -> {
                pointer = null
                if (current == null || current.id != id) return
                events.put(event("touchend", current, false))
                if (!current.moved && hypot(x - current.x, y - current.y) <= slop && timeMs - current.timeMs in 0..500) {
                    events.put(event("tap", current, false))
                }
            }
            "cancel", "multiple" -> {
                pointer = null
                if (current == null) return
                events.put(event("touchcancel", current, false))
            }
            else -> { fail(IllegalArgumentException("unsupported pointer action $action")); return }
        }
        transaction {
            dispatch("event.batch", JSONObject().put("events", events))
            renderFrame()
        }
    }

    /** Unix epoch nanoseconds; never a Choreographer/uptime/elapsed timestamp. */
    fun pollTimers(nowNs: Long) {
        checkOwner()
        if (!canPumpTimers()) return
        try {
            require(nowNs >= 0) { "ERR_ENGINE: timer clock must be non-negative Unix epoch nanoseconds" }
            val response = runtime.pollTimers(nowNs)
            val messages = validateBatch(response)
            if (messages.length() == 0 && !presentationEffectsDirty) return // Never write 60 empty receipts/s.
            record("host.pollTimers", JSONObject().put("nowNs", nowNs), response)
            if (!presentationSuspended) renderFrame()
            inspect()
            publish()
        } catch (error: Throwable) { fail(error) }
    }

    fun close() {
        checkOwner()
        if (closed) return
        pointer = null
        foreground = false
        transaction { dispatch("app.lifecycle", JSONObject().put("event", "unload")) }
        closed = true
        publish()
    }

    fun reportFailure(error: Throwable) { checkOwner(); if (!closed) fail(error) }

    /** Surface/submit failures suspend input and redraws, never the JS clock. */
    fun reportPresentationFailure(error: Throwable) {
        checkOwner()
        if (closed) return
        presentationSuspended = true
        pointer = null
        remember(error, "presentation")
        publish()
    }

    /** The embedding owner first restores its surface, then explicitly retries. */
    fun retryPresentation() {
        checkOwner()
        if (!canPumpTimers()) return
        transaction { renderFrame(retry = true) }
    }

    private fun renderFrame(retry: Boolean = false) {
        if (presentationSuspended && !retry) return
        presentationEffectsDirty = false
        val candidate = frameId + 1
        val payload = JSONObject(render.toString()).put("frameId", candidate)
            .put("viewport", JSONObject().put("x", 0).put("y", 0).put("width", width).put("height", height))
        val body = dispatch("render.commit", payload)
        check(body.opt("committed") == true && body.optString("source") == "manifest" &&
            PortablePack.integer(body.opt("frameId")) == candidate) { "manifest render did not commit requested frame" }
        frameId = candidate
        // inspect before publishing/presenting so the receipt cannot pair new
        // pixels with an old hit tree, even on a synchronous Surface callback.
        val next = validatePresentation(runtime.presentationState())
        inspect()
        try { onFrame(next) } catch (error: Throwable) { reportPresentationFailure(error) }
    }

    private fun dispatch(op: String, payload: JSONObject): JSONObject {
        val requestId = "android-session-${sequence + 1}"
        val envelope = JSONObject().put("protocolVersion", "1.0").put("sessionId", started.sessionId)
            .put("requestId", requestId).put("kind", "request").put("op", op).put("payload", payload)
        val response = runtime.dispatch(envelope.toString().toByteArray(UTF_8))
        record(op, envelope, response)
        val messages = validateBatch(response)
        val matches = (0 until messages.length()).map { messages.getJSONObject(it) }.filter {
            it.optString("kind") == "response" && it.optString("requestId") == requestId && it.optString("op") == op &&
                it.optString("sessionId") == started.sessionId && it.optString("protocolVersion") == "1.0"
        }
        check(matches.size == 1) { "$op missing unique correlated acknowledgement" }
        return matches.single().getJSONObject("payload")
    }

    private fun validateBatch(bytes: ByteArray): JSONArray {
        val batch = JSONObject(bytes.toString(UTF_8))
        check(batch.opt("ok") != false) { "native transaction failed: ${batch.opt("error") ?: batch}" }
        val messages = batch.getJSONArray("messages")
        for (index in 0 until messages.length()) {
            val message = messages.getJSONObject(index)
            check(message.optString("sessionId") == started.sessionId) { "native batch belongs to another session" }
            val payload = message.optJSONObject("payload")
            check(message.optString("op") != "error" && !(message.optString("kind") == "response" && payload?.opt("ok") == false)) {
                "native batch failed: ${payload ?: message}"
            }
        }
        return messages
    }

    private fun record(op: String, request: JSONObject, bytes: ByteArray) {
        sequence += 1
        operations.addLast(JSONObject().put("sequence", sequence).put("op", op).put("request", request)
            .put("response", JSONObject(bytes.toString(UTF_8))))
        while (operations.size > 128) operations.removeFirst()
    }

    private fun validatePresentation(bytes: ByteArray): CommittedFrame {
        val next = CommittedFrame.parse(bytes)
        check(next.sessionId == started.sessionId && next.frameId == frameId && next.width == width && next.height == height) {
            "presentation does not match committed frame"
        }
        check(next.viewRevision >= (committedFrame?.viewRevision ?: 0)) { "presentation revision moved backwards" }
        committedFrame = next
        return next
    }

    private fun inspect() {
        val value = JSONObject(runtime.inspect().toString(UTF_8))
        check(value.getString("sessionId") == started.sessionId) { "inspection belongs to another session" }
        val frame = value.getJSONObject("frame")
        check(PortablePack.integer(frame.opt("frame_id")) == frameId) { "inspection is not the committed frame" }
        inspected = value
    }

    private inline fun transaction(operation: () -> Unit) {
        try { operation(); inspect(); publish() } catch (error: Throwable) { fail(error) }
    }

    private fun fail(error: Throwable) {
        suspended = true
        pointer = null
        remember(error, "runtime")
        // A render can commit before a later hook/exception. Inspection is
        // authoritative; never claim the last presented frame is that commit.
        runCatching { inspected = JSONObject(runtime.inspect().toString(UTF_8)) }
        publish()
    }

    private fun remember(error: Throwable, phase: String) {
        diagnostics.addLast(JSONObject().put("sequence", sequence).put("phase", phase).put("message", error.message ?: error.javaClass.simpleName))
        while (diagnostics.size > 16) diagnostics.removeFirst()
    }

    private fun publish() {
        revision += 1
        onReceipt(JSONObject().put("schemaVersion", 1).put("sessionId", started.sessionId).put("engine", started.engine)
            .put("manifestIntegrity", started.integrityRoot).put("status", if (closed) "closed" else if (suspended || presentationSuspended || !foreground) "suspended" else "ready")
            .put("runtimeFailed", suspended).put("presentationSuspended", presentationSuspended)
            .put("foreground", foreground)
            .put("revision", revision).put("viewport", JSONObject().put("width", width).put("height", height))
            .put("hostWindow", inspected.opt("viewport") ?: JSONObject.NULL).put("surface", surface)
            .put("windowObservation", windowObservation?.raw() ?: JSONObject.NULL)
            .put("displayMetrics", inspected.opt("displayMetrics") ?: JSONObject.NULL)
            .put("page", inspected.opt("page") ?: JSONObject.NULL).put("frame", inspected.opt("frame") ?: JSONObject.NULL)
            .put("snapshot", JSONObject.NULL)
            .put("presentation", committedFrame?.let { JSONObject().put("frameId", it.frameId).put("viewRevision", it.viewRevision)
                .put("renderRevision", it.renderRevision)
                .put("width", it.width).put("height", it.height).put("transport", "frame-metadata") } ?: JSONObject.NULL)
            .put("operations", JSONArray(operations.toList()))
            .put("lifecycle", JSONArray(lifecycle.toList())).put("diagnostics", JSONArray(diagnostics.toList()))
            .put("limitations", JSONArray(listOf("single-pointer/tap only; no multi-touch/scroll/longpress gesture recognizer", "native touch target capture and continuous media-query observers remain partial"))))
    }

    private fun checkOwner() { check(Thread.currentThread() === owner) { "native session must stay on its owner thread" } }
}
