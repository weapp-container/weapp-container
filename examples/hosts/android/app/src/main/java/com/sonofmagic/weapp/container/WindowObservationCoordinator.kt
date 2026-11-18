package com.sonofmagic.weapp.container

/**
 * Joins window dispatch and a later layout boundary. The platform adapter is
 * responsible for capturing incoming Insets, preserving the default policy,
 * and calling afterLayout only from preDraw with an actual ready Surface.
 */
internal class WindowObservationCoordinator<Insets, Observation>(
    private val requestFrame: () -> Unit,
    private val publish: (Observation) -> Unit,
) {
    private var insets: Insets? = null
    private var dispatchDepth = 0
    private var pending = true
    private var forced = false
    private var closed = false
    private var requiredEpoch = 1L
    private var usableEpoch = 0L
    var insetsEpoch = 0L
        private set
    var latest: Observation? = null
        private set

    /** Returns exactly the default policy result, including consumed Insets. */
    fun <Result> dispatchInsets(incoming: Insets, applyDefault: () -> Result): Result {
        if (closed) return applyDefault()
        dispatchDepth += 1
        val epoch = ++insetsEpoch
        try {
            val result = applyDefault()
            if (!closed && epoch > usableEpoch) {
                usableEpoch = epoch
                insets = incoming
                pending = true
            }
            return result
        } catch (error: Throwable) {
            requiredEpoch = maxOf(requiredEpoch, epoch + 1)
            throw error
        } finally {
            dispatchDepth -= 1
            if (!closed && dispatchDepth == 0) requestFrame()
        }
    }

    fun refresh(force: Boolean) {
        if (closed) return
        pending = true
        if (force) {
            forced = true
            requiredEpoch = insetsEpoch + 1
        }
        requestFrame()
    }

    fun geometryChanged() {
        if (closed) return
        pending = true
        requestFrame()
    }

    fun surfaceLost() {
        if (closed) return
        latest = null
        pending = true
    }

    /** A null read is unready geometry; keep the last good observation. */
    fun afterLayout(read: (Insets) -> Observation?): Boolean {
        if (closed || !pending || dispatchDepth != 0 || usableEpoch < requiredEpoch) return false
        val raw = insets ?: return false
        val observation = read(raw) ?: return false
        val changed = latest != observation || forced
        latest = observation
        pending = false
        forced = false
        if (changed) publish(observation)
        return !closed && !pending
    }

    fun pendingReason(): String? = when {
        closed -> "closed"
        dispatchDepth != 0 -> "insets-dispatch-in-progress"
        insets == null -> "waiting-for-window-insets"
        usableEpoch < requiredEpoch -> "waiting-for-fresh-window-insets"
        pending -> "waiting-for-ready-surface-layout"
        else -> null
    }

    fun close() {
        closed = true
        pending = false
        insets = null
        latest = null
    }
}
