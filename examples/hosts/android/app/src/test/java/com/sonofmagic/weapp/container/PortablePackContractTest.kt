package com.sonofmagic.weapp.container

import java.io.File
import java.nio.charset.StandardCharsets.UTF_8
import org.json.JSONArray
import org.json.JSONObject

/** Standalone JVM contract test. Does not create Android, EGL, JNI or JS contexts. */
object PortablePackContractTest {
    @JvmStatic
    fun main(args: Array<String>) {
        val root = File(args[0])
        val manifestBytes = File(root, "manifest.json").readBytes()
        val manifest = JSONObject(manifestBytes.toString(UTF_8))
        val files = mutableMapOf("manifest.json" to manifestBytes)
        File(root, "blobs/sha256").listFiles()!!.forEach { files["blobs/sha256/${it.name}"] = it.readBytes() }
        var count = 0
        fun test(name: String, body: () -> Unit) {
            try { body(); count += 1 } catch (failure: Throwable) {
                throw AssertionError(name, failure)
            }
        }
        fun rejected(message: String, body: () -> Unit) {
            val failure = runCatching(body).exceptionOrNull()
            check(failure != null && (failure.message ?: "").contains(message)) {
                "expected rejection containing '$message', got $failure"
            }
        }
        fun load(source: Map<String, ByteArray> = files): PortablePack = PortablePack.load { path ->
            source[path] ?: error("missing: $path")
        }
        fun changedManifest(change: (JSONObject) -> Unit): Map<String, ByteArray> {
            val changed = JSONObject(manifest.toString())
            change(changed)
            changed.getJSONObject("integrity").put("root", "")
            changed.getJSONObject("integrity").put("root", PortablePack.sha256(PortablePack.canonicalJson(changed).toByteArray(UTF_8)))
            return files + ("manifest.json" to changed.toString().toByteArray(UTF_8))
        }
        val modernRoot = File(args[3])
        val modernManifestBytes = File(modernRoot, "manifest.json").readBytes()
        val modernManifest = JSONObject(modernManifestBytes.toString(UTF_8))
        val modernFiles = mutableMapOf("manifest.json" to modernManifestBytes)
        File(modernRoot, "blobs/sha256").listFiles()!!.forEach { modernFiles["blobs/sha256/${it.name}"] = it.readBytes() }
        fun changedModernManifest(change: (JSONObject) -> Unit): Map<String, ByteArray> {
            val changed = JSONObject(modernManifest.toString())
            change(changed)
            changed.getJSONObject("integrity").put("root", "")
            changed.getJSONObject("integrity").put("root", PortablePack.sha256(PortablePack.canonicalJson(changed).toByteArray(UTF_8)))
            return modernFiles + ("manifest.json" to changed.toString().toByteArray(UTF_8))
        }
        test("Unix timer clock preserves wall-clock epoch and millisecond precision") {
            val epochMillis = 1_792_563_456_789L
            check(UnixTimerClock.nowNs(epochMillis) == 1_792_563_456_789_000_000L)
            check(UnixTimerClock.nowNs(epochMillis + 1) - UnixTimerClock.nowNs(epochMillis) == 1_000_000L)
            // A wall-clock adjustment is observed, not hidden behind an uptime anchor.
            check(UnixTimerClock.nowNs(epochMillis - 1000) < UnixTimerClock.nowNs(epochMillis))
            val before = System.currentTimeMillis()
            val observed = UnixTimerClock.nowNs()
            val after = System.currentTimeMillis()
            check(observed / 1_000_000L in before..after && observed % 1_000_000L == 0L)
        }
        test("Unix timer clock rejects negative or overflowing observations before JNI") {
            check(UnixTimerClock.nowNs(0) == 0L)
            val maximumMillis = Long.MAX_VALUE / 1_000_000L
            check(UnixTimerClock.nowNs(maximumMillis) > 0)
            for (invalid in listOf(-1L, Long.MIN_VALUE, maximumMillis + 1, Long.MAX_VALUE)) {
                rejected("ERR_ENGINE") { UnixTimerClock.nowNs(invalid) }
            }
        }
        test("unattached runtime cleanup does not inspect EGL or call native release") {
            val attachment = EglRuntimeAttachment()
            attachment.release({ error("no EGL query needed") }, { error("no attachment") })
            check(!attachment.attached)
        }
        test("bindable context detaches once and a replacement can attach again") {
            val attachment = EglRuntimeAttachment()
            attachment.attachedSuccessfully()
            val modes = mutableListOf<EglContextReleaseMode>()
            attachment.release({ true }, modes::add)
            attachment.release({ error("already released") }, modes::add)
            check(modes == listOf(EglContextReleaseMode.DETACH_CURRENT) && !attachment.attached)
            attachment.attachedSuccessfully()
            check(attachment.attached)
        }
        test("missing window abandons without assuming a surfaceless bind") {
            val attachment = EglRuntimeAttachment().apply { attachedSuccessfully() }
            val modes = mutableListOf<EglContextReleaseMode>()
            var realWindowAttempts = 0
            attachment.release({ realWindowAttempts += 1; false }, modes::add)
            check(realWindowAttempts == 1 && modes == listOf(EglContextReleaseMode.ABANDON))
            check(!attachment.attached)
        }
        test("EGL binding exception still abandons runtime and preserves original failure") {
            val attachment = EglRuntimeAttachment().apply { attachedSuccessfully() }
            val failure = IllegalStateException("bind failed")
            val modes = mutableListOf<EglContextReleaseMode>()
            val caught = runCatching { attachment.release({ throw failure }, modes::add) }.exceptionOrNull()
            check(caught === failure && modes == listOf(EglContextReleaseMode.ABANDON) && !attachment.attached)
        }
        test("failed normal detach abandons once and clears attachment in finally") {
            val attachment = EglRuntimeAttachment().apply { attachedSuccessfully() }
            val failure = IllegalStateException("detach failed")
            val modes = mutableListOf<EglContextReleaseMode>()
            val caught = runCatching {
                attachment.release({ true }) { mode -> modes += mode; if (mode == EglContextReleaseMode.DETACH_CURRENT) throw failure }
            }.exceptionOrNull()
            check(caught === failure && modes == listOf(EglContextReleaseMode.DETACH_CURRENT, EglContextReleaseMode.ABANDON))
            check(!attachment.attached)
        }
        test("abandon failure cannot retain attached flag or hide the normal detach failure") {
            val attachment = EglRuntimeAttachment().apply { attachedSuccessfully() }
            val detach = IllegalStateException("detach failed")
            val abandon = IllegalStateException("abandon failed")
            val caught = runCatching {
                attachment.release({ true }) { mode -> throw if (mode == EglContextReleaseMode.DETACH_CURRENT) detach else abandon }
            }.exceptionOrNull()
            check(caught === detach && caught.suppressed.toList() == listOf(abandon) && !attachment.attached)
        }
        test("direct no-current abandon failure still clears ownership") {
            val attachment = EglRuntimeAttachment().apply { attachedSuccessfully() }
            rejected("abandon failed") { attachment.release({ false }) { error("abandon failed") } }
            check(!attachment.attached)
        }
        test("owned cleanup runs every release stage and preserves all failures") {
            val events = mutableListOf<String>()
            val first = IllegalStateException("native failure")
            val second = IllegalStateException("surface failure")
            val caught = runCatching {
                runEglCleanup({ events += "runtime"; throw first }, { events += "surface"; throw second },
                    { events += "context" }, { events += "display" }, { events += "flags-reset" })
            }.exceptionOrNull()
            check(events == listOf("runtime", "surface", "context", "display", "flags-reset"))
            check(caught === first && caught.suppressed.toList() == listOf(second))
        }
        test("EGL identities serialize as exact unsigned hexadecimal instead of JSON numbers") {
            check(eglIdentityHex(9007199254740993L) == "0x20000000000001")
            check(eglIdentityHex(Long.MIN_VALUE) == "0x8000000000000000")
            check(eglIdentityHex(-1L) == "0xffffffffffffffff")
            val encoded = JSONObject().put("contextId", eglIdentityHex(9007199254740993L))
            check(encoded.get("contextId") is String && encoded.getString("contextId") == "0x20000000000001")
        }
        fun drawable(width: Int, height: Int, context: Long = 7, surface: Long = 11,
            framebuffer: Int = 0): EglDrawableSample = EglDrawableSample(
            DrawableExtent(width, height), context, surface, framebuffer,
            listOf(0, 0, width, height), listOf(0, 0, width, height),
        )
        fun drawableGate(): EglDrawableGate = EglDrawableGate().apply { surfaceCreated() }
        test("matching acquired drawable does not retire the window or alter target epoch") {
            val gate = drawableGate()
            var reads = 0
            val sample = drawable(1080, 2142)
            val prepared = gate.prepare(sample.extent, { reads += 1; sample }, { error("unexpected recreation") })
            check(reads == 1 && prepared.targetEpoch == 1L && !prepared.recreated)
            gate.complete(prepared, sample, sample, sample.extent)
        }
        test("shrink acquires exactly one new backing while preserving current context") {
            val gate = drawableGate()
            val old = drawable(1080, 2142)
            val fresh = drawable(900, 1402, surface = 13)
            val events = mutableListOf<String>()
            var acquired = old
            val prepared = gate.prepare(fresh.extent,
                { events += "query"; acquired }, { events += "recreate-window"; acquired = fresh })
            check(events == listOf("query", "recreate-window", "query"))
            check(prepared.recreated && prepared.targetEpoch == 2L)
            check(prepared.beforeTransition == old && prepared.beforeDraw == fresh)
            check(prepared.beforeTransition.contextId == prepared.beforeDraw.contextId)
            gate.complete(prepared, fresh, fresh, fresh.extent)
        }
        test("growth uses the same acquisition policy instead of a signed offset compensation") {
            val gate = drawableGate()
            val old = drawable(900, 1402)
            val fresh = drawable(1080, 2142, surface = 13)
            var acquired = old
            val prepared = gate.prepare(fresh.extent, { acquired }, { acquired = fresh })
            check(prepared.beforeTransition.extent == old.extent && prepared.beforeDraw.extent == fresh.extent)
            gate.complete(prepared, fresh, fresh, fresh.extent)
        }
        test("persistent mismatch stops before caller draw swap or presented receipt") {
            val gate = drawableGate()
            val old = drawable(1080, 2142)
            var retirements = 0
            var draws = 0
            var swaps = 0
            var presentations = 0
            rejected("still differs") {
                val prepared = gate.prepare(DrawableExtent(900, 1402), { old }, { retirements += 1 })
                draws += 1
                swaps += 1
                gate.complete(prepared, old, old, prepared.expected)
                presentations += 1
            }
            check(retirements == 1 && draws == 0 && swaps == 0 && presentations == 0)
            check(gate.lastAttempt!!.beforeTransition == old && gate.lastAttempt!!.recreated)
            rejected("not active") { gate.prepare(old.extent, { error("must not retry") }, {}) }
        }
        test("failed window retirement preserves original acquisition evidence without a second query") {
            val gate = drawableGate()
            val old = drawable(1080, 2142)
            var reads = 0
            rejected("retirement failed") {
                gate.prepare(DrawableExtent(900, 1402), { reads += 1; old }, { error("retirement failed") })
            }
            check(reads == 1 && gate.lastAttempt!!.beforeTransition == old && !gate.lastAttempt!!.recreated)
            check(gate.lastAttempt!!.recreationAttempted)
        }
        test("failed actual EGL query cannot reuse the previous frame acquisition evidence") {
            val gate = drawableGate()
            val current = drawable(900, 1402)
            gate.prepare(current.extent, { current }, {})
            rejected("query failed") { gate.prepare(current.extent, { error("query failed") }, {}) }
            check(gate.lastAttempt == null)
        }
        test("surface acquisition cannot silently replace the shared EGL context") {
            val gate = drawableGate()
            val old = drawable(1080, 2142)
            val replacedContext = drawable(900, 1402, context = 8, surface = 13)
            var current = old
            rejected("changed context") {
                gate.prepare(replacedContext.extent, { current }, { current = replacedContext })
            }
            check(gate.lastAttempt!!.beforeDraw.contextId == 8L)
        }
        test("owned window rejects a scratch framebuffer before rendering") {
            val gate = drawableGate()
            val scratch = drawable(900, 1402, framebuffer = 4)
            rejected("framebuffer zero") { gate.prepare(scratch.extent, { scratch }, {}) }
        }
        test("post-swap allocation change invalidates presentation despite a matching pre-draw extent") {
            val gate = drawableGate()
            val sample = drawable(900, 1402)
            val prepared = gate.prepare(sample.extent, { sample }, {})
            rejected("extent changed") { gate.complete(prepared, sample, drawable(1080, 2142), sample.extent) }
        }
        test("post-draw current target identity must match the prepared EGL window") {
            val gate = drawableGate()
            val sample = drawable(900, 1402)
            val prepared = gate.prepare(sample.extent, { sample }, {})
            rejected("target changed") { gate.complete(prepared, sample.copy(surfaceId = 13), sample, sample.extent) }
        }
        test("an equal-size surface replacement has a new target epoch and rejects a stale prepared frame") {
            val gate = drawableGate()
            val sample = drawable(900, 1402)
            val prepared = gate.prepare(sample.extent, { sample }, {})
            gate.surfaceLost()
            gate.surfaceCreated()
            rejected("target changed") { gate.complete(prepared, sample, sample, sample.extent) }
        }
        test("lost or changed accepted View geometry cannot receive a presentation receipt") {
            for (expected in listOf(null, DrawableExtent(1080, 2142))) {
                val gate = drawableGate()
                val sample = drawable(900, 1402)
                val prepared = gate.prepare(sample.extent, { sample }, {})
                rejected("View geometry changed") { gate.complete(prepared, sample, sample, expected) }
            }
        }
        test("lost EGL target rejects completion and nonpositive drawable extents reject sampling") {
            val gate = drawableGate()
            val sample = drawable(900, 1402)
            val prepared = gate.prepare(sample.extent, { sample }, {})
            gate.surfaceLost()
            rejected("target changed") { gate.complete(prepared, sample, sample, sample.extent) }
            rejected("invalid EGL drawable extent") { DrawableExtent(0, 1402) }
            rejected("invalid EGL drawable extent") { DrawableExtent(900, -1) }
        }
        fun observation(): AndroidWindowObservation = AndroidWindowObservation(
            4, 6, 20, 40, 2.0, 0, "portrait", 0, 4, 7, 11,
            ObservedInsets(0, 2, 0, 0), ObservedInsets(0, 2, 0, 4), ObservedInsets(0, 0, 0, 0), "contract-observed-insets",
        )
        test("host observations distinguish actual screen, surface, window origin and density") {
            val observed = observation()
            val metrics = observed.metrics()
            check(metrics.getInt("windowWidth") == 2 && metrics.getInt("windowHeight") == 3)
            check(metrics.getInt("screenWidth") == 10 && metrics.getInt("screenHeight") == 20)
            check(metrics.getDouble("statusBarHeight") == 1.0 && metrics.getDouble("screenTop") == 2.0)
            check(metrics.getDouble("pixelRatio") == 2.0 && metrics.getString("deviceOrientation") == "portrait")
            check(!metrics.has("windowTop") && !metrics.has("safeArea"))
            check(observed.raw().getJSONObject("surfaceOrigin").getInt("y") == 11)
            check(observed.raw().getString("safeAreaMapping") == "unknown")
            // Configuration is authoritative; a short viewport does not change device orientation.
            check(observed.copy(surfaceWidth = 10, surfaceHeight = 2).metrics().getString("deviceOrientation") == "portrait")
            check(observed.copy(surfaceWidth = 5).windowWidth == 3) // positive half rounds upward
        }
        test("invalid actual observations reject instead of repairing density or logical extents") {
            rejected("density") { observation().copy(density = 0.0) }
            rejected("density") { observation().copy(density = Double.NaN) }
            rejected("extent") { observation().copy(surfaceWidth = 0) }
            rejected("logical extent") { observation().copy(density = 100.0) }
            rejected("orientation") { observation().copy(deviceOrientation = "undefined") }
            rejected("insets") { observation().copy(insetsSource = "") }
            rejected("negative window inset") { ObservedInsets(-1, 0, 0, 0) }
        }
        test("window collector captures before parent consumption and returns exact default policy result") {
            val events = mutableListOf<String>()
            var childDispatches = 0
            var defaultCalls = 0
            val collector = WindowObservationCoordinator<String, String>({}, events::add)
            val consumed = Any()
            val result = collector.dispatchInsets("raw-window-insets") { defaultCalls += 1; consumed }
            // The framework dispatch tree does not reach the child after consumption.
            if (result !== consumed) childDispatches += 1
            check(result === consumed && defaultCalls == 1 && childDispatches == 0)
            check(events.isEmpty())
            collector.afterLayout { raw -> "$raw:laid-out-surface" }
            check(events == listOf("raw-window-insets:laid-out-surface"))
        }
        test("window collector cannot read geometry before a real initial dispatch") {
            val collector = WindowObservationCoordinator<String, String>({}, { error("not ready") })
            collector.geometryChanged()
            collector.afterLayout { error("must not read cached or invented Insets") }
            check(collector.pendingReason() == "waiting-for-window-insets")
        }
        test("window dispatch never commits reentrantly inside default onApply layout") {
            val events = mutableListOf<String>()
            val collector = WindowObservationCoordinator<String, String>({}, events::add)
            collector.dispatchInsets("raw") {
                collector.afterLayout { error("default Insets policy has not returned") }
                "consumed"
            }
            check(events.isEmpty())
            collector.afterLayout { "after-layout:$it" }
            check(events == listOf("after-layout:raw"))
        }
        test("insets before Surface creation and Surface before Insets both wait for ready join") {
            for (insetsFirst in listOf(true, false)) {
                val events = mutableListOf<String>()
                val collector = WindowObservationCoordinator<String, String>({}, events::add)
                var actualSurface: String? = null
                if (insetsFirst) collector.dispatchInsets("raw") { "consumed" }
                collector.afterLayout { actualSurface }
                check(events.isEmpty())
                actualSurface = "actual-surface"
                collector.geometryChanged()
                if (!insetsFirst) {
                    collector.afterLayout { error("no Insets yet") }
                    collector.dispatchInsets("raw") { "consumed" }
                }
                collector.afterLayout { "$it:$actualSurface" }
                check(events == listOf("raw:actual-surface"))
            }
        }
        test("forced resume waits new window dispatch then emits identical observation once") {
            val events = mutableListOf<String>()
            val collector = WindowObservationCoordinator<String, String>({}, events::add)
            collector.dispatchInsets("raw") { "consumed" }
            collector.afterLayout { "same" }
            collector.refresh(true)
            collector.refresh(false)
            collector.geometryChanged()
            collector.afterLayout { error("stale Insets must not release resume") }
            check(collector.pendingReason() == "waiting-for-fresh-window-insets")
            collector.dispatchInsets("raw") { "consumed" }
            collector.afterLayout { "same" }
            collector.afterLayout { error("already committed") }
            collector.dispatchInsets("raw") { "consumed" }
            collector.afterLayout { "same" }
            check(events == listOf("same", "same"))
        }
        test("resume requested after raw arrival before layout requires another dispatch epoch") {
            val events = mutableListOf<String>()
            val collector = WindowObservationCoordinator<String, String>({}, events::add)
            collector.dispatchInsets("old") { "consumed" }
            collector.refresh(true)
            collector.afterLayout { error("old epoch cannot release later force") }
            collector.dispatchInsets("fresh") { "consumed" }
            collector.afterLayout { it }
            check(events == listOf("fresh"))
        }
        test("window collector coalesces raw changes before one layout using newest incoming Insets") {
            val events = mutableListOf<String>()
            val collector = WindowObservationCoordinator<String, String>({}, events::add)
            collector.dispatchInsets("old") { "consumed" }
            collector.dispatchInsets("new") { "consumed" }
            collector.afterLayout { "$it:current-surface" }
            check(events == listOf("new:current-surface"))
        }
        test("unready Surface never replaces a previous valid window observation") {
            val events = mutableListOf<String>()
            val collector = WindowObservationCoordinator<String, String>({}, events::add)
            collector.dispatchInsets("raw") { "consumed" }
            collector.afterLayout { "old" }
            collector.geometryChanged()
            collector.afterLayout { null }
            check(collector.latest == "old" && events == listOf("old"))
            collector.afterLayout { "new" }
            check(collector.latest == "new" && events == listOf("old", "new"))
        }
        test("lost Surface requires an actual ready replacement without inventing new Insets") {
            val events = mutableListOf<String>()
            val collector = WindowObservationCoordinator<String, String>({}, events::add)
            collector.dispatchInsets("raw") { "consumed" }
            collector.afterLayout { "same" }
            collector.surfaceLost()
            collector.afterLayout { null }
            check(collector.latest == null)
            collector.geometryChanged()
            collector.afterLayout { "same" }
            check(events == listOf("same", "same"))
        }
        test("Decor reattachment requires fresh window Insets while Surface-only recreation can reuse current epoch") {
            val events = mutableListOf<String>()
            val collector = WindowObservationCoordinator<String, String>({}, events::add)
            collector.dispatchInsets("old-window") { "consumed" }
            collector.afterLayout { it }
            collector.surfaceLost()
            collector.afterLayout { null } // Detached Decor is not a readable Surface.
            collector.refresh(force = true) // Production Decor attach listener runs this before requestApplyInsets.
            collector.geometryChanged()
            collector.afterLayout { error("new Window attachment cannot use old root Insets") }
            check(events == listOf("old-window"))
            collector.dispatchInsets("new-window") { "consumed" }
            collector.afterLayout { it }
            check(events == listOf("old-window", "new-window"))
            collector.surfaceLost()
            collector.geometryChanged() // Only the Surface recreated, not its Window.
            collector.afterLayout { it }
            check(events == listOf("old-window", "new-window", "new-window"))
        }
        test("closed collector releases pending observations and preserves later platform default behavior") {
            var requested = 0
            val collector = WindowObservationCoordinator<String, String>({ requested += 1 }, { error("closed") })
            collector.dispatchInsets("raw") { "consumed" }
            collector.close()
            val before = requested
            collector.refresh(true)
            collector.geometryChanged()
            collector.surfaceLost()
            collector.afterLayout { error("closed geometry must not be read") }
            check(collector.dispatchInsets("later") { "default-result" } == "default-result")
            check(requested == before && collector.latest == null && collector.pendingReason() == "closed")
        }
        test("failed default Insets application cannot become usable window evidence") {
            val events = mutableListOf<String>()
            val collector = WindowObservationCoordinator<String, String>({}, events::add)
            rejected("default failed") { collector.dispatchInsets("bad") { error("default failed") } }
            collector.afterLayout { error("failed default must not commit") }
            collector.dispatchInsets("good") { "consumed" }
            collector.afterLayout { it }
            check(events == listOf("good"))
        }
        test("initial display metadata reaches native config before module execution") {
            val runtime = RecordingRuntime()
            val observed = observation()
            load().start(runtime, width = observed.windowWidth, height = observed.windowHeight, windowObservation = observed)
            val host = runtime.config.getJSONObject("host")
            check(host.getInt("windowWidth") == 2 && host.getJSONObject("displayMetrics").getInt("screenHeight") == 20)
            check(runtime.displayAtModuleStart?.getDouble("pixelRatio") == 2.0)
            check(runtime.displayAtModuleStart?.getDouble("screenTop") == 2.0)
            check(!host.getJSONObject("displayMetrics").has("safeArea"))
            val before = runtime.loadCount
            rejected("differs from observed") { load().start(runtime, width = 3, height = 3, windowObservation = observed) }
            check(runtime.loadCount == before)
        }
        test("packer canonical bytes agree for BMP/astral keys, escapes and surrogate values") {
            val input = JSONObject(File(args[1]).readText())
            check(PortablePack.canonicalJson(input) == File(args[2]).readText())
            // The ordering that used to reject valid portable packs is
            // intentionally different from Kotlin's UTF-16 String order.
            check("😀" < "\uffff")
            check(PortablePack.canonicalJson(JSONObject().put("😀", 1).put("\uffff", 2)) == "{\"\uffff\":2,\"😀\":1}")
        }
        test("independent Node pack root loads") {
            check(load().integrityRoot == manifest.getJSONObject("integrity").getString("root"))
        }
        test("legacy pack without View compilation loads") {
            load(changedManifest { it.remove("viewScripts"); it.remove("viewCompilation") })
        }
        val modernUnit = modernManifest.getJSONObject("modernView").getJSONArray("units").getJSONObject(0)
        val modernDigests = mutableListOf(modernUnit.getString("executableSha256"), modernUnit.getString("sourceMapSha256"))
        val modernSources = modernUnit.getJSONArray("sources")
        for (index in 0 until modernSources.length()) modernDigests += modernSources.getJSONObject(index).getString("sha256")
        test("real TypeScript modern schema-v2 closure reaches both startup batches") {
            val modern = load(modernFiles)
            check(modern.integrityRoot == modernManifest.getJSONObject("integrity").getString("root"))
            val map = JSONObject(modernFiles["blobs/sha256/${modernUnit.getString("sourceMapSha256")}"]!!.toString(UTF_8))
            check(map.getJSONArray("sourcesContent").toString().contains("interface Input"))
            val runtime = RecordingRuntime()
            modern.start(runtime, width = 2, height = 3)
            for (request in runtime.requests.filter { it.getString("op") in listOf("app.init", "render.commit") }) {
                val blobs = request.getJSONObject("payload").getJSONObject("blobs")
                for (digest in modernDigests) check(blobs.has("sha256:$digest"))
            }
        }
        for (digest in modernDigests) {
            val path = "blobs/sha256/$digest"
            test("missing modern closure $digest fails atomically") { rejected("missing:") { load(modernFiles - path) } }
            test("corrupt modern closure $digest fails atomically") { rejected("blob SHA-256 mismatch") { load(modernFiles + (path to byteArrayOf(1))) } }
        }
        test("modern schema and compiler identity fail closed with recomputed roots") {
            for (invalid in listOf<Any>(1, 3, "2", true)) {
                rejected(when (invalid) { 1 -> "modernView requires"; 3 -> "rendering requires schema 3"; else -> "unsupported portable pack schema" }) {
                    load(changedModernManifest { it.put("schemaVersion", invalid) })
                }
            }
            rejected("unsupported portable pack schema") {
                load(modernFiles + ("manifest.json" to JSONObject(modernManifest.toString()).put("schemaVersion", 2.5).toString().toByteArray(UTF_8)))
            }
            rejected("modernView requires") { load(changedModernManifest { it.remove("modernView") }) }
            for (field in listOf("compiler", "version", "abi", "target")) {
                rejected("unsupported modernView compiler") {
                    load(changedModernManifest { it.getJSONObject("modernView").put(field, "unsupported") })
                }
            }
        }
        test("schema v3 rendering profiles preserve legacy and modern verified resource closures") {
            val profiles = JSONObject().put("version", "1.0").put("default", "skia").put("pages", JSONObject())
            val legacy = load(changedManifest { it.put("schemaVersion", 3).put("rendering", profiles) })
            val modern = load(changedModernManifest { it.put("schemaVersion", 3).put("rendering", profiles) })
            for (pack in listOf(legacy, modern)) {
                val runtime = RecordingRuntime()
                pack.start(runtime, width = 2, height = 3, pageRenderMode = "native-gpu")
                check(runtime.config.getString("page_render_mode") == "native-gpu")
            }
            for (value in listOf<Any>(JSONObject.NULL,
                JSONObject().put("version", "1.0").put("default", "native").put("pages", JSONObject()),
                JSONObject().put("version", "1.0").put("default", "skia").put("pages", JSONObject().put("undeclared", "webview")),
                JSONObject().put("version", "1.0").put("default", "skia").put("pages", JSONObject()).put("unknown", true))) {
                check(runCatching { load(changedManifest { it.put("schemaVersion", 3).put("rendering", value) }) }.isFailure)
            }
            rejected("rendering requires schema 3") { load(changedManifest { it.put("rendering", profiles) }) }
        }
        test("tampered manifest fails before native load") {
            val source = files + ("manifest.json" to manifest.toString().replace("commonjs", "esm").toByteArray(UTF_8))
            rejected("integrity root mismatch") { load(source) }
        }
        val refs = mutableListOf<Pair<String, String>>()
        val scripts = manifest.getJSONArray("viewScripts")
        refs += "WXS source" to scripts.getJSONObject(0).getString("sha256")
        val compilation = manifest.getJSONObject("viewCompilation")
        refs += "WXS executable" to compilation.getJSONArray("modules").getJSONObject(0).getString("executableSha256")
        val document = compilation.getJSONArray("documents").getJSONObject(0)
        refs += "WXML AST" to document.getString("wxmlAst")
        refs += "WXML executable" to document.getJSONArray("expressions").getJSONObject(0).getString("executableSha256")
        for ((name, pointer) in refs) {
            val path = "blobs/sha256/${pointer.removePrefix("sha256:")}"
            test("missing $name fails atomically") { rejected("missing:") { load(files - path) } }
            test("corrupt $name fails atomically") { rejected("blob SHA-256 mismatch") { load(files + (path to byteArrayOf(1))) } }
        }
        test("present malformed compilation is not treated as absent") {
            rejected("viewCompilation") { load(changedManifest { it.put("viewCompilation", JSONObject.NULL) }) }
        }
        test("manifest pointer traversal fails before file IO") {
            rejected("invalid blob pointer") {
                load(changedManifest { it.getJSONArray("viewScripts").getJSONObject(0).put("sha256", "sha256:../outside") })
            }
        }
        test("startup loads exact modules and resources once then renders live page data") {
            val runtime = RecordingRuntime()
            val started = load().start(runtime, width = 2, height = 3)
            check(runtime.loaded.contentEquals(manifestBytes))
            check(runtime.requests.map { it.getString("op") } == listOf("app.init", "app.lifecycle", "page.push", "render.commit"))
            val init = runtime.requests[0].getJSONObject("payload")
            check(init.getJSONArray("modules").length() == manifest.getJSONArray("modules").length())
            val loaded = init.getJSONArray("modules")
            for (index in 0 until loaded.length()) {
                val declaration = manifest.getJSONArray("modules").getJSONObject(index)
                val source = loaded.getJSONObject(index)
                check(source.getString("id") == declaration.getString("id"))
                check(source.getString("source").toByteArray(UTF_8).contentEquals(files["blobs/sha256/${declaration.getString("sha256")}"]))
            }
            for ((_, pointer) in refs) check(init.getJSONObject("blobs").has("sha256:${pointer.removePrefix("sha256:")}"))
            val render = runtime.requests.last().getJSONObject("payload")
            check(render.getString("templateId") == "template:pages/index/index.wxml")
            check(!render.has("root") && !render.has("frame") && !render.has("data"))
            check(started.route == "pages/index/index")
            rejected("snapshot has not been verified") { started.surfaceIdentity() }
            val snapshot = JSONObject().put("format", "rgba8-premultiplied").put("frame_id", 1).put("width", 2).put("height", 3)
                .put("pixels", JSONArray(List(24) { it }))
            started.recordSnapshot(snapshot.toString().toByteArray(UTF_8))
            val identity = started.surfaceIdentity()
            check(identity.getString("engine") == "quickjs")
            check(identity.getString("sessionId") == "session-1")
            check(identity.getString("manifestIntegrity") == started.integrityRoot)
            check(identity.getLong("frameId") == 1L)
            check(identity.getJSONObject("pack").getString("snapshotSha256") == PortablePack.sha256(ByteArray(24) { it.toByte() }))
            val summary = JSONObject(started.snapshotSummary().toString(UTF_8))
            check(identity.getString("snapshotSha256") == summary.getString("sha256"))
            check(identity.getString("snapshotSha256") == PortablePack.sha256(ByteArray(24) { it.toByte() }))
            val evidence = started.executionEvidence(identity)
            val receipt = evidence.getJSONArray("receipts").getJSONObject(0)
            check(receipt.getJSONObject("build").getString("status") == "unknown")
            check(receipt.isNull("sourceCommit") && receipt.isNull("artifactSha256"))
            check(receipt.getString("fixtureId") == "portable-pack-reference-v1")
            check(receipt.getJSONObject("operations").getJSONObject("render.snapshot").getString("sessionId") == "session-1")
            check(receipt.getJSONObject("surfaceProbe").getString("snapshotSha256") ==
                JSONObject(receipt.getJSONObject("operations").getJSONObject("render.snapshot").getString("json")).getString("sha256"))
            check(evidence.getJSONObject("fixture").getJSONObject("manifest").getJSONObject("integrity").getString("root") == started.integrityRoot)
        }
        test("V8 receipt reports observed engine without implicit fallback") {
            val runtime = RecordingRuntime()
            val started = load().start(runtime, width = 1, height = 1, engine = "v8", sessionId = "custom-v8", fixtureId = "custom-fixture")
            check(started.engine == "v8")
            check(runtime.config.getString("engine") == "v8")
            check(runtime.config.getString("session_id") == "custom-v8")
            check(runtime.config.getBoolean("require_integrity"))
            check(runtime.requests.all { it.getString("sessionId") == "custom-v8" })
            check(started.executionEvidence().getJSONObject("fixture").getString("id") == "custom-fixture")
        }
        test("requested V8 cannot silently acknowledge QuickJS") {
            val runtime = RecordingRuntime { op, response ->
                if (op == "app.init") response.getJSONObject("payload").put("engine", "quickjs")
            }
            rejected("ERR_ENGINE") { load().start(runtime, engine = "v8") }
            check(runtime.requests.size == 1)
        }
        test("requested unknown route and zero viewport fail before native mutation") {
            val runtime = RecordingRuntime()
            rejected("route is not declared") { load().start(runtime, route = "unknown") }
            rejected("positive") { load().start(runtime, width = 0) }
            rejected("ERR_ENGINE") { load().start(runtime, engine = "invalid") }
            rejected("sessionId") { load().start(runtime, sessionId = "") }
            rejected("fixtureId") { load().start(runtime, fixtureId = "") }
            check(runtime.loaded.isEmpty() && runtime.requests.isEmpty())
        }
        test("rejected native manifest stops startup") {
            val runtime = RecordingRuntime(loadStatus = -1)
            rejected("Rust rejected") { load().start(runtime) }
            check(runtime.requests.isEmpty())
        }
        for ((field, value) in listOf("sessionId" to "other-session", "requestId" to "stale", "op" to "other.op",
            "kind" to "event", "protocolVersion" to "2.0")) {
            test("$field mismatch cannot acknowledge startup") {
                val runtime = RecordingRuntime { _, response -> response.put(field, value) }
                rejected("correlated") { load().start(runtime) }
                check(runtime.requests.size == 1)
            }
        }
        for ((label, change) in listOf<Pair<String, (JSONObject) -> Unit>>(
            "provider" to { it.put("engineProviderAvailable", false) },
            "engine" to { it.put("engine", "protocol-only") },
            "modules" to { it.put("loadedModules", 0) },
            "root" to { it.getJSONObject("manifest").put("integrity", "0".repeat(64)) },
            "structured error" to { it.put("ok", false).put("error", JSONObject().put("code", "ERR_ENGINE")) },
            "coerced provider" to { it.put("engineProviderAvailable", "true") },
            "coerced count" to { it.put("loadedModules", "4") },
            "coerced ok" to { it.put("ok", "true") },
        )) {
            test("invalid app.init $label stops before lifecycle/page/render") {
                val runtime = RecordingRuntime { op, response -> if (op == "app.init") change(response.getJSONObject("payload")) }
                check(runCatching { load().start(runtime) }.isFailure)
                check(runtime.requests.size == 1)
            }
        }
        for ((field, value) in listOf("source" to "frame", "templateId" to "template:other.wxml", "frameId" to 2, "committed" to false)) {
            test("unrelated $field cannot acknowledge manifest rendering") {
                val runtime = RecordingRuntime { op, response -> if (op == "render.commit") response.getJSONObject("payload").put(field, value) }
                rejected("requested manifest frame") { load().start(runtime) }
            }
        }
        for ((index, operation) in listOf("app.init", "app.lifecycle", "page.push", "render.commit").withIndex()) {
            for ((errorOperation, errorKind) in listOf("error" to "event", "api.result" to "response")) {
                test("successful $operation acknowledgement cannot hide sibling $errorOperation failure") {
                    val runtime = RecordingRuntime(mutateBatch = { op, messages ->
                        if (op == operation) {
                            val failure = JSONObject().put("committed", op == "render.commit")
                                .put("error", JSONObject().put("code", "ERR_ENGINE").put("message", "ready effect threw"))
                            if (errorKind == "response") failure.put("ok", false)
                            messages.put(JSONObject(messages.getJSONObject(0).toString())
                                .put("kind", errorKind).put("op", errorOperation).put("requestId", "effect-failure")
                                .put("payload", failure))
                        }
                    })
                    rejected("bridge batch failed") { load().start(runtime) }
                    check(runtime.requests.size == index + 1)
                }
            }
        }
        test("nonfailure diagnostics remain valid startup observations") {
            val runtime = RecordingRuntime(mutateBatch = { _, messages ->
                messages.put(JSONObject(messages.getJSONObject(0).toString()).put("kind", "event").put("op", "diagnostic")
                    .put("payload", JSONObject().put("level", "warning").put("message", "sandbox capability partial")))
            })
            check(load().start(runtime).route == "pages/index/index")
            check(runtime.requests.size == 4)
        }
        test("snapshot frame, size and byte validation precede surface evidence") {
            val started = load().start(RecordingRuntime(), width = 1, height = 1)
            val snapshot = JSONObject().put("format", "rgba8-premultiplied").put("frame_id", 2).put("width", 1).put("height", 1).put("pixels", JSONArray(listOf(0, 1, 2, 3)))
            rejected("acknowledged manifest frame") { started.recordSnapshot(snapshot.toString().toByteArray()) }
            snapshot.put("frame_id", 1).put("width", 2)
            rejected("acknowledged manifest frame") { started.recordSnapshot(snapshot.toString().toByteArray()) }
            snapshot.put("width", 1).put("pixels", JSONArray(listOf(0, 1, 2)))
            rejected("length") { started.recordSnapshot(snapshot.toString().toByteArray()) }
            snapshot.put("pixels", JSONArray(listOf(0, 1, 2, 256)))
            rejected("RGBA") { started.recordSnapshot(snapshot.toString().toByteArray()) }
            rejected("not been verified") { started.surfaceIdentity() }
        }
        fun interactive(runtime: RecordingRuntime = RecordingRuntime()): Triple<PortablePackSession, RecordingRuntime, MutableList<JSONObject>> {
            val started = load().start(runtime, width = 2, height = 3, sessionId = "interaction-contract")
            val receipts = mutableListOf<JSONObject>()
            lateinit var session: PortablePackSession
            session = PortablePackSession(started, runtime, runtime.presentationState(), onFrame = { }, onReceipt = { receipts += it })
            session.resize(4, 6, 2.0, 7, 11)
            return Triple(session, runtime, receipts)
        }
        test("native presentation metadata rejects unrelated or stale frames before publishing") {
            val changes = listOf<(JSONObject) -> Unit>(
                { it.put("sessionId", "foreign") },
                { it.getJSONObject("frame").put("frame_id", 999) },
                { it.getJSONObject("frame").getJSONObject("viewport").put("width", 4) },
                { it.put("viewRevision", 0) },
            )
            for (change in changes) {
                val (session, runtime, receipts) = interactive()
                runtime.presentationMutation = change
                session.pointer("down", 0, 0.0, 0.0, 1, 1.0)
                check(!session.isRunnable())
                check(receipts.last().getString("status") == "suspended")
                check(receipts.last().getJSONObject("presentation").getLong("frameId") == 1L)
                check(receipts.last().getJSONArray("diagnostics").length() == 1)
            }
        }
        test("metadata-only event and resize presentation has no RGBA or render tree") {
            val runtime = RecordingRuntime()
            val started = load().start(runtime, width = 2, height = 3, pageRenderMode = "native-gpu")
            val frames = mutableListOf<CommittedFrame>()
            val session = PortablePackSession(started, runtime, runtime.presentationState(), onFrame = frames::add, onReceipt = {})
            session.pointer("down", 0, 0.0, 0.0, 1, 1.0)
            session.resize(8, 12, 2.0, 0, 0)
            check(frames.size == 2 && frames.last().width == 4 && frames.last().height == 6)
            val metadata = runtime.presentationState().toString(UTF_8)
            check(!metadata.contains("pixels") && !metadata.contains("root") && !metadata.contains("page"))
            check(frames.last().sessionId == started.sessionId)
            session.close()
        }
        test("GPU submission acknowledges readiness only after present and drains resulting data on the next pump") {
            val (session, runtime, receipts) = interactive()
            check(runtime.presentationAcks.isEmpty())
            runtime.ackChangesData = true
            session.presented(1, "skia-gpu-gles", JSONObject().put("width", 4).put("height", 6))
            check(runtime.presentationAcks == listOf(1L))
            check(receipts.last().getJSONObject("presentation").getLong("frameId") == 1L)
            val renders = runtime.requests.count { it.getString("op") == "render.commit" }
            session.pollTimers(1)
            check(runtime.requests.count { it.getString("op") == "render.commit" } == renders + 1)
            session.pollTimers(2)
            check(runtime.requests.count { it.getString("op") == "render.commit" } == renders + 1)
            session.close()
        }
        test("surface failure preserves business timers and lifecycle without automatic redraw until explicit retry") {
            val (session, runtime, receipts) = interactive()
            session.surfaceLost()
            session.reportPresentationFailure(IllegalStateException("EGL context lost"))
            check(session.canPumpTimers() && !session.isRunnable())
            check(!receipts.last().getBoolean("runtimeFailed") && receipts.last().getBoolean("presentationSuspended"))
            val renders = runtime.requests.count { it.getString("op") == "render.commit" }
            runtime.timerDueNs = 25
            session.pollTimers(25)
            session.pollTimers(26)
            check(runtime.timerFired == 1 && runtime.timerPolls == listOf(25L, 26L))
            check(receipts.last().getJSONObject("page").getJSONObject("data").getInt("count") == 1)
            session.pointer("down", 0, 0.0, 0.0, 27, 1.0)
            session.setForeground(false)
            session.pollTimers(28)
            session.setForeground(true)
            check(runtime.timerPolls == listOf(25L, 26L))
            check(runtime.requests.count { it.getString("op") == "render.commit" } == renders)
            check(runtime.requests.none { it.getString("op") == "event.batch" })
            session.retryPresentation()
            check(runtime.requests.count { it.getString("op") == "render.commit" } == renders + 1)
            check(!session.isRunnable()) // A prepared frame is not a successful presentation.
            val frame = receipts.last().getJSONObject("presentation").getLong("frameId")
            session.presented(frame, "skia-gpu-gles", JSONObject().put("width", 4).put("height", 6))
            check(session.isRunnable() && !receipts.last().getBoolean("presentationSuspended"))
            session.close()
            session.pollTimers(29)
            check(runtime.timerPolls == listOf(25L, 26L))
        }
        test("synchronous presenter and post-submit ACK errors cannot stop the business clock") {
            val runtime = RecordingRuntime()
            val started = load().start(runtime, width = 2, height = 3)
            val receipts = mutableListOf<JSONObject>()
            var attempts = 0
            val session = PortablePackSession(started, runtime, runtime.presentationState(),
                onFrame = { attempts += 1; throw IllegalStateException("present rejected") }, onReceipt = { receipts += it })
            session.pointer("down", 0, 0.0, 0.0, 1, 1.0)
            check(!session.isRunnable() && session.canPumpTimers())
            runtime.timerDueNs = 10
            session.pollTimers(10)
            check(runtime.timerFired == 1 && attempts == 1)
            runtime.ackRejected = true
            session.presented(receipts.last().getJSONObject("presentation").getLong("frameId"), "skia-gpu-gles",
                JSONObject().put("width", 2).put("height", 3))
            runtime.timerDueNs = 20
            session.pollTimers(20)
            check(runtime.timerFired == 2 && attempts == 1 && session.canPumpTimers())
            check(receipts.last().getJSONArray("diagnostics").length() == 2)
            session.close()
        }
        test("same-size replacement Surface re-presents committed frame after valid join without native update or render") {
            val (session, runtime, receipts) = interactive()
            var actualObservation = observation()
            val collector = WindowObservationCoordinator<String, AndroidWindowObservation>({}, { session.synchronizeWindow(it, true) })
            var pendingPresentation = true
            var surfaceReady = true
            fun preDraw() {
                val ready = collector.afterLayout { if (surfaceReady) actualObservation else null }
                if (ready && pendingPresentation && session.isRunnable()) {
                    session.presented(1, "recording-surface", actualObservation.geometry())
                    pendingPresentation = false
                }
            }
            collector.dispatchInsets("raw") { "consumed" }
            preDraw()
            val metricsCalls = runtime.windowMetricsCalls
            val runtimeRequests = runtime.requests.size
            val identity = receipts.last().getString("sessionId")
            collector.geometryChanged()
            preDraw() // An existing Surface without invalidation does not redraw.
            check(receipts.last().getJSONObject("surface").getLong("presentationSequence") == 1L)
            collector.surfaceLost()
            session.surfaceLost()
            surfaceReady = false
            pendingPresentation = true
            preDraw()
            check(receipts.last().getJSONObject("surface").getLong("presentedFrameId") == 0L)
            surfaceReady = true
            collector.geometryChanged()
            preDraw()
            check(runtime.windowMetricsCalls == metricsCalls && runtime.requests.size == runtimeRequests)
            check(receipts.last().getString("sessionId") == identity && receipts.last().getJSONObject("frame").getLong("frame_id") == 1L)
            check(receipts.last().getJSONObject("surface").getLong("presentationSequence") == 2L)
            // A same-size callback still reports layout readiness; semantic
            // native deduplication must not swallow a pending Surface redraw.
            pendingPresentation = true
            collector.geometryChanged()
            preDraw()
            check(runtime.windowMetricsCalls == metricsCalls && runtime.requests.size == runtimeRequests)
            check(receipts.last().getJSONObject("surface").getLong("presentationSequence") == 3L)
            actualObservation = actualObservation.copy(statusBars = ObservedInsets(0, 3, 0, 0))
            collector.dispatchInsets("metadata-change") { "consumed" }
            preDraw()
            check(runtime.windowMetricsCalls == metricsCalls + 1)
            check(receipts.last().getJSONObject("surface").getLong("presentationSequence") == 3L)
            collector.refresh(true)
            pendingPresentation = true
            collector.geometryChanged()
            preDraw()
            check(pendingPresentation) // Cached Insets cannot authorize redraw.
            collector.dispatchInsets("fresh") { "consumed" }
            preDraw()
            check(!pendingPresentation && receipts.last().getJSONObject("surface").getLong("presentationSequence") == 4L)
            runtime.rejectWindowMetrics = true
            actualObservation = actualObservation.copy(density = 1.0)
            pendingPresentation = true
            collector.dispatchInsets("failed-update") { "consumed" }
            preDraw()
            check(pendingPresentation && !session.isRunnable())
            check(receipts.last().getJSONObject("surface").getLong("presentationSequence") == 4L)
        }
        test("density and inset-only updates cross native once without resize hooks or rendering") {
            val (session, runtime, receipts) = interactive()
            session.updateWindowObservation(observation())
            val before = runtime.requests.size
            val updated = observation().copy(surfaceWidth = 8, surfaceHeight = 12, displayWidth = 40, displayHeight = 80,
                density = 4.0, windowOriginY = 8, statusBars = ObservedInsets(0, 8, 0, 0))
            session.updateWindowObservation(updated)
            session.updateWindowObservation(updated)
            check(runtime.windowMetricsCalls == 2 && runtime.resizeHooks == 0 && runtime.requests.size == before)
            check(receipts.last().getJSONObject("displayMetrics").getDouble("pixelRatio") == 4.0)
            check(receipts.last().getJSONObject("displayMetrics").getDouble("statusBarHeight") == 2.0)
            check(receipts.last().getJSONObject("windowObservation").getInt("displayHeight") == 80)
            check(receipts.last().getJSONObject("frame").getLong("frame_id") == 1L)
        }
        test("whole window update preserves session, rerenders changed viewport and keeps actual orientation") {
            val (session, runtime, receipts) = interactive()
            session.updateWindowObservation(observation())
            session.updateWindowObservation(observation().copy(surfaceWidth = 12, surfaceHeight = 8))
            check(runtime.windowMetricsCalls == 2 && runtime.resizeHooks == 1 && runtime.loadCount == 1)
            val receipt = receipts.last()
            check(receipt.getString("sessionId") == "interaction-contract")
            check(receipt.getJSONObject("hostWindow").getInt("width") == 6)
            check(receipt.getJSONObject("displayMetrics").getString("deviceOrientation") == "portrait")
            check(receipt.getJSONObject("frame").getLong("frame_id") == 2L)
        }
        test("failed window transaction retains observation and suspends subsequent input") {
            val (session, runtime, receipts) = interactive()
            session.updateWindowObservation(observation())
            runtime.rejectWindowMetrics = true
            session.updateWindowObservation(observation().copy(density = 1.0))
            check(receipts.last().getString("status") == "suspended")
            check(receipts.last().getJSONObject("windowObservation").getDouble("density") == 2.0)
            check(receipts.last().getJSONObject("viewport").getInt("width") == 2)
            val requests = runtime.requests.size
            session.pointer("down", 0, 0.0, 0.0, 1, 1.0)
            check(runtime.requests.size == requests)
        }
        test("resume refreshes complete metrics before invoking App and Page show hooks") {
            val (session, runtime, receipts) = interactive()
            session.synchronizeWindow(observation(), true)
            session.setForeground(false)
            runtime.hostCallOrder.clear()
            val updated = observation().copy(surfaceWidth = 8, surfaceHeight = 12, displayWidth = 40, displayHeight = 80,
                density = 4.0, statusBars = ObservedInsets(0, 8, 0, 0))
            session.synchronizeWindow(updated, true)
            check(runtime.hostCallOrder.take(2) == listOf("windowMetrics", "show"))
            check(runtime.displayAtShow?.getDouble("pixelRatio") == 4.0)
            check(runtime.displayAtShow?.getDouble("statusBarHeight") == 2.0)
            check(receipts.last().getBoolean("foreground"))
        }
        test("unchanged raw observation still completes a pending resume without duplicate metrics or show") {
            val (session, runtime) = interactive()
            session.synchronizeWindow(observation(), true)
            session.setForeground(false)
            val updates = runtime.windowMetricsCalls
            runtime.hostCallOrder.clear()
            session.synchronizeWindow(observation(), true)
            session.synchronizeWindow(observation(), true)
            check(runtime.windowMetricsCalls == updates)
            check(runtime.hostCallOrder == listOf("show"))
        }
        test("rejected resume observation never invokes show hooks") {
            val (session, runtime, receipts) = interactive()
            session.synchronizeWindow(observation(), true)
            session.setForeground(false)
            runtime.rejectWindowMetrics = true
            runtime.hostCallOrder.clear()
            session.synchronizeWindow(observation().copy(density = 1.0), true)
            check(runtime.hostCallOrder == listOf("windowMetrics"))
            check(!receipts.last().getBoolean("foreground") && receipts.last().getString("status") == "suspended")
        }
        test("single-pointer physical coordinates use local surface ratio and batch end with tap") {
            val (session, runtime, receipts) = interactive()
            session.setForeground(true)
            session.pointerOnSurface("down", 4, 2.0, 4.0, 10, 1.0)
            session.pointerOnSurface("up", 4, 2.0, 4.0, 20, 1.0)
            val payload = runtime.requests.last { it.getString("op") == "event.batch" }.getJSONObject("payload")
            check(payload.getJSONArray("events").length() == 2)
            val tap = payload.getJSONArray("events").getJSONObject(1)
            check(tap.getString("type") == "tap" && tap.getDouble("x") == 1.0 && tap.getDouble("y") == 2.0)
            check(tap.getJSONArray("touches").length() == 0 && tap.getJSONArray("changedTouches").getJSONObject(0).getInt("identifier") == 4)
            check(receipts.last().getJSONObject("page").getJSONObject("data").getInt("count") == 1)
            check(receipts.last().getJSONObject("surface").getInt("screenX") == 7)
            check(receipts.last().isNull("snapshot"))
            check(receipts.last().getJSONObject("presentation").getString("transport") == "frame-metadata")
        }
        test("moved, cancelled, long and multi-pointer gestures never manufacture tap") {
            val (session, runtime) = interactive()
            session.setForeground(true)
            session.pointer("down", 0, 0.0, 0.0, 0, 0.1)
            session.pointer("move", 0, 1.0, 1.0, 10, 0.1)
            session.pointer("up", 0, 0.0, 0.0, 20, 0.1)
            session.pointer("down", 0, 0.0, 0.0, 30, 0.1)
            session.pointer("multiple", 1, 0.0, 0.0, 40, 0.1)
            session.pointer("up", 0, 0.0, 0.0, 50, 0.1)
            session.pointer("down", 0, 0.0, 0.0, 100, 0.1)
            session.pointer("up", 0, 0.0, 0.0, 1000, 0.1)
            val types = runtime.requests.filter { it.getString("op") == "event.batch" }
                .flatMap { val events = it.getJSONObject("payload").getJSONArray("events"); (0 until events.length()).map { index -> events.getJSONObject(index).getString("type") } }
            check("tap" !in types && "touchcancel" in types && "touchmove" in types)
        }
        test("resize preserves native owner and session while updating host dimensions and render") {
            val (session, runtime, receipts) = interactive()
            val loads = runtime.loadCount
            session.resize(12, 8, 2.0, 7, 11)
            val receipt = receipts.last()
            check(runtime.loadCount == loads && runtime.resizeCalls == 1)
            check(receipt.getString("sessionId") == "interaction-contract")
            check(receipt.getJSONObject("viewport").getInt("width") == 6 && receipt.getJSONObject("hostWindow").getInt("height") == 4)
            check(receipt.getJSONObject("frame").getJSONObject("viewport").getInt("width") == 6)
            check(receipt.getJSONObject("surface").getLong("presentedFrameId") == 0L)
            session.resize(12, 8, 2.0, 8, 12)
            check(runtime.resizeCalls == 1)
        }
        test("presentation receipt acknowledges only successful matching frame") {
            val (session, _, receipts) = interactive()
            val geometry = JSONObject().put("width", 4).put("height", 6).put("density", 2).put("screenX", 7).put("screenY", 11)
            session.presented(1, "skia-gpu-gles", geometry)
            check(receipts.last().getJSONObject("surface").getLong("presentedFrameId") == 1L)
            check(receipts.last().getJSONObject("surface").getLong("presentationSequence") == 1L)
            session.presented(99, "skia-gpu-gles", geometry)
            check(receipts.last().getString("status") == "suspended")
            check(receipts.last().getJSONObject("surface").getLong("presentedFrameId") == 1L)
        }
        test("surface loss clears presentation until the replacement window swaps") {
            val (session, _, receipts) = interactive()
            val geometry = JSONObject().put("width", 4).put("height", 6).put("density", 2).put("screenX", 7).put("screenY", 11)
            session.presented(1, "skia-gpu-gles", geometry)
            session.surfaceLost()
            check(receipts.last().getJSONObject("surface").getLong("presentedFrameId") == 0L)
            check(receipts.last().getJSONObject("surface").isNull("backend"))
            check(receipts.last().getJSONObject("frame").getLong("frame_id") == 1L)
            session.presented(1, "skia-gpu-gles", geometry)
            check(receipts.last().getJSONObject("surface").getLong("presentedFrameId") == 1L)
            check(receipts.last().getJSONObject("surface").getLong("presentationSequence") == 2L)
        }
        test("failed equal-size replacement clears old presentation without resetting JS state") {
            val (session, runtime, receipts) = interactive()
            val geometry = JSONObject().put("width", 4).put("height", 6).put("density", 2).put("screenX", 7).put("screenY", 11)
            session.presented(1, "skia-gpu-gles", geometry)
            val loads = runtime.loadCount
            session.surfaceLost() // Presenter invokes this even when replacement dimensions match.
            session.reportFailure(IllegalStateException("window acquisition failed"))
            check(receipts.last().getString("status") == "suspended")
            check(receipts.last().getJSONObject("surface").getLong("presentedFrameId") == 0L)
            check(receipts.last().getJSONObject("surface").isNull("backend"))
            check(receipts.last().getJSONObject("frame").getLong("frame_id") == 1L && runtime.loadCount == loads)
        }
        test("initial foreground is owned by acknowledged startup and not replayed after rendering") {
            val (session, runtime) = interactive()
            val before = runtime.requests.size
            session.setForeground(true)
            check(runtime.requests.size == before)
        }
        test("foreground transitions deduplicate, pause input and clear in-flight gesture") {
            val (session, runtime, receipts) = interactive()
            session.setForeground(true)
            session.setForeground(true)
            session.pointer("down", 0, 0.0, 0.0, 0, 1.0)
            session.setForeground(false)
            val pausedRequests = runtime.requests.size
            session.pollTimers(1)
            session.pointer("up", 0, 0.0, 0.0, 10, 1.0)
            check(runtime.requests.size == pausedRequests)
            session.setForeground(true)
            session.pointer("up", 0, 0.0, 0.0, 20, 1.0)
            check(receipts.last().getJSONObject("page").getJSONObject("data").getInt("count") == 0)
            val events = receipts.last().getJSONArray("lifecycle")
            check((0 until events.length()).map { events.getJSONObject(it).getString("event") } == listOf("show", "hide", "show"))
        }
        test("empty timer polls do not publish or inspect a frame; real callbacks do") {
            val (session, runtime, receipts) = interactive()
            session.setForeground(true)
            val countBefore = receipts.size
            val inspectedBefore = runtime.inspections
            session.pollTimers(1)
            check(receipts.size == countBefore && runtime.inspections == inspectedBefore)
            runtime.timerReady = true
            session.pollTimers(2)
            check(receipts.size > countBefore && runtime.inspections > inspectedBefore)
        }
        test("epoch-scheduled callback updates once at its deadline rather than waiting for Activity uptime") {
            val (session, runtime, receipts) = interactive()
            val startMillis = 1_792_563_456_789L
            runtime.timerDueNs = UnixTimerClock.nowNs(startMillis + 25)
            val before = receipts.size
            session.pollTimers(UnixTimerClock.nowNs(startMillis))
            session.pollTimers(UnixTimerClock.nowNs(startMillis + 24))
            check(runtime.timerFired == 0 && receipts.size == before)
            session.pollTimers(UnixTimerClock.nowNs(startMillis + 25))
            check(runtime.timerFired == 1)
            check(receipts.last().getJSONObject("page").getJSONObject("data").getInt("count") == 1)
            check(receipts.last().getJSONObject("frame").getLong("frame_id") == 2L)
            session.pollTimers(UnixTimerClock.nowNs(startMillis + 26))
            check(runtime.timerFired == 1 && runtime.timerPolls.last() == UnixTimerClock.nowNs(startMillis + 26))
        }
        test("negative timer input suspends without reinterpreting signed Long as native u64") {
            val (session, runtime, receipts) = interactive()
            session.pollTimers(-1)
            check(runtime.timerPolls.isEmpty())
            check(receipts.last().getString("status") == "suspended")
        }
        test("foreign-session timer batch suspends subsequent input") {
            val (session, runtime, receipts) = interactive()
            session.setForeground(true)
            runtime.foreignTimer = true
            session.pollTimers(3)
            val requests = runtime.requests.size
            session.pointer("down", 0, 0.0, 0.0, 10, 1.0)
            check(runtime.requests.size == requests && receipts.last().getString("status") == "suspended")
        }
        test("failed post-commit hook preserves visible frame identity and suspends input") {
            val runtime = RecordingRuntime(mutateBatch = { op, messages ->
                if (op == "render.commit" && messages.getJSONObject(0).getJSONObject("payload").getLong("frameId") > 1) {
                    messages.put(JSONObject(messages.getJSONObject(0).toString()).put("op", "error").put("kind", "event")
                        .put("payload", JSONObject().put("code", "ERR_ENGINE").put("message", "ready failed")))
                }
            })
            val (session, _, receipts) = interactive(runtime)
            val geometry = JSONObject().put("width", 4).put("height", 6).put("density", 2).put("screenX", 7).put("screenY", 11)
            session.presented(1, "skia-gpu-gles", geometry)
            session.setForeground(false)
            session.setForeground(true)
            val result = receipts.last()
            check(result.getString("status") == "suspended")
            check(result.getJSONObject("frame").getLong("frame_id") == 2L)
            check(result.getJSONObject("surface").getLong("presentedFrameId") == 1L)
        }
        test("closed session unloads once and cannot mutate native owner") {
            val (session, runtime, receipts) = interactive()
            session.close()
            session.close()
            val countBefore = runtime.requests.size
            session.setForeground(true)
            session.pointer("down", 0, 0.0, 0.0, 1, 1.0)
            session.pollTimers(1)
            check(runtime.requests.size == countBefore && receipts.last().getString("status") == "closed")
            check(runtime.requests.count { it.getString("op") == "app.lifecycle" && it.getJSONObject("payload").optString("event") == "unload" } == 1)
        }
        test("native session rejects another thread before invoking the runtime") {
            val (session, runtime) = interactive()
            val before = runtime.requests.size
            var failure: Throwable? = null
            val thread = Thread { failure = runCatching { session.setForeground(true) }.exceptionOrNull() }
            thread.start(); thread.join()
            check(failure?.message?.contains("owner thread") == true && runtime.requests.size == before)
        }
        test("diagnostic operation history is bounded") {
            val (session, _, receipts) = interactive()
            session.setForeground(true)
            repeat(80) { index -> session.pointer("down", 0, 0.0, 0.0, index * 20L, 1.0); session.pointer("up", 0, 0.0, 0.0, index * 20L + 1, 1.0) }
            check(receipts.last().getJSONArray("operations").length() == 128)
        }
        println(JSONObject().put("status", "passed").put("tests", count)
            .put("evidenceBoundary", "jvm-pack-loader-and-protocol-contract").put("device", false).put("gpu", false))
    }

