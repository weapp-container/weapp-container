import Foundation
import Metal
import WeappContainerFFI

public enum WeappPageRenderMode: String {
    case raster
    case nativeGpu = "native-gpu"
}

/// Thread-affine Swift owner for one Rust `container-host-ios` session.
public final class WeappContainerHost: WeappContainerSessionRuntime {
    private var handle: UnsafeMutableRawPointer?
    private let pageRenderMode: WeappPageRenderMode
    public private(set) var manifestLoadError: String?
    public var manifestLoadFailure: WeappPortablePackError? {
        guard let text = manifestLoadError, let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let error = object["error"] as? [String: Any] else { return nil }
        return WeappPortablePackError("manifest.load", error["code"] as? String ?? "ERR_ENGINE",
                                       error["message"] as? String ?? text)
    }

    public init(pageRenderMode: WeappPageRenderMode = .raster) {
        self.pageRenderMode = pageRenderMode
        handle = weapp_container_ios_host_new()
    }

    deinit {
        if let handle {
            weapp_container_ios_host_free(handle)
        }
    }

    @discardableResult
    public func loadManifest(_ manifest: Data) -> Int32 {
        manifest.withUnsafeBytes { rawBytes in
            let bytes = rawBytes.bindMemory(to: UInt8.self)
            return weapp_container_ios_host_load_manifest(handle, bytes.baseAddress, bytes.count)
        }
    }

    public func loadManifest(_ manifest: Data, engine: String, sessionID: String) -> Int32 {
        loadManifest(manifest, engine: engine, sessionID: sessionID, width: 375, height: 667)
    }

    public func loadManifest(_ manifest: Data, engine: String, sessionID: String,
                             width: Double, height: Double) -> Int32 {
        guard width.isFinite, height.isFinite, width > 0, height > 0,
              width <= Double(UInt32.max), height <= Double(UInt32.max) else { return -2 }
        guard let config = try? JSONSerialization.data(withJSONObject: [
            "engine": engine, "session_id": sessionID, "require_integrity": true,
            "page_render_mode": pageRenderMode.rawValue,
            "host": ["platform": "ios", "windowWidth": max(1, UInt32(width.rounded())),
                     "windowHeight": max(1, UInt32(height.rounded()))]
        ]) else { return -2 }
        var output = WeappContainerFfiBuffer(data: nil, len: 0)
        let status = manifest.withUnsafeBytes { manifestBytes in
            config.withUnsafeBytes { configBytes in
                weapp_container_ios_host_load_manifest_with_config(handle,
                    manifestBytes.bindMemory(to: UInt8.self).baseAddress, manifestBytes.count,
                    configBytes.bindMemory(to: UInt8.self).baseAddress, configBytes.count, &output)
            }
        }
        manifestLoadError = output.data.map { String(decoding: Data(bytes: $0, count: output.len), as: UTF8.self) }
        weapp_container_ios_buffer_free(&output)
        return status
    }

    /// Returns the versioned build/runtime surface capability report. The
    /// report intentionally distinguishes a CPU raster readback from a
    /// platform GPU attachment.
    public func capabilities() -> (status: Int32, response: Data) {
        var output = WeappContainerFfiBuffer(data: nil, len: 0)
        let status = weapp_container_ios_host_capabilities(handle, &output)
        let response = output.data.map { Data(bytes: $0, count: output.len) } ?? Data()
        weapp_container_ios_buffer_free(&output)
        return (status, response)
    }

    /// Returns the complete `app.init` batch; bridge allocation is released by
    /// the Rust ABI before this method returns.
    public func start(requestID: String) -> (status: Int32, response: Data) {
        var output = WeappContainerFfiBuffer(data: nil, len: 0)
        let status = requestID.utf8.withContiguousStorageIfAvailable { request in
            weapp_container_ios_host_start(handle, request.baseAddress, request.count, &output)
        } ?? weapp_container_ios_host_start(handle, nil, 0, &output)
        let response = output.data.map { Data(bytes: $0, count: output.len) } ?? Data()
        weapp_container_ios_buffer_free(&output)
        return (status, response)
    }

