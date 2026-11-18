import Foundation
import UIKit
import Metal
import QuartzCore
import CryptoKit

// This app compiles the same Swift host/portable-pack loader as the reusable
// package. The C header owns ABI declarations in both integrations.

/// Persist the app-backed smoke result in the simulator data container.  A
/// UIKit app keeps running after `simctl launch`, so stdout from
/// `simctl --console` is not a reliable synchronization channel.  The host
/// script reads this file after launch and validates the same surface probe
/// that the app emits through `print`.
private func writeEvidence(_ object: [String: Any]) {
    guard let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else {
        return
    }
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let url = directory.appendingPathComponent("weapp-ios-evidence.json")
    if let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) {
        try? data.write(to: url, options: .atomic)
    }
}

private func compactEvidenceJSON(operation: String, data: Data) -> String {
    guard operation == "render.snapshot",
          let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        return String(data: data, encoding: .utf8) ?? ""
    }
    var summary: [String: Any] = [:]
    for key in ["frame_id", "width", "height", "stride", "format"] {
        if let value = value[key] { summary[key] = value }
    }
    if let pixels = value["pixels"] as? [NSNumber] {
        summary["pixels"] = Array(pixels.prefix(8))
        summary["pixelCount"] = pixels.count
        let bytes = Data(pixels.map { $0.uint8Value })
        summary["sha256"] = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }
    guard let compact = try? JSONSerialization.data(withJSONObject: summary, options: [.sortedKeys]) else {
        return String(data: data, encoding: .utf8) ?? ""
    }
    return String(data: compact, encoding: .utf8) ?? ""
}

private var operationEvidence: [String: Any] = [:]

private var startupEvidence: [String: Any] = [:]
private let selectedEngine = Bundle.main.object(forInfoDictionaryKey: "WeappContainerEngine") as? String ?? "quickjs"
private let selectedSession = Bundle.main.object(forInfoDictionaryKey: "WeappContainerSessionID") as? String ?? "session-1"
// The example enables this only for its explicitly requested UI verification
// build. Normal embedding never exposes application data to accessibility.
private let uiObservationEnabled = Bundle.main.object(forInfoDictionaryKey: "WeappContainerUIObservation") as? Bool == true
private var snapshotSHA256 = ""

private func recordDrawable(_ buffer: MTLBuffer, width: Int, height: Int, rowBytes: Int) -> [String: Any] {
    var pixels = Data(capacity: width * height * 4)
    for row in 0..<height {
        pixels.append(buffer.contents().advanced(by: row * rowBytes).assumingMemoryBound(to: UInt8.self), count: width * 4)
    }
    var result: [String: Any] = ["width": width, "height": height, "format": "bgra8-premultiplied",
                                "byteCount": pixels.count,
                                "sha256": SHA256.hash(data: pixels).map { String(format: "%02x", $0) }.joined()]
    if let provider = CGDataProvider(data: pixels as CFData),
       let image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
          bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
          bitmapInfo: CGBitmapInfo(rawValue: CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue),
          provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent),
       let png = UIImage(cgImage: image).pngData(),
       let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first {
        let name = "weapp-ios-frame.png"
        do {
            try png.write(to: directory.appendingPathComponent(name), options: .atomic)
            result["png"] = name
            result["pngSha256"] = SHA256.hash(data: png).map { String(format: "%02x", $0) }.joined()
        }
        catch { result["error"] = String(describing: error) }
    }
    return result
}

@discardableResult
private func record(_ operation: String, _ result: (status: Int32, response: Data)) throws -> Data {
    let json = compactEvidenceJSON(operation: operation, data: result.response)
    print("WEAPP_CONTAINER_IOS_APP \(operation) status=\(result.status) bytes=\(result.response.count) json=\(json)")
    operationEvidence[operation] = ["status": result.status, "bytes": result.response.count, "json": json,
                                     "sessionId": selectedSession]
    guard result.status == 0, !result.response.isEmpty else {
        throw WeappPortablePackError(operation, "ERR_ENGINE", "ABI status \(result.status): \(json)")
    }
    if let batch = try? JSONSerialization.jsonObject(with: result.response) as? [String: Any],
       let messages = batch["messages"] as? [[String: Any]] {
        for message in messages {
            let payload = message["payload"] as? [String: Any] ?? [:]
            if payload["ok"] as? Bool == false || message["op"] as? String == "error" {
                let error = payload["error"] as? [String: Any] ?? payload
                throw WeappPortablePackError(operation, error["code"] as? String ?? "ERR_ENGINE", error["message"] as? String ?? "bridge error")
            }
        }
    }
    return result.response
}

