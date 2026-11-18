package com.sonofmagic.weapp.container

import kotlin.math.floor
import org.json.JSONObject

/** Physical observations only. This class deliberately has no Android API dependency. */
internal data class ObservedInsets(val left: Int, val top: Int, val right: Int, val bottom: Int) {
    init { require(listOf(left, top, right, bottom).all { it >= 0 }) { "negative window inset" } }
    fun json(): JSONObject = JSONObject().put("left", left).put("top", top).put("right", right).put("bottom", bottom)
}

/**
 * A complete Surface/Display/WindowInsets observation. Display extents and
 * Surface extents have independent sources. All conversion uses the observed
 * density, nearest logical pixel (positive half ties round upward).
 *
 * Android insets have not established the public safeArea portrait-coordinate
 * origin. Preserve raw insets for diagnostics and omit that public field.
 */
internal data class AndroidWindowObservation(
    val surfaceWidth: Int,
    val surfaceHeight: Int,
    val displayWidth: Int,
    val displayHeight: Int,
    val density: Double,
    val rotation: Int,
    val deviceOrientation: String,
    val windowOriginX: Int,
    val windowOriginY: Int,
    val surfaceOriginX: Int,
    val surfaceOriginY: Int,
    val statusBars: ObservedInsets,
    val systemBars: ObservedInsets,
    val displayCutout: ObservedInsets,
    val insetsSource: String,
) {
    init {
        require(density.isFinite() && density > 0) { "invalid observed density" }
        require(surfaceWidth > 0 && surfaceHeight > 0 && displayWidth > 0 && displayHeight > 0) { "invalid observed extent" }
        require(rotation in 0..3) { "invalid observed display rotation" }
        require(deviceOrientation in setOf("portrait", "landscape")) { "unknown configuration orientation" }
        require(insetsSource.isNotBlank()) { "window insets must be observed" }
        require(statusBars.top <= displayHeight) { "status bar inset exceeds display" }
        logical(surfaceWidth); logical(surfaceHeight); logical(displayWidth); logical(displayHeight)
    }

    val windowWidth: Int get() = logical(surfaceWidth)
    val windowHeight: Int get() = logical(surfaceHeight)

    private fun logical(physical: Int): Int {
        val value = floor(physical / density + 0.5)
        require(value.isFinite() && value >= 1 && value <= Int.MAX_VALUE) { "invalid logical extent" }
        return value.toInt()
    }

    fun displayMetrics(): JSONObject = JSONObject().put("pixelRatio", density)
        .put("screenWidth", logical(displayWidth)).put("screenHeight", logical(displayHeight))
        .put("statusBarHeight", statusBars.top / density).put("screenTop", windowOriginY / density)
        .put("deviceOrientation", deviceOrientation)

    fun metrics(): JSONObject = displayMetrics().put("windowWidth", windowWidth).put("windowHeight", windowHeight)

    fun raw(): JSONObject = JSONObject().put("surfaceWidth", surfaceWidth).put("surfaceHeight", surfaceHeight)
        .put("displayWidth", displayWidth).put("displayHeight", displayHeight).put("density", density)
        .put("rotation", rotation).put("deviceOrientation", deviceOrientation)
        .put("windowOrigin", JSONObject().put("x", windowOriginX).put("y", windowOriginY))
        .put("surfaceOrigin", JSONObject().put("x", surfaceOriginX).put("y", surfaceOriginY))
        .put("statusBars", statusBars.json()).put("systemBars", systemBars.json()).put("displayCutout", displayCutout.json())
        .put("insetsSource", insetsSource).put("safeAreaMapping", "unknown")
        .put("displaySource", "Display.getRealSize(current orientation)")
        .put("densitySource", "resources.displayMetrics.density")

    fun geometry(): JSONObject = JSONObject().put("width", surfaceWidth).put("height", surfaceHeight)
        .put("density", density).put("screenX", surfaceOriginX).put("screenY", surfaceOriginY)
        .put("windowObservation", raw())
}