    public func dispatch(_ envelope: Data) -> (status: Int32, response: Data) {
        var output = WeappContainerFfiBuffer(data: nil, len: 0)
        let status = envelope.withUnsafeBytes { rawBytes in
            let bytes = rawBytes.bindMemory(to: UInt8.self)
            return weapp_container_ios_host_dispatch_json(handle, bytes.baseAddress, bytes.count, &output)
        }
        let response = output.data.map { Data(bytes: $0, count: output.len) } ?? Data()
        weapp_container_ios_buffer_free(&output)
        return (status, response)
    }

    /// Logical viewport geometry only; the session owner commits/presents
    /// the next frame after consuming all resize hook effects.
    public func resize(width: UInt32, height: UInt32) -> (status: Int32, response: Data) {
        var output = WeappContainerFfiBuffer(data: nil, len: 0)
        let status = weapp_container_ios_host_resize_viewport(handle, width, height, &output)
        let response = output.data.map { Data(bytes: $0, count: output.len) } ?? Data()
        weapp_container_ios_buffer_free(&output)
        return (status, response)
    }

    /// `nowNs` uses Unix-epoch nanoseconds to match Date.now() timer deadlines.
    public func pollTimers(nowNs: UInt64) -> (status: Int32, response: Data) {
        var output = WeappContainerFfiBuffer(data: nil, len: 0)
        let status = weapp_container_ios_host_poll_timers(handle, nowNs, &output)
        let response = output.data.map { Data(bytes: $0, count: output.len) } ?? Data()
        weapp_container_ios_buffer_free(&output)
        return (status, response)
    }

    /// Current page/viewport/frame metadata, excluding pixels and view trees.
    public func sessionState() -> (status: Int32, response: Data) {
        var output = WeappContainerFfiBuffer(data: nil, len: 0)
        let status = weapp_container_ios_host_session_state(handle, &output)
        let response = output.data.map { Data(bytes: $0, count: output.len) } ?? Data()
        weapp_container_ios_buffer_free(&output)
        return (status, response)
    }

    /// Identity of the retained frame before recording a drawable.
    public func renderRevision() throws -> UInt64 {
        let result = sessionState()
        guard result.status == 0,
              let state = try JSONSerialization.jsonObject(with: result.response) as? [String: Any],
              let revision = state["renderRevision"] as? UInt64, revision > 0 else {
            throw WeappPortablePackError("presentation", "ERR_RENDER", "no committed render revision")
        }
        return revision
    }

    /// Submit readiness effects on the runtime owner thread after present+commit.
    /// This acknowledges queue submission; it does not claim GPU completion.
    public func acknowledgePresentation(revision: UInt64) throws {
        let (status, response) = acknowledgePresentationBatch(revision: revision)
        try Self.validatePresentationAcknowledgement(status: status, response: response)
    }

    /// Session owners consume this entire batch so successful ready/observer
    /// diagnostics and operations are retained alongside their later errors.
    public func acknowledgePresentationBatch(revision: UInt64) -> (status: Int32, response: Data) {
        var output = WeappContainerFfiBuffer(data: nil, len: 0)
        let status = weapp_container_ios_host_acknowledge_presentation(handle, revision, &output)
        let response = output.data.map { Data(bytes: $0, count: output.len) } ?? Data()
        weapp_container_ios_buffer_free(&output)
        return (status, response)
    }