private let canvasEnvelope = """
{"protocolVersion":"1.0","sessionId":"session-1","requestId":"canvas-1","kind":"request","op":"api.call","payload":{"name":"wx.canvas.draw","canvasId":"main","width":1,"height":1,"commands":[{"op":"setFillStyle","args":["#0a141e"]},{"op":"fillRect","args":[0,0,1,1]}]}}
""".data(using: .utf8)!

private let apiEnvelope = """
{"protocolVersion":"1.0","sessionId":"session-1","requestId":"api-1","kind":"request","op":"api.call","payload":{"name":"wx.canIUse","capability":"wx.getStorage"}}
""".data(using: .utf8)!

/// Evidence instrumentation for the reusable live surface. Only its first
/// presented frame incurs a CPU snapshot and GPU readback. Subsequent timer,
/// lifecycle and input batches remain live and enter a bounded separate trace.
@MainActor
private final class WeappContainerEmbeddingEvidence {
    private weak var view: WeappContainerView?
    private var startup: [String: Any] = [:]
    private var initialOperations: [String: Any] = [:]
    private var currentRender: [String: Any]?
    private var lastReport: [String: Any]
    private var trace: [[String: Any]] = []
    private var traceSequence: UInt64 = 0
    private var traceDropped: UInt64 = 0
    private var lastTraceWrite: TimeInterval = 0
    private var pendingTraceWrite: DispatchWorkItem?
    private var traceDirty = false
    private var traceWriteError: String?
    private var failed = false
    private var reportedFrame = false
    private var capturedFrame: CapturedFrame?

    private struct CapturedFrame {
        let frameID: UInt64
        let report: [String: Any]
        let readback: MTLBuffer
        let width: Int
        let height: Int
        let rowBytes: Int
    }

    init() {
        lastReport = [
            "schemaVersion": 1, "status": "running", "source": "ios-skia-metal-embedding",
            "host": "ios", "engine": selectedEngine, "sessionId": selectedSession,
            "manifestIntegrity": "", "route": "", "frameId": 0,
            "deviceName": "", "width": 0, "height": 0,
            "hostSurfaceAttached": false, "containerSurfaceAttached": false, "gpuSurface": false,
            "rendererBackend": "skia-gpu-metal", "sessionOpen": false,
            "runtimeSurface": [:], "startup": [:], "operations": [:],
            "evidenceBoundary": "rust-skia-metal-drawable",
            "readbackPolicy": "first-presentation-only",
            "traceFile": "weapp-ios-embedding-trace.json",
            "inputEvidenceBoundary": "runtime-batch-trace; OS-injected touch is not claimed",
        ]
        writeEvidence(lastReport)
    }

    func configure(_ container: WeappContainerView) {
        view = container
        if uiObservationEnabled {
            container.isAccessibilityElement = true
            container.accessibilityIdentifier = "weapp-container-surface"
            container.accessibilityLabel = "Weapp Container verification surface"
        }
        container.session.onOperation = { [weak self] operation, request, response in
            self?.operation(operation, request: request, response: response)
        }
        container.session.onDiagnostic = { [weak self] diagnostic in
            guard let self else { return }
            let data = (try? JSONSerialization.data(withJSONObject: diagnostic, options: [.sortedKeys])) ?? Data()
            self.appendTrace(["kind": "diagnostic", "bytes": data.count, "sha256": self.digest(data),
                              "json": self.boundedText(data), "truncated": data.count > 8192])
        }
        container.onEncodeFrame = { [weak self, weak container] frameID, commandBuffer, texture in
            guard let self, let container else { return }
            try self.capture(frameID: frameID, view: container, commandBuffer: commandBuffer, texture: texture)
        }
        container.onPresented = { [weak self] frameID, completion in
            self?.refreshUIObservation()
            self?.presented(frameID: frameID, completion: completion)
        }
        refreshUIObservation()
    }

    func recordStartup(_ value: WeappPortablePackStartup) {
        startup = ["input": "portable-pack", "route": value.route, "engine": value.engine,
                   "sessionId": value.sessionID, "frameId": 1,
                   "templateId": "template:" + value.route + ".wxml",
                   "integrityRoot": value.integrityRoot, "diagnostics": value.diagnostics]
        for name in ["app.init", "app.lifecycle", "page.push", "render.commit"] {
            guard let request = value.requests[name], let response = value.operations[name] else { continue }
            let entry = operationRecord(request: request, response: response)
            if name == "render.commit" { currentRender = entry }
            else { initialOperations[name] = entry }
        }
        lastReport["startup"] = startup
        lastReport["operations"] = initialOperations
        lastReport["manifestIntegrity"] = value.integrityRoot
        lastReport["route"] = value.route
        lastReport["frameId"] = 1
        lastReport["sessionOpen"] = true
        if let view {
            lastReport["deviceName"] = view.metalDevice?.name ?? ""
            lastReport["logicalViewport"] = ["width": view.session.viewportWidth, "height": view.session.viewportHeight]
        }
        writeEvidence(lastReport)
        appendTrace(["kind": "startup", "route": value.route, "engine": value.engine, "frameId": 1])
        refreshUIObservation()
    }

