package com.sonofmagic.weapp.container

import java.nio.charset.StandardCharsets.UTF_8
import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONObject

/** One thread-affine runtime owner, shared by startup and the surface presenter. */
internal interface PortablePackRuntime {
    fun loadManifest(manifest: ByteArray, config: ByteArray): ByteArray
    fun dispatch(envelope: ByteArray): ByteArray
}

/**
 * Verified, content-addressed input. No JNI/Android APIs are needed to load or
 * validate a pack; failed loads cannot mutate an existing native session.
 */
internal class PortablePack private constructor(
    private val manifestBytes: ByteArray,
    private val manifest: JSONObject,
    private val blobs: Map<String, ByteArray>,
) {
    val integrityRoot: String = manifest.getJSONObject("integrity").getString("root")

    fun start(
        runtime: PortablePackRuntime,
        route: String? = null,
        width: Int = 375,
        height: Int = 667,
        engine: String = "quickjs",
        sessionId: String = SESSION_ID,
        fixtureId: String = "portable-pack-reference-v1",
        windowObservation: AndroidWindowObservation? = null,
        pageRenderMode: String = "raster",
        onOperation: (String, ByteArray) -> Unit = { _, _ -> },
    ): PortablePackStartup {
        check(width > 0 && height > 0) { "viewport dimensions must be positive" }
        check(windowObservation == null || (width == windowObservation.windowWidth && height == windowObservation.windowHeight)) {
            "startup viewport differs from observed surface"
        }
        check(engine in setOf("quickjs", "v8")) { "ERR_ENGINE: engine must be quickjs or v8" }
        check(pageRenderMode in setOf("raster", "native-gpu")) { "ERR_RENDER: invalid native page render mode" }
        check(sessionId.isNotBlank()) { "sessionId must not be empty" }
        check(fixtureId.isNotBlank()) { "fixtureId must not be empty" }
        val routes = manifest.getJSONArray("routes")
        check(routes.length() > 0) { "portable pack manifest has no routes" }
        val selectedRoute = route ?: routes.getJSONObject(0).getString("path")
        check((0 until routes.length()).any { routes.getJSONObject(it).getString("path") == selectedRoute }) {
            "route is not declared: $selectedRoute"
        }
        val templateId = "template:$selectedRoute.wxml"
        val templates = manifest.getJSONArray("templates")
        check((0 until templates.length()).any { templates.getJSONObject(it).getString("id") == templateId }) {
            "route template is not declared: $templateId"
        }
        val declarations = manifest.getJSONArray("modules")
        check(declarations.length() > 0) { "portable pack has no modules" }
        val modules = JSONArray()
        val moduleIds = JSONArray()
        val moduleDigests = JSONObject()
        for (index in 0 until declarations.length()) {
            val declaration = declarations.getJSONObject(index)
            val id = declaration.getString("id")
            val digest = digestPointer(declaration.getString("sha256"))
            val bytes = checkNotNull(blobs[digest]) { "module blob is missing: $digest" }
            val module = JSONObject().put("id", id)
            val source = bytes.toString(UTF_8)
            if (source.toByteArray(UTF_8).contentEquals(bytes)) module.put("source", source)
            else module.put("bytes", byteValues(bytes))
            modules.put(module)
            moduleIds.put(id)
            moduleDigests.put(id, digest)
        }
        val resources = JSONObject()
        for ((digest, bytes) in blobs) resources.put("sha256:$digest", byteValues(bytes))
        val styleIds = JSONArray()
        val styles = manifest.optJSONArray("styles") ?: JSONArray()
        for (index in 0 until styles.length()) styleIds.put(styles.getJSONObject(index).getString("id"))
        val host = JSONObject().put("platform", "android").put("windowWidth", width).put("windowHeight", height)
        windowObservation?.let { host.put("displayMetrics", it.displayMetrics()) }
        val config = JSONObject().put("engine", engine).put("session_id", sessionId).put("require_integrity", true).put("host", host)
            .put("page_render_mode", pageRenderMode)
        val load = JSONObject(runtime.loadManifest(manifestBytes.copyOf(), config.toString().toByteArray(UTF_8)).toString(UTF_8))
        check(load.opt("ok") == true) { "Rust rejected the portable manifest: ${load.optJSONObject("error") ?: load}" }
        val operations = JSONObject()
        var init: JSONObject? = null
        var rendered: JSONObject? = null
        val startup = listOf(
            "app.init" to JSONObject().put("manifest", manifest).put("modules", modules).put("blobs", resources)
                .put("launchOptions", JSONObject().put("path", selectedRoute)),
            "app.lifecycle" to JSONObject().put("event", "launch").put("options", JSONObject().put("path", selectedRoute)),
            "page.push" to JSONObject().put("path", selectedRoute),
            // Omit `data`: onLoad/setData in the actual AppService owns page
            // state. An explicit frame would bypass WXML/WXSS entirely.
            "render.commit" to JSONObject().put("frameId", 1).put("templateId", templateId)
                .put("styleIds", styleIds).put("blobs", resources)
                .put("viewport", JSONObject().put("x", 0).put("y", 0).put("width", width).put("height", height)),
        )
        for ((index, item) in startup.withIndex()) {
            val (operation, payload) = item
            val requestId = "android-pack-${index + 1}"
            val envelope = JSONObject().put("protocolVersion", "1.0").put("sessionId", sessionId)
                .put("requestId", requestId).put("kind", "request").put("op", operation).put("payload", payload)
            val response = runtime.dispatch(envelope.toString().toByteArray(UTF_8))
            onOperation(operation, response)
            val body = correlatedAcknowledgement(response, requestId, operation, sessionId)
            operations.put(operation, JSONObject().put("status", 0).put("request", envelope)
                .put("json", response.toString(UTF_8)))
            if (operation == "app.init") {
                check(body.opt("engineProviderAvailable") == true && body.optString("engine") == engine) {
                    "ERR_ENGINE: native JS provider unavailable; refusing protocol-only startup"
                }
                check(integer(body.opt("loadedModules")) == declarations.length().toLong()) { "runtime did not load the complete module batch" }
                check(body.getJSONObject("manifest").getString("integrity") == integrityRoot) { "runtime initialized another manifest" }
                init = body
            }
            if (operation == "render.commit") {
                check(body.opt("committed") == true && body.optString("source") == "manifest" &&
                    body.optString("templateId") == templateId && integer(body.opt("frameId")) == 1L) {
                    "ERR_RENDER: runtime did not publish the requested manifest frame"
                }
                rendered = body
            }
        }
        return PortablePackStartup(
            JSONObject(manifest.toString()), operations, integrityRoot, selectedRoute, templateId,
            checkNotNull(init).getString("engine"), moduleIds, moduleDigests,
            checkNotNull(rendered).getString("backend"), width, height, sessionId, fixtureId,
        )
    }

    companion object {
        const val SESSION_ID = "session-1"
        private val HEX_DIGEST = Regex("[0-9a-f]{64}")

        fun load(read: (String) -> ByteArray): PortablePack {
            val bytes = read("manifest.json").copyOf()
            val text = bytes.toString(UTF_8)
            check(text.toByteArray(UTF_8).contentEquals(bytes)) { "manifest must be valid UTF-8" }
            val manifest = JSONObject(text)
            val schema = manifest.get("schemaVersion")
            check(schema is Int && schema in 1..3) { "unsupported portable pack schema" }
            check(!(schema == 1 && manifest.has("modernView")) && !(schema == 2 && !manifest.has("modernView"))) {
                "modernView requires schema 2 or 3; schema 2 requires modernView"
            }
            check((schema == 3) == manifest.has("rendering")) { "rendering requires schema 3" }
            if (manifest.has("rendering")) validateRendering(manifest)
            val integrity = manifest.getJSONObject("integrity")
            check(integrity.getString("algorithm") == "sha256") { "unsupported integrity algorithm" }
            val root = integrity.getString("root")
            check(root.matches(HEX_DIGEST)) { "portable pack integrity root is invalid" }
            val unsigned = JSONObject(manifest.toString())
            unsigned.getJSONObject("integrity").put("root", "")
            check(sha256(canonicalJson(unsigned).toByteArray(UTF_8)) == root) { "portable pack manifest integrity root mismatch" }
            val refs = linkedSetOf<String>()
            fun collect(table: JSONArray, vararg fields: String) {
                for (index in 0 until table.length()) for (field in fields) {
                    refs += digestPointer(table.getJSONObject(index).getString(field))
                }
            }
            for ((table, field) in listOf("modules" to "sha256", "viewScripts" to "sha256",
                "templates" to "wxmlAst", "styles" to "wxssIr", "assets" to "sha256")) {
                if (manifest.has(table)) collect(manifest.getJSONArray(table), field)
            }
            if (manifest.has("viewCompilation")) {
                val compilation = manifest.getJSONObject("viewCompilation")
                collect(compilation.getJSONArray("modules"), "sourceSha256", "executableSha256")
                val documents = compilation.getJSONArray("documents")
                collect(documents, "wxmlAst")
                for (index in 0 until documents.length()) {
                    collect(documents.getJSONObject(index).getJSONArray("expressions"), "executableSha256")
                }
            }
            if (manifest.has("modernView")) {
                val modern = manifest.getJSONObject("modernView")
                check(modern.getString("compiler") == "weapp-container-modern-view"
                    && modern.getString("version") == "1.0.0" && modern.getString("abi") == "1.0"
                    && modern.getString("target") == "es2022") { "unsupported modernView compiler" }
                val units = modern.getJSONArray("units")
                check(units.length() > 0) { "modernView needs units" }
                collect(units, "executableSha256", "sourceMapSha256")
                for (index in 0 until units.length()) {
                    collect(units.getJSONObject(index).getJSONArray("sources"), "sha256")
                }
            }
            check(refs.isNotEmpty()) { "portable pack has no content-addressed blobs" }
            val blobs = linkedMapOf<String, ByteArray>()
            for (digest in refs) {
                val blob = read("blobs/sha256/$digest").copyOf()
                check(sha256(blob) == digest) { "blob SHA-256 mismatch: $digest" }
                blobs[digest] = blob
            }
            return PortablePack(bytes, manifest, blobs)
        }

        private fun digestPointer(pointer: String): String {
            val digest = pointer.removePrefix("sha256:")
            check(digest.matches(HEX_DIGEST)) { "invalid blob pointer: $pointer" }
            return digest
        }

        internal fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes)
            .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }

        private fun byteValues(bytes: ByteArray): JSONArray = JSONArray().apply {
            bytes.forEach { put(it.toInt() and 0xff) }
        }

        internal fun integer(value: Any?): Long? {
            if (value !is Number) return null
            val number = value.toDouble()
            return if (number.isFinite() && number in -9_007_199_254_740_991.0..9_007_199_254_740_991.0 && number == value.toLong().toDouble()) value.toLong() else null
        }

        private fun correlatedAcknowledgement(bytes: ByteArray, requestId: String, operation: String, sessionId: String): JSONObject {
            val batch = JSONObject(bytes.toString(UTF_8)).getJSONArray("messages")
            val messages = (0 until batch.length()).map { batch.getJSONObject(it) }
            // render.commit can publish its frame before a ready hook or
            // drained effect throws. Its success acknowledgement survives
            // that publication, but the sibling error must prevent startup
            // from becoming a successful execution receipt.
            val failure = messages.firstOrNull {
                it.optString("op") == "error" ||
                    it.optString("kind") == "response" && it.optJSONObject("payload")?.opt("ok") == false
            }
            check(failure == null) { "$operation bridge batch failed: ${failure?.optJSONObject("payload") ?: failure}" }
            val matches = messages.filter {
                it.optString("kind") == "response" && it.optString("requestId") == requestId &&
                    it.optString("op") == operation && it.optString("sessionId") == sessionId &&
                    it.optString("protocolVersion") == "1.0"
            }
            check(matches.size == 1) { "$operation missing unique correlated bridge acknowledgement" }
            val payload = matches.single().getJSONObject("payload")
            check(payload.opt("ok") == true) { "$operation failed: ${payload.optJSONObject("error") ?: payload}" }
            return payload
        }

        /** Same unsigned UTF-8 byte ordering and JSON escaping as the packer. */
        internal fun canonicalJson(value: Any?): String = when {
            value == null || value === JSONObject.NULL -> "null"
            value is JSONObject -> {
                val keys = mutableListOf<String>()
                val iterator = value.keys()
                while (iterator.hasNext()) keys += iterator.next()
                keys.sortWith { left, right ->
                    val a = left.toByteArray(UTF_8)
                    val b = right.toByteArray(UTF_8)
                    var compared = 0
                    for (index in 0 until minOf(a.size, b.size)) {
                        compared = (a[index].toInt() and 0xff) - (b[index].toInt() and 0xff)
                        if (compared != 0) break
                    }
                    if (compared != 0) compared else a.size - b.size
                }
                keys.joinToString(prefix = "{", postfix = "}", separator = ",") { key ->
                    "${quoteJson(key)}:${canonicalJson(value.get(key))}"
                }
            }
            value is JSONArray -> (0 until value.length()).joinToString(prefix = "[", postfix = "]", separator = ",") {
                canonicalJson(value.get(it))
            }
            value is String -> quoteJson(value)
            value is Number -> {
                // v1 contains schemaVersion and asset sizes as non-negative
                // safe integers. Reject unsupported float spellings rather
                // than hashing Android's different numeric serialization.
                val number = value.toDouble()
                check(number.isFinite() && number >= 0 && number <= 9_007_199_254_740_991.0 && number == value.toLong().toDouble()) {
                    "v1 metadata must contain non-negative safe integers"
                }
                value.toLong().toString()
            }
            value is Boolean -> value.toString()
            else -> error("unsupported manifest value")
        }

        private fun quoteJson(value: String): String = buildString {
            append('"')
            for (index in value.indices) {
                val char = value[index]
                when (char) {
                    '"' -> append("\\\"")
                    '\\' -> append("\\\\")
                    '\b' -> append("\\b")
                    '\u000c' -> append("\\f")
                    '\n' -> append("\\n")
                    '\r' -> append("\\r")
                    '\t' -> append("\\t")
                    else -> {
                        val unpaired = Character.isHighSurrogate(char) && (index + 1 == value.length || !Character.isLowSurrogate(value[index + 1])) ||
                            Character.isLowSurrogate(char) && (index == 0 || !Character.isHighSurrogate(value[index - 1]))
                        if (char.code < 0x20 || unpaired) append("\\u%04x".format(char.code)) else append(char)
                    }
                }
            }
            append('"')
        }

        private fun validateRendering(manifest: JSONObject) {
            val rendering = manifest.getJSONObject("rendering")
            val profiles = setOf("skia", "webview", "skyline-compat")
            check(rendering.keys().asSequence().toSet() == setOf("version", "default", "pages") &&
                rendering.opt("version") == "1.0" && rendering.opt("default") in profiles) { "unsupported rendering profile declaration" }
            val pages = rendering.getJSONObject("pages")
            val routes = manifest.getJSONArray("routes")
            val paths = (0 until routes.length()).map { routes.getJSONObject(it).getString("path") }.toSet()
            for (page in pages.keys()) {
                check(page in paths && page.isNotEmpty() && page.split('/').none { it.isEmpty() || it == "." || it == ".." } &&
                    page.none { it.isISOControl() || it in "\\#?:" } && !page.endsWith(".wxml") && !page.endsWith(".json") && pages.opt(page) in profiles) {
                    "invalid rendering page profile"
                }
            }
        }
    }
}