    private static func validatePresentationAcknowledgement(status: Int32, response: Data) throws {
        guard let batch = try JSONSerialization.jsonObject(with: response) as? [String: Any] else {
            throw WeappPortablePackError("presentation", "ERR_ENGINE", "invalid acknowledgement")
        }
        if let messages = batch["messages"] as? [[String: Any]] {
            for message in messages {
                let payload = message["payload"] as? [String: Any] ?? [:]
                if message["op"] as? String == "error" || payload["ok"] as? Bool == false {
                    let error = payload["error"] as? [String: Any] ?? payload
                    throw WeappPortablePackError("presentation", error["code"] as? String ?? "ERR_ENGINE",
                        error["message"] as? String ?? "presentation callback failed after submission")
                }
            }
        } else {
            throw WeappPortablePackError("presentation", "ERR_ENGINE", String(decoding: response, as: UTF8.self))
        }
        guard status == 0 else { throw WeappPortablePackError("presentation", "ERR_ENGINE", "ABI status \(status)") }
    }

    /// Opt-in development observation only. One immutable page-data batch;
    /// this never executes JS, polls timers or serializes pixels/view nodes.
    public func inspectState() -> (status: Int32, response: Data) {
        var output = WeappContainerFfiBuffer(data: nil, len: 0)
        let status = weapp_container_ios_host_inspect_state(handle, &output)
        let response = output.data.map { Data(bytes: $0, count: output.len) } ?? Data()
        weapp_container_ios_buffer_free(&output)
        return (status, response)
    }

    /// Dispatch lifecycle unload first when hooks must run. Repeated calls
    /// release no additional resources and leave the host reusable.
    @discardableResult
    public func unload() -> Int32 {
        weapp_container_ios_host_unload(handle)
    }

    /// Returns one complete RGBA8 render snapshot after a render.commit.
    public func renderSnapshot() -> (status: Int32, response: Data) {
        var output = WeappContainerFfiBuffer(data: nil, len: 0)
        let status = weapp_container_ios_host_render_snapshot(handle, &output)
        let response = output.data.map { Data(bytes: $0, count: output.len) } ?? Data()
        weapp_container_ios_buffer_free(&output)
        return (status, response)
    }

    /// Attach the app-owned Metal device and command queue to the Rust Skia
    /// Ganesh renderer. The host remains thread-affine to the caller's Metal
    /// surface queue; context creation alone does not mark a GPU surface.
    @discardableResult
    public func attachMetalContext(device: MTLDevice, commandQueue: MTLCommandQueue) -> Int32 {
        let devicePointer = Unmanaged.passUnretained(device as AnyObject).toOpaque()
        let queuePointer = Unmanaged.passUnretained(commandQueue as AnyObject).toOpaque()
        return weapp_container_ios_host_attach_metal_context(handle, devicePointer, queuePointer)
    }

    /// Render the last committed frame directly into a CAMetalLayer drawable
    /// texture. The caller owns presentation and command-buffer commit.
    @discardableResult
    public func renderLastFrame(to texture: MTLTexture) -> Int32 {
        let texturePointer = Unmanaged.passUnretained(texture as AnyObject).toOpaque()
        return weapp_container_ios_host_render_metal_texture(
            handle,
            texturePointer,
            UInt32(texture.width),
            UInt32(texture.height),
        )
    }

    @discardableResult
    public func detachMetalContext() -> Int32 {
        weapp_container_ios_host_detach_metal_context(handle)
    }

    /// Returns one complete Canvas 2D RGBA8 snapshot by UTF-8 canvas id.
    public func canvasSnapshot(canvasID: String) -> (status: Int32, response: Data) {
        var output = WeappContainerFfiBuffer(data: nil, len: 0)
        let status = canvasID.utf8.withContiguousStorageIfAvailable { canvas in
            weapp_container_ios_host_canvas_snapshot(handle, canvas.baseAddress, canvas.count, &output)
        } ?? weapp_container_ios_host_canvas_snapshot(handle, nil, 0, &output)
        let response = output.data.map { Data(bytes: $0, count: output.len) } ?? Data()
        weapp_container_ios_buffer_free(&output)
        return (status, response)
    }
}