    func recordFailure(_ error: Error) {
        guard !failed else { return }
        failed = true
        refreshUIObservation()
        if let frame = capturedFrame { lastReport = frame.report }
        capturedFrame = nil
        lastReport["status"] = "failed"
        let detail = (error as? WeappPortablePackError)?.jsonObject ?? ["message": String(describing: error)]
        lastReport["error"] = detail
        // Cancel the coalesced write and include the terminal diagnostic even
        // when failure arrives before the normal 250 ms write deadline.
        pendingTraceWrite?.cancel()
        pendingTraceWrite = nil
        let bytes = (try? JSONSerialization.data(withJSONObject: detail, options: [.sortedKeys])) ?? Data()
        appendTraceEntry(["kind": "failure", "bytes": bytes.count, "sha256": digest(bytes),
                          "json": boundedText(bytes), "truncated": bytes.count > 8192])
        flushTrace(force: true, reportFailure: false)
        if let traceWriteError { lastReport["traceWriteError"] = traceWriteError }
        lastReport["trace"] = trace
        lastReport["traceDropped"] = traceDropped
        // A prior GPU frame may have completed successfully; retaining its
        // frozen fields does not hide the new runtime/host failure.
        writeEvidence(lastReport)
        print("WEAPP_CONTAINER_IOS_APP embedding failed: \(error)")
    }

    private func operation(_ name: String, request: Data, response: Data) {
        if name == "render.commit" { currentRender = operationRecord(request: request, response: response) }
        let object = (try? JSONSerialization.jsonObject(with: request)) as? [String: Any] ?? [:]
        var entry: [String: Any] = ["kind": "operation", "op": name,
            "requestBytes": request.count, "responseBytes": response.count,
            "requestSha256": digest(request), "responseSha256": digest(response),
            "requestJson": boundedText(request), "responseJson": boundedText(response),
            "requestTruncated": request.count > 8192, "responseTruncated": response.count > 8192]
        if let requestID = object["requestId"] { entry["requestId"] = requestID }
        if let payload = object["payload"] as? [String: Any], let frameID = payload["frameId"] { entry["frameId"] = frameID }
        appendTrace(entry)
        refreshUIObservation()
    }

