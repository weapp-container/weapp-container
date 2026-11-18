package com.sonofmagic.weapp.container

import android.content.Context
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLContext
import android.opengl.EGLDisplay
import android.opengl.EGLSurface
import android.opengl.GLES20
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.MotionEvent
import android.view.ViewConfiguration
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import org.json.JSONArray
import org.json.JSONObject

/**
 * Presents Rust-owned frames directly through an Android window surface.
 *
 * Rust owns the committed manifest frame. With an attached Skia GLES context,
 * it draws that same frame into this window's framebuffer. The explicit
 * fallback uploads one complete RGBA snapshot; its receipt never claims a
 * GPU-owned container surface.
 */
class GlesSnapshotView(context: Context) : SurfaceView(context), SurfaceHolder.Callback {
    private var display: EGLDisplay = EGL14.EGL_NO_DISPLAY
    private var eglContext: EGLContext = EGL14.EGL_NO_CONTEXT
    private var eglSurface: EGLSurface = EGL14.EGL_NO_SURFACE
    private var config: EGLConfig? = null
    private var program = 0
    private var texture = 0
    private var surfaceWidth = 0
    private var surfaceHeight = 0
    private var framebuffer = 0
    private data class Presentation(val frameId: Long, val width: Int, val height: Int, val softwareSnapshot: ByteArray? = null)
    private var latestFrame: Presentation? = null
    private var probeBackend: String? = null
    // Surface creation and runtime manifest loading are asynchronous and may
    // complete in either order. Keep the readiness bit in the presenter so a
    // SurfaceView created before `app.init` can attach the Rust GLES context
    // as soon as the session becomes available, instead of permanently
    // falling back to snapshot upload after a transient ERR_NOT_LOADED.
    private var runtimeSessionReady = false
    private val runtimeAttachment = EglRuntimeAttachment()
    private var latestWindowObservation: AndroidWindowObservation? = null
    private var presentationPending = true
    private var drawableObservation: JSONObject? = null
    private val drawableGate = EglDrawableGate()

    private val vertexBuffer: FloatBuffer = floatBuffer(
        floatArrayOf(-1f, -1f, 1f, -1f, -1f, 1f, 1f, 1f),
    )
    // Flip the source row order so the top-left origin in RenderSnapshot is
    // displayed with Android's bottom-left GL texture coordinates.
    private val texCoordBuffer: FloatBuffer = floatBuffer(
        floatArrayOf(0f, 1f, 1f, 1f, 0f, 0f, 1f, 0f),
    )

    var onProbe: ((JSONObject) -> Unit)? = null
    /** Context evidence from the actual window owner, separate from rendering. */
    var onContextProbe: ((JSONObject) -> Unit)? = null
    /** Called while the EGL context is current, once per surface creation. */
    var onRuntimeContextReady: (() -> Boolean)? = null
    /** Draw one frame through the Rust Skia GLES path while EGL is current. */
    var onRuntimeFrame: ((framebuffer: Int, width: Int, height: Int) -> Boolean)? = null
    /** Normal current-context release and no-current abandonment are distinct operations. */
    internal var onRuntimeContextLost: ((EglContextReleaseMode) -> Unit)? = null
    /** Required presentation failure sink; the owner keeps business timers alive. */
    internal var onFailure: ((Throwable) -> Unit)? = null
    /** Surface readiness only; Window/Insets collection belongs to the Activity. */
    internal var onSurfaceGeometryChanged: (() -> Unit)? = null
    var onPresented: ((frameId: Long, backend: String, geometry: JSONObject) -> Unit)? = null
    var onSurfaceLost: (() -> Unit)? = null
    var onPointer: ((action: String, id: Int, x: Double, y: Double, timeMs: Long, slop: Double) -> Unit)? = null

    init {
        holder.addCallback(this)
        setZOrderOnTop(false)
        isClickable = true
    }

    /** Ready only when actual holder buffer, callback size and current layout agree. */
    internal fun observedSurfaceExtent(): Pair<Int, Int>? {
        if (!isAttachedToWindow || !holder.surface.isValid || isLayoutRequested || surfaceWidth <= 0 || surfaceHeight <= 0) return null
        val frame = holder.surfaceFrame
        if (frame.width() != surfaceWidth || frame.height() != surfaceHeight || width != surfaceWidth || height != surfaceHeight) return null
        return surfaceWidth to surfaceHeight
    }