    private class RecordingRuntime(
        val loadStatus: Int = 0,
        val mutateBatch: (String, JSONArray) -> Unit = { _, _ -> },
        val mutate: (String, JSONObject) -> Unit = { _, _ -> },
    ) : PortablePackRuntime, PortablePackSessionRuntime {
        var loaded = ByteArray(0)
        var config = JSONObject()
        val requests = mutableListOf<JSONObject>()
        var loadCount = 0
        var resizeCalls = 0
        var windowMetricsCalls = 0
        var resizeHooks = 0
        var rejectWindowMetrics = false
        var displayAtModuleStart: JSONObject? = null
        var displayAtShow: JSONObject? = null
        val hostCallOrder = mutableListOf<String>()
        var inspections = 0
        var presentationMutation: (JSONObject) -> Unit = {}
        val presentationAcks = mutableListOf<Long>()
        var ackChangesData = false
        var ackRejected = false
        private var ackDataRevision = 0L
        var timerReady = false
        var foreignTimer = false
        var timerDueNs: Long? = null
        var timerFired = 0
        val timerPolls = mutableListOf<Long>()
        private var frameId = 1L
        private var width = 1
        private var height = 1
        private var count = 0

        override fun loadManifest(manifest: ByteArray, config: ByteArray): ByteArray {
            loaded = manifest.copyOf()
            loadCount += 1
            this.config = JSONObject(config.toString(UTF_8))
            width = this.config.getJSONObject("host").getInt("windowWidth")
            height = this.config.getJSONObject("host").getInt("windowHeight")
            return JSONObject().put("ok", loadStatus == 0).put("error", JSONObject().put("code", "ERR_ENGINE"))
                .toString().toByteArray(UTF_8)
        }

        override fun dispatch(envelope: ByteArray): ByteArray {
            val request = JSONObject(envelope.toString(UTF_8))
            requests += request
            val operation = request.getString("op")
            if (operation == "app.lifecycle" && request.getJSONObject("payload").optString("event") == "show") {
                hostCallOrder += "show"
                displayAtShow = config.getJSONObject("host").optJSONObject("displayMetrics")?.let { JSONObject(it.toString()) }
            }
            val payload = JSONObject().put("ok", true)
            if (operation == "app.init") {
                displayAtModuleStart = config.getJSONObject("host").optJSONObject("displayMetrics")?.let { JSONObject(it.toString()) }
                payload.put("engine", config.getString("engine")).put("engineProviderAvailable", true)
                    .put("loadedModules", request.getJSONObject("payload").getJSONArray("modules").length())
                    .put("manifest", JSONObject().put("integrity", JSONObject(loaded.toString(UTF_8)).getJSONObject("integrity").getString("root")))
            }
            if (operation == "render.commit") {
                frameId = request.getJSONObject("payload").getLong("frameId")
                payload.put("committed", true).put("source", "manifest")
                    .put("templateId", request.getJSONObject("payload").getString("templateId")).put("frameId", frameId).put("backend", "skia-raster")
            }
            if (operation == "event.batch") {
                val events = request.getJSONObject("payload").getJSONArray("events")
                for (index in 0 until events.length()) if (events.getJSONObject(index).getString("type") == "tap") count += 1
            }
            val response = JSONObject(request.toString()).put("kind", "response").put("payload", payload)
            mutate(operation, response)
            val messages = JSONArray().put(response)
            mutateBatch(operation, messages)
            return JSONObject().put("messages", messages).toString().toByteArray(UTF_8)
        }

        override fun resize(width: Int, height: Int): ByteArray {
            resizeCalls += 1
            this.width = width; this.height = height
            return JSONObject().put("messages", JSONArray()).toString().toByteArray(UTF_8)
        }

        override fun updateWindowMetrics(metrics: ByteArray): ByteArray {
            hostCallOrder += "windowMetrics"
            windowMetricsCalls += 1
            if (rejectWindowMetrics) return "{\"ok\":false,\"error\":{\"code\":\"ERR_RENDER\"}}".toByteArray(UTF_8)
            val value = JSONObject(metrics.toString(UTF_8))
            val nextWidth = value.getInt("windowWidth")
            val nextHeight = value.getInt("windowHeight")
            if (width != nextWidth || height != nextHeight) resizeHooks += 1
            width = nextWidth; height = nextHeight
            value.remove("windowWidth"); value.remove("windowHeight")
            config.getJSONObject("host").put("windowWidth", width).put("windowHeight", height).put("displayMetrics", value)
            return "{\"messages\":[]}".toByteArray(UTF_8)
        }

        override fun pollTimers(nowNs: Long): ByteArray {
            timerPolls += nowNs
            if (timerDueNs?.let { nowNs >= it } == true) {
                timerDueNs = null
                timerFired += 1
                count += 1
                timerReady = true
            }
            val messages = JSONArray()
            if (timerReady || foreignTimer) messages.put(JSONObject().put("sessionId", if (foreignTimer) "other" else config.getString("session_id"))
                .put("kind", "event").put("op", "event.batch").put("payload", JSONObject().put("timers", JSONArray())))
            timerReady = false
            return JSONObject().put("messages", messages).toString().toByteArray(UTF_8)
        }

        override fun presentationState(): ByteArray = JSONObject().put("schemaVersion", 1)
            .put("sessionId", config.getString("session_id")).put("viewRevision", frameId + ackDataRevision).put("renderRevision", frameId)
            .put("viewport", JSONObject().put("width", width).put("height", height))
            .put("frame", JSONObject().put("frame_id", frameId).put("viewport", JSONObject().put("width", width).put("height", height)))
            .also(presentationMutation)
            .toString().toByteArray(UTF_8)

        override fun acknowledgePresentation(revision: Long): ByteArray {
            check(revision == frameId)
            presentationAcks += revision
            if (ackRejected) return JSONObject().put("messages", JSONArray().put(JSONObject()
                .put("sessionId", config.getString("session_id")).put("kind", "event").put("op", "error")
                .put("payload", JSONObject().put("code", "ERR_ENGINE").put("message", "onReady failed"))))
                .toString().toByteArray(UTF_8)
            if (ackChangesData) { ackChangesData = false; ackDataRevision += 1 }
            return "{\"messages\":[]}".toByteArray(UTF_8)
        }

        override fun inspect(): ByteArray {
            inspections += 1
            return JSONObject().put("sessionId", config.getString("session_id")).put("viewport", JSONObject().put("width", width).put("height", height))
                .put("displayMetrics", config.getJSONObject("host").opt("displayMetrics") ?: JSONObject.NULL)
                .put("page", JSONObject().put("route", "pages/index/index").put("data", JSONObject().put("count", count)))
                .put("frame", JSONObject().put("frame_id", frameId).put("viewport", JSONObject().put("width", width).put("height", height))
                    .put("root", JSONObject().put("id", "root").put("bounds", JSONObject().put("width", width).put("height", height))))
                .toString().toByteArray(UTF_8)
        }
    }
}