    /// One read-only page batch and one accessibility anchor. XCTest still
    /// injects OS coordinates through UIKit; no action invokes this observer
    /// or synthesizes native input, lifecycle, geometry or timer operations.
    private func refreshUIObservation() {
        guard uiObservationEnabled, let view else { return }
        var value: [String: Any] = ["schemaVersion": 1, "sessionId": selectedSession,
            "pid": ProcessInfo.processInfo.processIdentifier, "frameId": view.session.frameID,
            "presentedFrameId": view.lastPresentedFrameID ?? 0,
            "interfaceOrientation": view.window?.windowScene?.interfaceOrientation.rawValue ?? 0,
            "viewport": ["width": view.session.viewportWidth, "height": view.session.viewportHeight],
            "foreground": view.session.isForeground, "closed": view.session.isClosed,
            "failed": failed || view.session.isFailed, "pageData": [:]]
        if !view.session.isClosed, !failed, let host = view.session.runtime as? WeappContainerHost {
            let result = host.inspectState()
            if result.status == 0,
               let state = try? JSONSerialization.jsonObject(with: result.response) as? [String: Any],
               state["schemaVersion"] as? Int == 1, state["sessionId"] as? String == selectedSession,
               let page = state["page"] as? [String: Any], let data = page["data"] as? [String: Any] {
                value["pageData"] = data
            } else {
                value["failed"] = true
                value["observationError"] = "native page observation unavailable"
            }
        }
        if let bytes = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), bytes.count <= 32768 {
            view.accessibilityValue = String(decoding: bytes, as: UTF8.self)
        } else {
            view.accessibilityValue = "{\"schemaVersion\":1,\"failed\":true,\"observationError\":\"observation exceeded 32 KiB\"}"
        }
    }

    private func capture(frameID: UInt64, view: WeappContainerView,
                         commandBuffer: MTLCommandBuffer, texture: MTLTexture) throws {
        guard !reportedFrame, !failed, capturedFrame == nil else { return }
        guard let host = view.session.runtime as? WeappContainerHost,
              let currentRender, let requestText = currentRender["requestJson"] as? String,
              let requestData = requestText.data(using: .utf8),
              let request = try JSONSerialization.jsonObject(with: requestData) as? [String: Any],
              let payload = request["payload"] as? [String: Any],
              payload["frameId"] as? UInt64 == frameID,
              payload["templateId"] as? String == "template:" + view.session.route + ".wxml",
              payload["viewport"] is [String: Any],
              let responseText = currentRender["json"] as? String,
              let responseData = responseText.data(using: .utf8),
              let batch = try JSONSerialization.jsonObject(with: responseData) as? [String: Any],
              let messages = batch["messages"] as? [[String: Any]],
              messages.contains(where: { message in
                  let body = message["payload"] as? [String: Any] ?? [:]
                  return message["kind"] as? String == "response" && message["op"] as? String == "render.commit"
                      && message["requestId"] as? String == request["requestId"] as? String
                      && message["sessionId"] as? String == view.session.startup.sessionID
                      && body["ok"] as? Bool == true && body["committed"] as? Bool == true
                      && body["frameId"] as? UInt64 == frameID
              }) else {
            throw WeappPortablePackError("embedding.capture", "ERR_RENDER", "presented frame has no correlated current render.commit")
        }
        let capabilities = host.capabilities()
        guard capabilities.status == 0,
              let capability = try JSONSerialization.jsonObject(with: capabilities.response) as? [String: Any],
              let runtimeSurface = capability["runtime"] as? [String: Any],
              runtimeSurface["gpuSurface"] as? Bool == true,
              runtimeSurface["renderer"] as? String == "skia-gpu-metal" else {
            throw WeappPortablePackError("embedding.capture", "ERR_RENDER", "runtime did not confirm its own Skia Metal submission")
        }
        let snapshot = host.renderSnapshot()
        guard snapshot.status == 0,
              let value = try JSONSerialization.jsonObject(with: snapshot.response) as? [String: Any],
              value["frame_id"] as? UInt64 == frameID else {
            throw WeappPortablePackError("embedding.snapshot", "ERR_RENDER", "snapshot does not belong to the presented frame")
        }
        let snapshotJSON = compactEvidenceJSON(operation: "render.snapshot", data: snapshot.response)
        guard let compactData = snapshotJSON.data(using: .utf8),
              let compact = try JSONSerialization.jsonObject(with: compactData) as? [String: Any],
              let snapshotHash = compact["sha256"] as? String,
              let device = view.metalDevice else {
            throw WeappPortablePackError("embedding.snapshot", "ERR_RENDER", "snapshot digest or Metal device is missing")
        }
        let rowBytes = (texture.width * 4 + 255) & ~255
        guard let readback = device.makeBuffer(length: rowBytes * texture.height, options: .storageModeShared),
              let blit = commandBuffer.makeBlitCommandEncoder() else {
            throw WeappPortablePackError("embedding.readback", "ERR_RENDER", "GPU drawable readback allocation failed")
        }
        blit.copy(from: texture, sourceSlice: 0, sourceLevel: 0, sourceOrigin: MTLOrigin(x: 0, y: 0, z: 0),
                  sourceSize: MTLSize(width: texture.width, height: texture.height, depth: 1),
                  to: readback, destinationOffset: 0, destinationBytesPerRow: rowBytes,
                  destinationBytesPerImage: rowBytes * texture.height)
        blit.endEncoding()
        var operations = initialOperations
        operations["render.commit"] = currentRender
        operations["render.snapshot"] = ["status": snapshot.status, "bytes": snapshot.response.count,
            "json": snapshotJSON, "sessionId": view.session.startup.sessionID]
        var report = lastReport
        report["startup"] = startup
        report["operations"] = operations
        report["route"] = view.session.route
        report["frameId"] = frameID
        report["deviceName"] = device.name
        report["width"] = texture.width
        report["height"] = texture.height
        report["screenScale"] = view.metalLayer.contentsScale
        report["osVersion"] = UIDevice.current.systemVersion
        report["logicalViewport"] = ["width": view.session.viewportWidth, "height": view.session.viewportHeight]
        report["runtimeSurface"] = runtimeSurface
        report["snapshotSha256"] = snapshotHash
        report["sessionOpen"] = true
        report["trace"] = trace
        report["traceDropped"] = traceDropped
        capturedFrame = CapturedFrame(frameID: frameID, report: report, readback: readback,
                                      width: texture.width, height: texture.height, rowBytes: rowBytes)
    }

    private func presented(frameID: UInt64, completion: MetalPresentationCompletion) {
        guard !failed, let frame = capturedFrame else { return }
        guard frame.frameID == frameID else {
            let error = WeappPortablePackError("embedding.present", "ERR_RENDER", "completion does not match captured frame")
            view?.onError?(error)
            recordFailure(error)
            return
        }
        capturedFrame = nil
        reportedFrame = true
        var report = frame.report
        report["status"] = completion.succeeded ? "passed" : "failed"
        report["hostSurfaceAttached"] = completion.probe.hostSurfaceAttached
        report["containerSurfaceAttached"] = completion.probe.containerSurfaceAttached
        report["gpuSurface"] = completion.probe.gpuSurface
        report["commandBufferStatus"] = completion.commandBufferStatus.rawValue
        report["commandBufferError"] = completion.error ?? ""
        report["drawableReadback"] = completion.succeeded ? recordDrawable(frame.readback,
            width: frame.width, height: frame.height, rowBytes: frame.rowBytes) : [:]
        lastReport = report
        writeEvidence(report)
        if let data = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]),
           let text = String(data: data, encoding: .utf8) { print("WEAPP_CONTAINER_SURFACE_PROBE \(text)") }
        // The live surface stays attached; teardown belongs to its supervisor.
        // No detachStatus is manufactured for this embedding mode.
    }

    private func operationRecord(request: Data, response: Data) -> [String: Any] {
        ["status": 0, "bytes": response.count, "json": String(decoding: response, as: UTF8.self),
         "requestJson": String(decoding: request, as: UTF8.self), "sessionId": selectedSession]
    }

    private func appendTrace(_ value: [String: Any]) {
        appendTraceEntry(value)
        scheduleTraceWrite()
    }

    private func appendTraceEntry(_ value: [String: Any]) {
        traceSequence &+= 1
        var entry = value
        entry["sequence"] = traceSequence
        trace.append(entry)
        if trace.count > 128 { trace.removeFirst(trace.count - 128); traceDropped &+= 1 }
        traceDirty = true
    }

    private func scheduleTraceWrite() {
        guard !failed, traceDirty, pendingTraceWrite == nil else { return }
        let delay = max(0, 0.25 - (ProcessInfo.processInfo.systemUptime - lastTraceWrite))
        // A burst shares one pending task. The queue retains only a weak
        // recorder reference, so tracing cannot keep a controller, view or
        // Rust session alive after the embedding feature is released.
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.pendingTraceWrite = nil
            guard !self.failed else { return }
            self.flushTrace(force: false, reportFailure: true)
        }
        pendingTraceWrite = work
        DispatchQueue.main.asyncAfter(deadline: .now() + min(0.25, delay), execute: work)
    }

    private func flushTrace(force: Bool, reportFailure: Bool) {
        guard traceDirty else { return }
        if !force, ProcessInfo.processInfo.systemUptime - lastTraceWrite < 0.25 {
            scheduleTraceWrite()
            return
        }
        do {
            guard let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else {
                throw WeappPortablePackError("embedding.trace", "ERR_ENGINE", "cache directory unavailable")
            }
            let data = try JSONSerialization.data(withJSONObject: ["schemaVersion": 1,
                "source": "ios-skia-metal-embedding", "sessionId": selectedSession,
                "events": trace, "dropped": traceDropped,
                "inputEvidenceBoundary": "runtime-batch-trace; OS-injected touch is not claimed"], options: [.sortedKeys])
            try data.write(to: directory.appendingPathComponent("weapp-ios-embedding-trace.json"), options: .atomic)
            traceDirty = false
            lastTraceWrite = ProcessInfo.processInfo.systemUptime
        } catch {
            traceWriteError = String(describing: error)
            if reportFailure {
                view?.onError?(error)
                recordFailure(error)
            } else {
                // The forced failure flush can itself fail (for example a
                // full filesystem). Preserve that error in the primary
                // report instead of recursively attempting another flush.
                print("WEAPP_CONTAINER_IOS_APP embedding trace flush failed: \(error)")
            }
        }
    }

    private func boundedText(_ data: Data) -> String { String(decoding: data.prefix(8192), as: UTF8.self) }
    private func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
}