    internal fun acceptWindowObservation(observation: AndroidWindowObservation) {
        check(observedSurfaceExtent() == (observation.surfaceWidth to observation.surfaceHeight)) { "surface changed before window observation commit" }
        latestWindowObservation = observation
    }

    /** Re-present a replacement Surface even when native session/viewport is unchanged. */
    @Synchronized
    internal fun presentLatestIfNeeded() {
        if (!presentationPending || !runtimeSessionReady || latestWindowObservation == null) return
        if (eglSurface == EGL14.EGL_NO_SURFACE || display == EGL14.EGL_NO_DISPLAY) return
        latestFrame?.let(::drawFrame)
    }

    /** Called by an explicit host retry, never by the timer pump. */
    @Synchronized
    internal fun preparePresentationRetry(): Boolean {
        if (!runtimeSessionReady || latestWindowObservation == null || observedSurfaceExtent() == null) return false
        return try {
            if (display == EGL14.EGL_NO_DISPLAY || eglSurface == EGL14.EGL_NO_SURFACE) {
                releaseEgl()
                createEgl(holder.surface)
            }
            attachRuntimeIfReady()
            true
        } catch (error: Throwable) { failPresentation(error); false }
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        val callback = onPointer ?: return false
        val action = when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> "down"
            MotionEvent.ACTION_MOVE -> "move"
            MotionEvent.ACTION_UP -> "up"
            MotionEvent.ACTION_CANCEL -> "cancel"
            MotionEvent.ACTION_POINTER_DOWN -> "multiple"
            else -> return true
        }
        callback(action, event.getPointerId(0), event.getX(0).toDouble(), event.getY(0).toDouble(),
            event.eventTime, ViewConfiguration.get(context).scaledTouchSlop.toDouble())
        if (event.actionMasked == MotionEvent.ACTION_UP) performClick()
        return true
    }

    override fun performClick(): Boolean { super.performClick(); return true }

    @Synchronized
    fun present(snapshot: ByteArray) {
        val json = JSONObject(snapshot.toString(Charsets.UTF_8))
        present(Presentation(json.getLong("frame_id"), json.getInt("width"), json.getInt("height"), snapshot.copyOf()))
    }

    /** Production GPU path carries metadata only; it cannot upload fallback pixels. */
    @Synchronized
    internal fun presentFrame(frame: CommittedFrame) {
        present(Presentation(frame.frameId, frame.width, frame.height))
    }

    private fun present(frame: Presentation) {
        latestFrame = frame
        if (eglSurface != EGL14.EGL_NO_SURFACE && display != EGL14.EGL_NO_DISPLAY) drawFrame(frame)
    }

    /**
     * Tell the presenter that the Rust session has loaded its manifest.
     *
     * Android may dispatch `surfaceCreated` before the asynchronous activity
     * setup has loaded the portable pack. Calling this method after
     * `nativeLoadManifest` makes the direct Skia GLES path order-independent:
     * it attaches immediately when an EGL context already exists, or the
     * next `surfaceCreated` callback attaches it later.
     */
    @Synchronized
    fun markRuntimeSessionReady() {
        runtimeSessionReady = true
        attachRuntimeIfReady()
        latestFrame?.let { frame ->
            if (eglSurface != EGL14.EGL_NO_SURFACE && display != EGL14.EGL_NO_DISPLAY) {
                drawFrame(frame)
            }
        }
    }

    @Synchronized
    override fun surfaceCreated(holder: SurfaceHolder) {
        try {
            // Even an equal-size replacement owns a fresh drawable. Invalidate
            // the old receipt and require its actual surfaceChanged callback.
            invalidatePresentation()
            surfaceWidth = 0
            surfaceHeight = 0
            latestWindowObservation = null
            releaseEgl()
            createEgl(holder.surface)
        } catch (error: Throwable) {
            failPresentation(error)
        }
    }

    @Synchronized
    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
        try {
            if (surfaceWidth != width || surfaceHeight != height) {
                latestWindowObservation = null
                invalidatePresentation()
            }
            surfaceWidth = width
            surfaceHeight = height
            presentationPending = true
            onSurfaceGeometryChanged?.invoke()
        } catch (error: Throwable) { failPresentation(error) }
    }

    @Synchronized
    override fun surfaceDestroyed(holder: SurfaceHolder) {
        try {
            runEglCleanup(
                ::invalidatePresentation,
                ::releaseEgl,
                {
                    surfaceWidth = 0
                    surfaceHeight = 0
                    latestWindowObservation = null
                    onSurfaceGeometryChanged?.invoke()
                },
            )
        } catch (error: Throwable) { failPresentation(error) }
    }

    @Synchronized
    fun close() {
        holder.removeCallback(this)
        try { runEglCleanup(::invalidatePresentation, ::releaseEgl) } finally {
            latestFrame = null
            presentationPending = false
            runtimeSessionReady = false
            onPointer = null
            onSurfaceGeometryChanged = null
            onPresented = null
            onSurfaceLost = null
            onRuntimeContextReady = null
            onRuntimeContextLost = null
            onRuntimeFrame = null
            onFailure = null
            latestWindowObservation = null
        }
    }

    private fun createEgl(nativeSurface: android.view.Surface) {
        display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
        check(display != EGL14.EGL_NO_DISPLAY) { "eglGetDisplay failed: ${EGL14.eglGetError()}" }
        val versions = IntArray(2)
        check(EGL14.eglInitialize(display, versions, 0, versions, 1)) {
            "eglInitialize failed: ${EGL14.eglGetError()}"
        }
        val attributes = intArrayOf(
            EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
            EGL14.EGL_SURFACE_TYPE, EGL14.EGL_WINDOW_BIT,
            EGL14.EGL_RED_SIZE, 8,
            EGL14.EGL_GREEN_SIZE, 8,
            EGL14.EGL_BLUE_SIZE, 8,
            EGL14.EGL_ALPHA_SIZE, 8,
            EGL14.EGL_NONE,
        )
        val configs = arrayOfNulls<EGLConfig>(1)
        val count = IntArray(1)
        check(EGL14.eglChooseConfig(display, attributes, 0, configs, 0, 1, count, 0) && count[0] > 0) {
            "eglChooseConfig failed: ${EGL14.eglGetError()}"
        }
        config = configs[0]
        val contextAttributes = intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE)
        eglContext = EGL14.eglCreateContext(
            display,
            config,
            EGL14.EGL_NO_CONTEXT,
            contextAttributes,
            0,
        )
        check(eglContext != EGL14.EGL_NO_CONTEXT) {
            "eglCreateContext failed: ${EGL14.eglGetError()}"
        }
        openWindowSurface(nativeSurface)
        drawableGate.surfaceCreated()
        probeBackend = null
        val vendor = GLES20.glGetString(GLES20.GL_VENDOR) ?: ""
        val renderer = GLES20.glGetString(GLES20.GL_RENDERER) ?: ""
        onContextProbe?.invoke(JSONObject().put("schemaVersion", 1).put("source", "android-egl-window")
            .put("status", "passed").put("contextCreated", true).put("containerSurfaceAttached", false)
            .put("evidenceBoundary", "device-context-only")
            .put("hardwareAccelerated", !Regex("(?i)swiftshader|llvmpipe|software|softpipe").containsMatchIn("$vendor $renderer"))
            .put("vendor", vendor).put("renderer", renderer).put("version", GLES20.glGetString(GLES20.GL_VERSION) ?: "")
            .put("eglVersion", "${versions[0]}.${versions[1]}"))
        framebuffer = currentFramebuffer()
        attachRuntimeIfReady()
    }

    /** The legacy pixel upload is opt-in and allocates nothing on GPU-only sessions. */
    private fun ensureSoftwarePresenter() {
        if (program != 0 && texture != 0) return
        program = createProgram(VERTEX_SHADER, FRAGMENT_SHADER)
        val textureIds = IntArray(1)
        GLES20.glGenTextures(1, textureIds, 0)
        texture = textureIds[0]
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, texture)
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
    }

    private fun attachRuntimeIfReady() {
        if (!runtimeSessionReady || runtimeAttachment.attached || eglContext == EGL14.EGL_NO_CONTEXT) return
        makeCurrent()
        if (onRuntimeContextReady?.invoke() == true) runtimeAttachment.attachedSuccessfully()
    }

    private fun drawFrame(frame: Presentation) {
        drawableObservation = null
        drawableGate.beginFrame()
        try {
            drawValidatedFrame(frame)
        } catch (error: Throwable) {
            failPresentation(error)
        }
    }

    private fun drawValidatedFrame(frame: Presentation) {
        if (surfaceWidth <= 0 || surfaceHeight <= 0 || latestWindowObservation == null) return
        val observed = latestWindowObservation ?: return
        if (observedSurfaceExtent() != (observed.surfaceWidth to observed.surfaceHeight)) return
        val width = frame.width
        val height = frame.height
        check(width == observed.windowWidth && height == observed.windowHeight) { "frame extent differs from accepted window observation" }
        makeCurrent()
        bindWindowFramebuffer()
        val prepared = drawableGate.prepare(
            DrawableExtent(observed.surfaceWidth, observed.surfaceHeight),
            ::readDrawableState,
            ::recreateWindowSurface,
        )
        framebuffer = prepared.beforeDraw.framebuffer
        if (onRuntimeFrame?.invoke(framebuffer, surfaceWidth, surfaceHeight) == true) {
            val afterDraw = readDrawableState()
            check(EGL14.eglSwapBuffers(display, eglSurface)) {
                "eglSwapBuffers failed: ${EGL14.eglGetError()}"
            }
            completePresentation(frame.frameId, prepared, afterDraw, observed)
            presentationPending = false
            onPresented?.invoke(frame.frameId, "skia-gpu-gles", geometry())
            if (probeBackend != "skia-gpu-gles") {
                probeBackend = "skia-gpu-gles"
                emitProbe(
                    JSONObject()
                        .put("status", "passed")
                        .put("backend", "skia-gpu-gles")
                        .put("hostSurfaceAttached", true)
                        .put("containerSurfaceAttached", true)
                        .put("gpuSurface", true)
                        .put("rendererBackend", "skia-gpu-gles")
                        .put("width", surfaceWidth)
                        .put("height", surfaceHeight)
                        .put("framebuffer", framebuffer)
                        .put("evidenceBoundary", "runtime-skia-gles-framebuffer"),
                )
            }
            return
        }
        val snapshot = checkNotNull(frame.softwareSnapshot) {
            "ERR_RENDER: native GPU presentation failed; software fallback was not requested"
        }
        ensureSoftwarePresenter()
        val json = JSONObject(snapshot.toString(Charsets.UTF_8))
        val pixels = jsonArrayBytes(json.getJSONArray("pixels"))
        check(width > 0 && height > 0) { "snapshot dimensions must be positive" }
        check(pixels.size.toLong() == width.toLong() * height * 4) { "snapshot pixel buffer length is invalid" }
        val rgba = ByteBuffer.allocateDirect(width * height * 4)
            .order(ByteOrder.nativeOrder())
        rgba.put(pixels, 0, width * height * 4).position(0)
        GLES20.glUseProgram(program)
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, texture)
        GLES20.glTexImage2D(
            GLES20.GL_TEXTURE_2D,
            0,
            GLES20.GL_RGBA,
            width,
            height,
            0,
            GLES20.GL_RGBA,
            GLES20.GL_UNSIGNED_BYTE,
            rgba,
        )
        GLES20.glViewport(0, 0, surfaceWidth, surfaceHeight)
        GLES20.glClearColor(0f, 0f, 0f, 1f)
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)
        val position = GLES20.glGetAttribLocation(program, "aPosition")
        val texCoord = GLES20.glGetAttribLocation(program, "aTexCoord")
        GLES20.glEnableVertexAttribArray(position)
        GLES20.glVertexAttribPointer(position, 2, GLES20.GL_FLOAT, false, 0, vertexBuffer)
        GLES20.glEnableVertexAttribArray(texCoord)
        GLES20.glVertexAttribPointer(texCoord, 2, GLES20.GL_FLOAT, false, 0, texCoordBuffer)
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
        GLES20.glDisableVertexAttribArray(position)
        GLES20.glDisableVertexAttribArray(texCoord)
        val afterDraw = readDrawableState()
        check(EGL14.eglSwapBuffers(display, eglSurface)) {
            "eglSwapBuffers failed: ${EGL14.eglGetError()}"
        }
        completePresentation(frame.frameId, prepared, afterDraw, observed)
        presentationPending = false
        onPresented?.invoke(frame.frameId, "gles-window-blit", geometry())
        if (probeBackend != "gles-window-blit") {
            probeBackend = "gles-window-blit"
            emitProbe(
                JSONObject()
                    .put("status", "passed")
                    .put("backend", "gles-window-blit")
                    .put("hostSurfaceAttached", true)
                    // Uploading a raster snapshot does not prove that Rust
                    // rendered this window through a Skia GPU context.
                    .put("containerSurfaceAttached", false)
                    .put("gpuSurface", false)
                    .put("rendererBackend", "software-fallback")
                    .put("width", width)
                    .put("height", height)
                    .put("evidenceBoundary", "runtime-snapshot-upload"),
            )
        }
    }

    private fun emitProbe(fields: JSONObject) {
        val probe = fields
            .put("schemaVersion", 1)
            .put("source", "android-gles-window")
        onProbe?.invoke(probe)
    }

    private fun geometry(): JSONObject = checkNotNull(latestWindowObservation) { "window observation is not ready" }.geometry()
        .put("drawableObservation", drawableObservation ?: JSONObject.NULL)

    /** Create only the EGL window target. Context, textures and runtime stay owned. */
    private fun openWindowSurface(nativeSurface: android.view.Surface) {
        check(eglSurface == EGL14.EGL_NO_SURFACE) { "previous EGL surface is still owned" }
        eglSurface = EGL14.eglCreateWindowSurface(display, config, nativeSurface,
            intArrayOf(EGL14.EGL_NONE), 0)
        check(eglSurface != EGL14.EGL_NO_SURFACE) {
            "eglCreateWindowSurface failed: ${EGL14.eglGetError()}"
        }
        makeCurrent()
        bindWindowFramebuffer()
    }

    /** Acquire a fresh window backing without destroying the shared context or JS session. */
    private fun recreateWindowSurface() {
        check(holder.surface.isValid && observedSurfaceExtent() != null) { "holder Surface is no longer ready" }
        invalidatePresentation()
        check(EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)) {
            "EGL target unbind failed: ${EGL14.eglGetError()}"
        }
        check(EGL14.eglDestroySurface(display, eglSurface)) {
            "EGL target retirement failed: ${EGL14.eglGetError()}"
        }
        eglSurface = EGL14.EGL_NO_SURFACE
        openWindowSurface(holder.surface)
    }

    private fun invalidatePresentation() {
        presentationPending = true
        onSurfaceLost?.invoke()
    }

    private fun failPresentation(error: Throwable) {
        // Freeze samples before cleanup clears owned EGL state. Failed frames
        // never become onPresented or fall through to a software fallback.
        val evidence = (drawableObservation ?: drawableAttemptJson()).put("status", "failed")
            .put("reason", error.message ?: error.javaClass.simpleName)
        try { runEglCleanup(::invalidatePresentation, ::releaseEgl) } catch (cleanup: Throwable) {
            if (cleanup !== error) error.addSuppressed(cleanup)
        }
        runEglCleanup(
            { emitProbe(JSONObject().put("status", "failed").put("code", "ERR_RENDER")
                .put("reason", error.message ?: error.javaClass.simpleName).put("drawableObservation", evidence)) },
            { (onFailure ?: throw error).invoke(error) },
        )
    }

    private fun bindWindowFramebuffer() {
        // This presenter owns an EGL window, not an arbitrary FBO left bound
        // by Ganesh scratch work. Rust wraps framebuffer zero anew each draw.
        GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0)
    }

    /** Actual acquired EGL allocation and GL state, separate from desired geometry. */
    private fun readDrawableState(): EglDrawableSample {
        check(EGL14.eglGetCurrentDisplay() == display && EGL14.eglGetCurrentContext() == eglContext
            && EGL14.eglGetCurrentSurface(EGL14.EGL_DRAW) == eglSurface) { "unexpected current EGL owner" }
        val size = IntArray(2)
        check(EGL14.eglQuerySurface(display, eglSurface, EGL14.EGL_WIDTH, size, 0)
            && EGL14.eglQuerySurface(display, eglSurface, EGL14.EGL_HEIGHT, size, 1)) {
            "eglQuerySurface failed: ${EGL14.eglGetError()}"
        }
        val viewport = IntArray(4)
        val scissor = IntArray(4)
        GLES20.glGetIntegerv(GLES20.GL_VIEWPORT, viewport, 0)
        GLES20.glGetIntegerv(GLES20.GL_SCISSOR_BOX, scissor, 0)
        return EglDrawableSample(DrawableExtent(size[0], size[1]), eglContext.nativeHandle,
            eglSurface.nativeHandle, currentFramebuffer(), viewport.toList(), scissor.toList())
    }

    private fun sampleJson(sample: EglDrawableSample): JSONObject = JSONObject()
        .put("width", sample.extent.width).put("height", sample.extent.height)
        .put("contextId", eglIdentityHex(sample.contextId)).put("surfaceId", eglIdentityHex(sample.surfaceId))
        .put("identityEncoding", "unsigned64-hex")
        .put("framebuffer", sample.framebuffer).put("viewport", JSONArray(sample.viewport))
        .put("scissor", JSONArray(sample.scissor))

    private fun drawableAttemptJson(): JSONObject {
        val attempt = drawableGate.lastAttempt ?: return JSONObject()
            .put("schemaVersion", 2).put("targetEpoch", drawableGate.targetEpoch)
        return JSONObject().put("schemaVersion", 2).put("targetEpoch", attempt.targetEpoch)
            .put("acceptedWidth", attempt.expected.width).put("acceptedHeight", attempt.expected.height)
            .put("surfaceRecreationAttempted", attempt.recreationAttempted)
            .put("surfaceRecreated", attempt.recreated)
            .put("beforeTransition", sampleJson(attempt.beforeTransition))
            .put("beforeDraw", sampleJson(attempt.beforeDraw))
    }

    private fun completePresentation(frameId: Long, prepared: PreparedDrawable,
        afterDraw: EglDrawableSample, observed: AndroidWindowObservation) {
        val afterSwap = readDrawableState()
        // Keep failed post-swap samples as well; they are not a successful receipt.
        drawableObservation = drawableAttemptJson().put("frameId", frameId)
            .put("afterDraw", sampleJson(afterDraw)).put("afterSwap", sampleJson(afterSwap))
        check(latestWindowObservation == observed) { "window observation changed before presentation" }
        val currentExtent = observedSurfaceExtent()?.let { DrawableExtent(it.first, it.second) }
        drawableGate.complete(prepared, afterDraw, afterSwap, currentExtent)
        drawableObservation!!.put("status", "passed")
    }

    private fun releaseEgl() {
        // No surfaceless-context assumption: a real owned window must bind
        // before GL deletion. Otherwise native Ganesh abandons its handles.
        var contextCurrent = false
        try {
            runEglCleanup(
                { contextCurrent = tryMakeCurrent() },
                { runtimeAttachment.release({ contextCurrent }) { mode ->
                    checkNotNull(onRuntimeContextLost) { "runtime release callback is missing" }.invoke(mode)
                } },
                {
                    if (contextCurrent) {
                        if (texture != 0) GLES20.glDeleteTextures(1, intArrayOf(texture), 0)
                        if (program != 0) GLES20.glDeleteProgram(program)
                    }
                },
                {
                    if (display != EGL14.EGL_NO_DISPLAY && eglContext != EGL14.EGL_NO_CONTEXT) {
                        check(EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)) {
                            "EGL cleanup unbind failed: ${EGL14.eglGetError()}"
                        }
                    }
                },
                {
                    if (display != EGL14.EGL_NO_DISPLAY && eglSurface != EGL14.EGL_NO_SURFACE) {
                        check(EGL14.eglDestroySurface(display, eglSurface)) { "EGL surface cleanup failed: ${EGL14.eglGetError()}" }
                    }
                },
                {
                    if (display != EGL14.EGL_NO_DISPLAY && eglContext != EGL14.EGL_NO_CONTEXT) {
                        check(EGL14.eglDestroyContext(display, eglContext)) { "EGL context cleanup failed: ${EGL14.eglGetError()}" }
                    }
                },
                { if (display != EGL14.EGL_NO_DISPLAY) check(EGL14.eglReleaseThread()) { "EGL thread cleanup failed" } },
                {
                    if (display != EGL14.EGL_NO_DISPLAY) {
                        check(EGL14.eglTerminate(display)) { "EGL display cleanup failed: ${EGL14.eglGetError()}" }
                    }
                },
            )
        } finally {
            texture = 0
            program = 0
            display = EGL14.EGL_NO_DISPLAY
            eglContext = EGL14.EGL_NO_CONTEXT
            eglSurface = EGL14.EGL_NO_SURFACE
            config = null
            framebuffer = 0
            probeBackend = null
            drawableObservation = null
            drawableGate.surfaceLost()
        }
    }

    private fun tryMakeCurrent(): Boolean = display != EGL14.EGL_NO_DISPLAY
        && eglContext != EGL14.EGL_NO_CONTEXT && eglSurface != EGL14.EGL_NO_SURFACE
        && EGL14.eglMakeCurrent(display, eglSurface, eglSurface, eglContext)
        && EGL14.eglGetCurrentDisplay() == display && EGL14.eglGetCurrentContext() == eglContext
        && EGL14.eglGetCurrentSurface(EGL14.EGL_DRAW) == eglSurface

    private fun makeCurrent() {
        check(EGL14.eglMakeCurrent(display, eglSurface, eglSurface, eglContext)) {
            "eglMakeCurrent failed: ${EGL14.eglGetError()}"
        }
    }

    private fun currentFramebuffer(): Int {
        val value = IntArray(1)
        GLES20.glGetIntegerv(GLES20.GL_FRAMEBUFFER_BINDING, value, 0)
        return value[0]
    }

    private fun compileShader(type: Int, source: String): Int {
        val shader = GLES20.glCreateShader(type)
        check(shader != 0) { "glCreateShader failed" }
        GLES20.glShaderSource(shader, source)
        GLES20.glCompileShader(shader)
        val status = IntArray(1)
        GLES20.glGetShaderiv(shader, GLES20.GL_COMPILE_STATUS, status, 0)
        if (status[0] == 0) {
            val log = GLES20.glGetShaderInfoLog(shader)
            GLES20.glDeleteShader(shader)
            error("shader compilation failed: $log")
        }
        return shader
    }

    private fun createProgram(vertex: String, fragment: String): Int {
        val vertexShader = compileShader(GLES20.GL_VERTEX_SHADER, vertex)
        val fragmentShader = compileShader(GLES20.GL_FRAGMENT_SHADER, fragment)
        val result = GLES20.glCreateProgram()
        GLES20.glAttachShader(result, vertexShader)
        GLES20.glAttachShader(result, fragmentShader)
        GLES20.glLinkProgram(result)
        val status = IntArray(1)
        GLES20.glGetProgramiv(result, GLES20.GL_LINK_STATUS, status, 0)
        GLES20.glDeleteShader(vertexShader)
        GLES20.glDeleteShader(fragmentShader)
        check(status[0] != 0) { "program linking failed: ${GLES20.glGetProgramInfoLog(result)}" }
        return result
    }

    private fun jsonArrayBytes(array: JSONArray): ByteArray = ByteArray(array.length()) { index ->
        array.getInt(index).coerceIn(0, 255).toByte()
    }

    private fun floatBuffer(values: FloatArray): FloatBuffer = ByteBuffer
        .allocateDirect(values.size * Float.SIZE_BYTES)
        .order(ByteOrder.nativeOrder())
        .asFloatBuffer()
        .apply {
            put(values)
            position(0)
        }

    companion object {
        private const val VERTEX_SHADER =
            "attribute vec2 aPosition; attribute vec2 aTexCoord; varying vec2 vTexCoord; " +
                "void main(){ gl_Position=vec4(aPosition,0.0,1.0); vTexCoord=aTexCoord; }"
        private const val FRAGMENT_SHADER =
            "precision mediump float; varying vec2 vTexCoord; uniform sampler2D uTexture; " +
                "void main(){ gl_FragColor=texture2D(uTexture,vTexCoord); }"
    }
}
