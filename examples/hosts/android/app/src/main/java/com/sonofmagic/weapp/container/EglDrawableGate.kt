package com.sonofmagic.weapp.container

/** Physical extents of one currently acquired drawable, never desired layout dimensions. */
internal data class DrawableExtent(val width: Int, val height: Int) {
    init { require(width > 0 && height > 0) { "invalid EGL drawable extent" } }
}

/** Immutable current-context sample. Contains no Android or JSON dependencies. */
internal data class EglDrawableSample(
    val extent: DrawableExtent,
    val contextId: Long,
    val surfaceId: Long,
    val framebuffer: Int,
    val viewport: List<Int>,
    val scissor: List<Int>,
) {
    init {
        require(contextId != 0L && surfaceId != 0L) { "invalid current EGL identity" }
        require(viewport.size == 4 && scissor.size == 4) { "invalid GL rectangle sample" }
    }
}

internal data class PreparedDrawable(
    val expected: DrawableExtent,
    val targetEpoch: Long,
    val beforeTransition: EglDrawableSample,
    val beforeDraw: EglDrawableSample,
    val recreated: Boolean,
    val recreationAttempted: Boolean = false,
)

/**
 * Joins current drawable allocation with already accepted View geometry.
 * Recreating a window surface is an acquisition transition, not a rendered frame.
 * The caller owns EGL effects, frame drawing and receipts; no transition calls a renderer.
 */
internal class EglDrawableGate {
    var targetEpoch: Long = 0
        private set
    private var active = false
    var lastAttempt: PreparedDrawable? = null
        private set

    fun surfaceCreated() {
        targetEpoch += 1
        active = true
    }

    fun surfaceLost() { active = false }

    fun beginFrame() { lastAttempt = null }

    /** Recreate once on mismatch; a persistent mismatch fails closed before any draw. */
    fun prepare(
        expected: DrawableExtent,
        read: () -> EglDrawableSample,
        recreateSurface: () -> Unit,
    ): PreparedDrawable {
        check(active) { "EGL drawable is not active" }
        lastAttempt = null
        try {
            val initial = read()
            lastAttempt = PreparedDrawable(expected, targetEpoch, initial, initial, false)
            if (initial.extent != expected) {
                lastAttempt = lastAttempt!!.copy(recreationAttempted = true)
                active = false
                recreateSurface()
                surfaceCreated()
                // Preserve the completed transition even if the next query fails.
                lastAttempt = lastAttempt!!.copy(targetEpoch = targetEpoch, recreated = true)
                val acquired = read()
                lastAttempt = lastAttempt!!.copy(beforeDraw = acquired)
                check(acquired.contextId == initial.contextId) { "EGL surface transition changed context" }
            }
            val ready = lastAttempt!!
            check(ready.beforeDraw.extent == expected) { "EGL drawable extent still differs after surface acquisition" }
            check(ready.beforeDraw.framebuffer == 0) { "owned EGL window must draw to framebuffer zero" }
            return ready
        } catch (error: Throwable) {
            active = false
            throw error
        }
    }

    /** A swap is creditable only for the same target, context and accepted geometry. */
    fun complete(
        prepared: PreparedDrawable,
        afterDraw: EglDrawableSample,
        afterSwap: EglDrawableSample,
        currentExpected: DrawableExtent?,
    ) {
        try {
            check(active && targetEpoch == prepared.targetEpoch) { "EGL drawable target changed before presentation" }
            check(currentExpected == prepared.expected) { "accepted View geometry changed before presentation" }
            for (sample in listOf(afterDraw, afterSwap)) {
                check(sample.extent == prepared.expected) { "EGL drawable extent changed before presentation" }
                check(sample.contextId == prepared.beforeDraw.contextId && sample.surfaceId == prepared.beforeDraw.surfaceId) {
                    "current EGL target changed before presentation"
                }
            }
        } catch (error: Throwable) {
            active = false
            throw error
        }
    }
}

internal enum class EglContextReleaseMode { DETACH_CURRENT, ABANDON }

/** Runtime handles must never outlive the EGL context they reference. */
internal class EglRuntimeAttachment {
    var attached = false
        private set

    fun attachedSuccessfully() { check(!attached); attached = true }

    fun release(canMakeCurrent: () -> Boolean, releaseRuntime: (EglContextReleaseMode) -> Unit) {
        if (!attached) return
        fun abandonAfter(failure: Throwable): Nothing {
            try { releaseRuntime(EglContextReleaseMode.ABANDON) } catch (cleanup: Throwable) {
                if (cleanup !== failure) failure.addSuppressed(cleanup)
            }
            throw failure
        }
        try {
            val current = try { canMakeCurrent() } catch (failure: Throwable) { abandonAfter(failure) }
            if (current) {
                try { releaseRuntime(EglContextReleaseMode.DETACH_CURRENT) } catch (failure: Throwable) {
                    abandonAfter(failure)
                }
            } else releaseRuntime(EglContextReleaseMode.ABANDON)
        } finally {
            attached = false
        }
    }
}

/** Run every owned cleanup step, preserving the first failure and all later failures. */
internal fun runEglCleanup(vararg steps: () -> Unit) {
    var failure: Throwable? = null
    for (step in steps) {
        try { step() } catch (error: Throwable) {
            if (failure == null) failure = error else if (error !== failure) failure.addSuppressed(error)
        }
    }
    failure?.let { throw it }
}

/** JSON numbers cannot losslessly represent arbitrary EGL uintptr handles in JS. */
internal fun eglIdentityHex(value: Long): String = "0x" + java.lang.Long.toUnsignedString(value, 16)