private final class WeappContainerMetalView: UIView {
    override class var layerClass: AnyClass { CAMetalLayer.self }
    private var metalLayer: CAMetalLayer { layer as! CAMetalLayer }
    private let host = WeappContainerHost(pageRenderMode: .nativeGpu)
    private let device: MTLDevice
    private let queue: MTLCommandQueue
    private var didRender = false
    private var renderInFlight = false
    private var runtimeReady = false
    private var startAttempted = false

    init(device: MTLDevice) {
        guard let queue = device.makeCommandQueue() else { fatalError("MTLDevice.makeCommandQueue returned nil") }
        self.device = device
        self.queue = queue
        super.init(frame: .zero)
        // The runtime frame is premultiplied and may have a transparent
        // background. Let CoreAnimation composite it over the host view.
        isOpaque = false
        backgroundColor = .clear
        metalLayer.device = device
        metalLayer.isOpaque = false
        metalLayer.pixelFormat = .bgra8Unorm
        metalLayer.framebufferOnly = false
        metalLayer.presentsWithTransaction = false
        writeEvidence([
            "schemaVersion": 1,
            "status": "running",
            "source": "ios-skia-metal-app",
            "renderer": device.name,
            "containerSurfaceAttached": false,
            "gpuSurface": false,
            "rendererBackend": "pending",
        ])
        print("WEAPP_CONTAINER_GPU_PROBE {\"schemaVersion\":1,\"source\":\"ios-metal-app\",\"status\":\"passed\",\"contextCreated\":true,\"hardwareAccelerated\":false,\"vendor\":\"Apple\",\"renderer\":\"\(device.name)\",\"containerSurfaceAttached\":false,\"evidenceBoundary\":\"device-context-only\"}")
    }