/** Acknowledged pack execution; never inferred from build features or HEAD. */
internal class PortablePackStartup(
    private val manifest: JSONObject,
    private val operations: JSONObject,
    val integrityRoot: String,
    val route: String,
    val templateId: String,
    val engine: String,
    private val moduleIds: JSONArray,
    private val moduleDigests: JSONObject,
    private val rendererBackend: String,
    private val width: Int,
    private val height: Int,
    val sessionId: String,
    private val fixtureId: String,
) {
    private var snapshotSha256: String? = null

    fun recordSnapshot(bytes: ByteArray) {
        val snapshot = JSONObject(bytes.toString(UTF_8))
        check(snapshot.optString("format") == "rgba8-premultiplied") { "snapshot format must be rgba8-premultiplied" }
        check(PortablePack.integer(snapshot.opt("frame_id")) == 1L && PortablePack.integer(snapshot.opt("width")) == width.toLong() &&
            PortablePack.integer(snapshot.opt("height")) == height.toLong()) {
            "snapshot does not match the acknowledged manifest frame"
        }
        val pixels = snapshot.getJSONArray("pixels")
        check(pixels.length().toLong() == width.toLong() * height * 4) { "snapshot pixel buffer length is invalid" }
        val rgba = ByteArray(pixels.length()) { index ->
            val pixel = PortablePack.integer(pixels.get(index))
            check(pixel != null && pixel in 0L..255L) { "invalid RGBA byte" }
            pixel.toByte()
        }
        snapshotSha256 = PortablePack.sha256(rgba)
        snapshot.remove("pixels")
        snapshot.put("pixelCount", rgba.size).put("sha256", snapshotSha256)
        operations.put("render.snapshot", JSONObject().put("status", 0).put("sessionId", sessionId)
            .put("json", snapshot.toString()))
    }

    fun surfaceIdentity(): JSONObject {
        check(snapshotSha256 != null) { "manifest snapshot has not been verified" }
        return JSONObject().put("host", "android").put("engine", engine).put("sessionId", sessionId)
            .put("manifestIntegrity", integrityRoot).put("frameId", 1).put("snapshotSha256", snapshotSha256)
            .put("pack", JSONObject().put("schemaVersion", 1).put("route", route).put("templateId", templateId)
                .put("loadedModules", moduleIds.length()).put("moduleIds", JSONArray(moduleIds.toString()))
                .put("moduleDigests", JSONObject(moduleDigests.toString())).put("renderSource", "manifest")
                .put("rendererBackend", rendererBackend).put("width", width).put("height", height)
                .put("snapshotSha256", snapshotSha256))
    }

    fun executionEvidence(surfaceProbe: JSONObject? = null): JSONObject {
        return JSONObject().put("schemaVersion", 1)
            .put("fixture", JSONObject().put("id", fixtureId).put("sourceCommit", JSONObject.NULL).put("manifest", manifest))
            .put("receipts", JSONArray().put(JSONObject()
                .put("host", "android").put("engine", engine).put("status", "passed")
                .put("sourceCommit", JSONObject.NULL).put("artifactSha256", JSONObject.NULL)
                .put("build", JSONObject().put("status", "unknown").put("sourceCommit", JSONObject.NULL)
                    .put("artifactSha256", JSONObject.NULL).put("host", "android").put("engine", engine))
                .put("fixtureId", fixtureId).put("manifestIntegrity", integrityRoot).put("sessionId", sessionId)
                .put("route", route).put("operations", operations).put("surfaceProbe", surfaceProbe ?: JSONObject.NULL)))
    }

    fun snapshotSummary(): ByteArray = operations.getJSONObject("render.snapshot").getString("json").toByteArray(UTF_8)

    internal fun renderPayload(): JSONObject = JSONObject(operations.getJSONObject("render.commit")
        .getJSONObject("request").getJSONObject("payload").toString())
}