    required init?(coder: NSCoder) { fatalError("storyboards are not used") }

    override func layoutSubviews() {
        super.layoutSubviews()
        metalLayer.contentsScale = window?.screen.scale ?? UIScreen.main.scale
        metalLayer.drawableSize = CGSize(width: max(1, bounds.width * metalLayer.contentsScale), height: max(1, bounds.height * metalLayer.contentsScale))
        if runtimeReady && !didRender { renderOnce() }
    }

    func start() {
        guard !startAttempted else { return }
        startAttempted = true
        do {
            try record("capabilities", host.capabilities())
            let directory = Bundle.main.bundleURL.appendingPathComponent("portable-pack", isDirectory: true)
            let pack = try WeappPortablePack(directory: directory)
            let startup = try pack.start(on: host, engine: selectedEngine, sessionID: selectedSession,
                                         width: Double(max(1, bounds.width)), height: Double(max(1, bounds.height)))
            for (operation, data) in startup.operations {
                try record(operation, (status: 0, response: data))
                var evidence = operationEvidence[operation] as! [String: Any]
                evidence["requestJson"] = startup.requests[operation].flatMap { String(data: $0, encoding: .utf8) }
                operationEvidence[operation] = evidence
            }
            startupEvidence = ["input": "portable-pack", "route": startup.route,
                               "engine": startup.engine, "sessionId": startup.sessionID,
                               "frameId": 1, "templateId": "template:" + startup.route + ".wxml",
                               "integrityRoot": startup.integrityRoot, "diagnostics": startup.diagnostics]
            let errors = startup.diagnostics.filter { $0["op"] as? String == "error" }
            guard errors.isEmpty else {
                throw WeappPortablePackError("startup", "ERR_ENGINE", "runtime emitted post-publication errors: \(errors)")
            }
            try record("render.snapshot", host.renderSnapshot())
            if let record = operationEvidence["render.snapshot"] as? [String: Any],
               let text = record["json"] as? String, let data = text.data(using: .utf8),
               let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
                snapshotSHA256 = value["sha256"] as? String ?? ""
            }
            func sessionEnvelope(_ data: Data) throws -> Data {
                var envelope = try JSONSerialization.jsonObject(with: data) as! [String: Any]
                envelope["sessionId"] = selectedSession
                return try JSONSerialization.data(withJSONObject: envelope)
            }
            try record("canvas.draw", host.dispatch(try sessionEnvelope(canvasEnvelope)))
            try record("canvas.snapshot", host.canvasSnapshot(canvasID: "main"))
            try record("api.call", host.dispatch(try sessionEnvelope(apiEnvelope)))
            runtimeReady = true
            DispatchQueue.main.async { [weak self] in self?.renderOnce() }
        } catch {
            let detail = (error as? WeappPortablePackError)?.jsonObject ?? ["message": String(describing: error)]
            writeEvidence(["schemaVersion": 1, "status": "failed", "source": "ios-portable-pack-app",
                           "input": "portable-pack", "containerSurfaceAttached": false, "gpuSurface": false,
                           "error": detail, "startup": startupEvidence, "operations": operationEvidence])
            print("WEAPP_CONTAINER_IOS_APP startup failed: \(error)")
            let label = UILabel(frame: bounds)
            label.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            label.numberOfLines = 0
            label.text = "Weapp Container startup failed\n\(error)"
            label.textColor = .systemRed
            label.backgroundColor = .systemBackground
            addSubview(label)
        }
    }

    private func renderOnce() {
        guard runtimeReady, !didRender, !renderInFlight, bounds.width > 0, bounds.height > 0 else { return }
        guard let drawable = metalLayer.nextDrawable() else {
            writeEvidence([
                "schemaVersion": 1,
                "status": "blocked",
                "source": "ios-skia-metal-app",
                "hostSurfaceAttached": true,
                "containerSurfaceAttached": false,
                "gpuSurface": false,
                "rendererBackend": "skia-gpu-metal",
                "evidenceBoundary": "rust-skia-metal-drawable",
                "reason": "CAMetalLayer.nextDrawable returned nil",
            ])
            print("WEAPP_CONTAINER_SURFACE_PROBE {\"schemaVersion\":1,\"source\":\"ios-skia-metal-app\",\"status\":\"blocked\",\"hostSurfaceAttached\":true,\"containerSurfaceAttached\":false,\"gpuSurface\":false,\"rendererBackend\":\"skia-gpu-metal\",\"evidenceBoundary\":\"rust-skia-metal-drawable\",\"reason\":\"CAMetalLayer.nextDrawable returned nil\"}")
            return
        }
        let attachStatus = host.attachMetalContext(device: device, commandQueue: queue)
        guard attachStatus == 0 else {
            let reason = "Rust Skia Metal context attach failed (status \(attachStatus))"
            writeEvidence([
                "schemaVersion": 1,
                "status": "blocked",
                "source": "ios-skia-metal-app",
                "hostSurfaceAttached": true,
                "containerSurfaceAttached": false,
                "gpuSurface": false,
                "rendererBackend": "skia-gpu-metal",
                "evidenceBoundary": "rust-skia-metal-drawable",
                "reason": reason,
            ])
            print("WEAPP_CONTAINER_SURFACE_PROBE {\"schemaVersion\":1,\"source\":\"ios-skia-metal-app\",\"status\":\"blocked\",\"hostSurfaceAttached\":true,\"containerSurfaceAttached\":false,\"gpuSurface\":false,\"rendererBackend\":\"skia-gpu-metal\",\"evidenceBoundary\":\"rust-skia-metal-drawable\",\"reason\":\"\(reason)\"}")
            return
        }
        let renderStatus = host.renderLastFrame(to: drawable.texture)
        guard renderStatus == 0 else {
            _ = host.detachMetalContext()
            let reason = "Rust Skia Metal drawable render failed (status \(renderStatus))"
            writeEvidence([
                "schemaVersion": 1,
                "status": "blocked",
                "source": "ios-skia-metal-app",
                "hostSurfaceAttached": true,
                "containerSurfaceAttached": false,
                "gpuSurface": false,
                "rendererBackend": "skia-gpu-metal",
                "evidenceBoundary": "rust-skia-metal-drawable",
                "reason": reason,
            ])
            print("WEAPP_CONTAINER_SURFACE_PROBE {\"schemaVersion\":1,\"source\":\"ios-skia-metal-app\",\"status\":\"blocked\",\"hostSurfaceAttached\":true,\"containerSurfaceAttached\":false,\"gpuSurface\":false,\"rendererBackend\":\"skia-gpu-metal\",\"evidenceBoundary\":\"rust-skia-metal-drawable\",\"reason\":\"\(reason)\"}")
            return
        }
        // Query the runtime after its own submission, before detaching. A
        // Metal device or an independently drawn texture cannot satisfy this.
        let capabilities = host.capabilities()
        let capabilityJSON = try? JSONSerialization.jsonObject(with: capabilities.response) as? [String: Any]
        let runtimeSurface = capabilityJSON?["runtime"] as? [String: Any] ?? [:]
        guard capabilities.status == 0, runtimeSurface["gpuSurface"] as? Bool == true,
              runtimeSurface["renderer"] as? String == "skia-gpu-metal" else {
            _ = host.detachMetalContext()
            writeEvidence(["schemaVersion": 1, "status": "failed", "source": "ios-skia-metal-app",
                           "reason": "runtime did not confirm an attached Skia GPU submission",
                           "runtimeSurface": runtimeSurface, "startup": startupEvidence,
                           "operations": operationEvidence])
            return
        }
        // Copy the actual GPU drawable once for smoke evidence. This does not
        // upload the CPU snapshot or participate in the production draw path.
        let rowBytes = (drawable.texture.width * 4 + 255) & ~255
        guard let commandBuffer = queue.makeCommandBuffer(),
              let readback = device.makeBuffer(length: rowBytes * drawable.texture.height, options: .storageModeShared),
              let blit = commandBuffer.makeBlitCommandEncoder() else {
            _ = host.detachMetalContext()
            writeEvidence(["schemaVersion": 1, "status": "failed", "source": "ios-skia-metal-app",
                           "reason": "GPU drawable readback allocation failed"])
            return
        }
        blit.copy(from: drawable.texture, sourceSlice: 0, sourceLevel: 0,
                  sourceOrigin: MTLOrigin(x: 0, y: 0, z: 0),
                  sourceSize: MTLSize(width: drawable.texture.width, height: drawable.texture.height, depth: 1),
                  to: readback, destinationOffset: 0, destinationBytesPerRow: rowBytes,
                  destinationBytesPerImage: rowBytes * drawable.texture.height)
        blit.endEncoding()
        renderInFlight = true
        commandBuffer.present(drawable)
        commandBuffer.addCompletedHandler { completed in
            // The Rust handle remains on the main thread, including teardown.
            DispatchQueue.main.async {
                let succeeded = completed.status == .completed
                let detachStatus = self.host.detachMetalContext()
                let probe: [String: Any] = [
                    "schemaVersion": 1, "status": succeeded && detachStatus == 0 ? "passed" : "failed",
                    "source": "ios-skia-metal-app", "hostSurfaceAttached": true,
                    "host": "ios", "engine": selectedEngine, "sessionId": selectedSession,
                    "manifestIntegrity": startupEvidence["integrityRoot"] ?? "", "frameId": 1,
                    "snapshotSha256": snapshotSHA256,
                    "deviceName": self.device.name, "osVersion": UIDevice.current.systemVersion,
                    "screenScale": self.metalLayer.contentsScale,
                    "containerSurfaceAttached": succeeded, "gpuSurface": succeeded,
                    "rendererBackend": "skia-gpu-metal", "width": drawable.texture.width,
                    "height": drawable.texture.height, "evidenceBoundary": "rust-skia-metal-drawable",
                    "commandBufferStatus": completed.status.rawValue, "detachStatus": detachStatus,
                    "commandBufferError": completed.error.map(String.init(describing:)) ?? "",
                    "startup": startupEvidence, "operations": operationEvidence,
                    "runtimeSurface": runtimeSurface,
                    "drawableReadback": succeeded ? recordDrawable(readback, width: drawable.texture.width,
                        height: drawable.texture.height, rowBytes: rowBytes) : [:],
                    "logicalViewport": ["width": self.bounds.width, "height": self.bounds.height],
                    "gpuProbe": ["schemaVersion": 1, "source": "ios-metal-app", "status": "passed",
                                 "contextCreated": true, "hardwareAccelerated": false,
                                 "containerSurfaceAttached": false, "evidenceBoundary": "device-context-only"],
                ]
                writeEvidence(probe)
                if let data = try? JSONSerialization.data(withJSONObject: probe, options: [.sortedKeys]),
                   let text = String(data: data, encoding: .utf8) { print("WEAPP_CONTAINER_SURFACE_PROBE \(text)") }
                self.renderInFlight = false
                self.didRender = true
                // Keep the presented frame alive until the owning smoke
                // supervisor captures the OS composition and cleans up.
            }
        }
        commandBuffer.commit()
    }
}

private final class WeappContainerViewController: UIViewController {
    private var containerView: WeappContainerMetalView!
    override func viewDidLoad() {
        super.viewDidLoad()
        guard let device = MTLCreateSystemDefaultDevice() else { fatalError("MTLCreateSystemDefaultDevice returned nil") }
        view.backgroundColor = .white
        containerView = WeappContainerMetalView(device: device)
        containerView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(containerView)
        NSLayoutConstraint.activate([
            containerView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            containerView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            containerView.topAnchor.constraint(equalTo: view.topAnchor),
            containerView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
    }
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        containerView.start()
    }
}

private final class WeappContainerAppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        return true
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
    }
}

final class WeappContainerSceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene,
               willConnectTo session: UISceneSession,
               options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        if Bundle.main.object(forInfoDictionaryKey: "WeappContainerAppMode") as? String == "embedding" {
            let evidence = WeappContainerEmbeddingEvidence()
            let directory = Bundle.main.bundleURL.appendingPathComponent("portable-pack", isDirectory: true)
            let controller = WeappContainerEmbeddingViewController(packDirectory: directory, engine: selectedEngine,
                                                                    sessionID: selectedSession)
            controller.onConfigure = { container in evidence.configure(container) }
            controller.onStartup = { startup in evidence.recordStartup(startup) }
            controller.onError = { error in evidence.recordFailure(error) }
            window.rootViewController = controller
        } else {
            window.rootViewController = WeappContainerViewController()
        }
        window.makeKeyAndVisible()
        self.window = window
    }
}

@main
private struct WeappContainerAppMain {
    static func main() {
        UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(WeappContainerAppDelegate.self))
    }
}
