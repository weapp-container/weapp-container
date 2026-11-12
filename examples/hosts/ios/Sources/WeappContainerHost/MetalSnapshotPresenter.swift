import Foundation
import Metal
import QuartzCore

/// Error returned by the iOS presentation boundary.
public enum MetalSnapshotPresenterError: Error, CustomStringConvertible {
    case deviceUnavailable
    case commandQueueUnavailable
    case shaderLibraryUnavailable(String)
    case pipelineUnavailable(String)
    case invalidSnapshot(String)
    case drawableUnavailable
    case runtimeAttachmentFailed(Int32)
    case runtimeRenderFailed(Int32)
    case runtimeDetachFailed(Int32)
    case presentationInFlight
    case commandBufferFailed(String)

    public var description: String {
        switch self {
        case .deviceUnavailable: return "MTLCreateSystemDefaultDevice returned nil"
        case .commandQueueUnavailable: return "MTLDevice.makeCommandQueue returned nil"
        case let .shaderLibraryUnavailable(message): return "Metal shader library failed: \(message)"
        case let .pipelineUnavailable(message): return "Metal render pipeline failed: \(message)"
        case let .invalidSnapshot(message): return "invalid RenderSnapshot: \(message)"
        case .drawableUnavailable: return "CAMetalLayer.nextDrawable returned nil"
        case let .runtimeAttachmentFailed(status): return "Rust Skia Metal context attach failed (status \(status))"
        case let .runtimeRenderFailed(status): return "Rust Skia Metal drawable render failed (status \(status))"
        case let .runtimeDetachFailed(status): return "Rust Skia Metal context detach failed (status \(status))"
        case .presentationInFlight: return "a Metal drawable presentation is already in flight"
        case let .commandBufferFailed(message): return "Metal command buffer failed: \(message)"
        }
    }
}

/// Result of an actual Metal command-buffer completion, not merely a queue
/// submission. Readbacks encoded with that presentation are ready on success.
public struct MetalPresentationCompletion {
    public let probe: MetalSurfaceProbe
    public let commandBufferStatus: MTLCommandBufferStatus
    public let error: String?
    public var succeeded: Bool { commandBufferStatus == .completed }
}

/// A complete surface-ownership record for one presented snapshot.
///
/// The software snapshot method records `containerSurfaceAttached=false` even
/// though the host owns a Metal presentation surface. The direct runtime
/// method records `containerSurfaceAttached=true` only after Rust Skia has
/// rendered into the drawable texture and flushed its Metal context.
public struct MetalSurfaceProbe: Sendable {
    public let status: String
    public let source: String
    public let hostSurfaceAttached: Bool
    public let containerSurfaceAttached: Bool
    public let gpuSurface: Bool
    public let rendererBackend: String
    public let width: Int
    public let height: Int
    public let evidenceBoundary: String
    public let reason: String?
    public var gpuCompletion: String = "not-waited"

    public func jsonObject() -> [String: Any] {
        var object: [String: Any] = [
            "schemaVersion": 1,
            "status": status,
            "source": source,
            "hostSurfaceAttached": hostSurfaceAttached,
            "containerSurfaceAttached": containerSurfaceAttached,
            "gpuSurface": gpuSurface,
            "rendererBackend": rendererBackend,
            "width": width,
            "height": height,
            "evidenceBoundary": evidenceBoundary,
            "gpuCompletion": gpuCompletion,
        ]
        if let reason { object["reason"] = reason }
        return object
    }
}

/// Upload one complete Weapp Container RGBA snapshot to an app-owned CAMetalLayer.
///
/// The class deliberately has no dependency on UIView or a window. An iOS
/// app embeds it by passing the CAMetalLayer from a UIView's backing layer;
/// tests may pass a standalone layer and inspect whether CoreAnimation gives
/// the host a real drawable. Runtime state stays in `WeappContainerHost` and
/// crosses the FFI boundary once per snapshot.
public final class MetalSnapshotPresenter: @unchecked Sendable {
    public let layer: CAMetalLayer
    public let device: MTLDevice

    private let commandQueue: MTLCommandQueue
    private let pipeline: MTLRenderPipelineState
    private let sampler: MTLSamplerState
    private var lastProbe: MetalSurfaceProbe?
    private var pendingPresentation: MTLCommandBuffer?
    public var hasPendingPresentation: Bool { pendingPresentation != nil }

    public init(layer: CAMetalLayer, device: MTLDevice? = MTLCreateSystemDefaultDevice()) throws {
        guard let device else { throw MetalSnapshotPresenterError.deviceUnavailable }
        guard let commandQueue = device.makeCommandQueue() else {
            throw MetalSnapshotPresenterError.commandQueueUnavailable
        }
        self.layer = layer
        self.device = device
        self.commandQueue = commandQueue
        layer.device = device
        layer.pixelFormat = .bgra8Unorm
        // The Rust Ganesh path wraps the drawable texture directly. A
        // snapshot upload can use a framebuffer-only drawable, but direct
        // Skia rendering requires the texture to be readable by the backend.
        layer.framebufferOnly = false
        layer.contentsScale = 1

        let source = """
        #include <metal_stdlib>
        using namespace metal;
        struct VertexOut { float4 position [[position]]; float2 uv; };
        vertex VertexOut weapp_container_vertex(uint vertexID [[vertex_id]]) {
            constexpr float2 positions[4] = {
                float2(-1.0, -1.0), float2(1.0, -1.0),
                float2(-1.0, 1.0), float2(1.0, 1.0)
            };
            constexpr float2 uvs[4] = {
                float2(0.0, 1.0), float2(1.0, 1.0),
                float2(0.0, 0.0), float2(1.0, 0.0)
            };
            VertexOut out;
            out.position = float4(positions[vertexID], 0.0, 1.0);
            out.uv = uvs[vertexID];
            return out;
        }
        fragment float4 weapp_container_fragment(
            VertexOut in [[stage_in]],
            texture2d<float> texture [[texture(0)]],
            sampler samplerState [[sampler(0)]]) {
            return texture.sample(samplerState, in.uv);
        }
        """
        let library: MTLLibrary
        do {
            library = try device.makeLibrary(source: source, options: nil)
        } catch {
            throw MetalSnapshotPresenterError.shaderLibraryUnavailable(String(describing: error))
        }
        guard let vertex = library.makeFunction(name: "weapp_container_vertex"),
              let fragment = library.makeFunction(name: "weapp_container_fragment") else {
            throw MetalSnapshotPresenterError.shaderLibraryUnavailable("entry point missing")
        }
        let descriptor = MTLRenderPipelineDescriptor()
        descriptor.vertexFunction = vertex
        descriptor.fragmentFunction = fragment
        descriptor.colorAttachments[0].pixelFormat = layer.pixelFormat
        do {
            pipeline = try device.makeRenderPipelineState(descriptor: descriptor)
        } catch {
            throw MetalSnapshotPresenterError.pipelineUnavailable(String(describing: error))
        }
        let samplerDescriptor = MTLSamplerDescriptor()
        samplerDescriptor.minFilter = .linear
        samplerDescriptor.magFilter = .linear
        samplerDescriptor.sAddressMode = .clampToEdge
        samplerDescriptor.tAddressMode = .clampToEdge
        guard let sampler = device.makeSamplerState(descriptor: samplerDescriptor) else {
            throw MetalSnapshotPresenterError.pipelineUnavailable("sampler creation failed")
        }
        self.sampler = sampler
    }

    /// Present a serialized `RenderSnapshot` returned by the iOS FFI bridge.
    @discardableResult
    public func present(snapshot: Data) throws -> MetalSurfaceProbe {
        guard let object = try JSONSerialization.jsonObject(with: snapshot) as? [String: Any],
              let width = object["width"] as? Int,
              let height = object["height"] as? Int,
              let stride = object["stride"] as? Int,
              let values = object["pixels"] as? [NSNumber] else {
            throw MetalSnapshotPresenterError.invalidSnapshot("expected width, height, stride and pixels")
        }
        guard width > 0, height > 0, stride >= width * 4 else {
            throw MetalSnapshotPresenterError.invalidSnapshot("invalid dimensions or stride")
        }
        guard values.count >= stride * height else {
            throw MetalSnapshotPresenterError.invalidSnapshot("pixel buffer is truncated")
        }
        var pixels = [UInt8](repeating: 0, count: stride * height)
        for index in pixels.indices {
            let value = values[index].intValue
            guard (0...255).contains(value) else {
                throw MetalSnapshotPresenterError.invalidSnapshot("pixel value is outside 0...255")
            }
            pixels[index] = UInt8(value)
        }
        guard let texture = makeTexture(width: width, height: height, pixels: pixels, stride: stride) else {
            throw MetalSnapshotPresenterError.pipelineUnavailable("texture creation failed")
        }
        // A view-backed layer owns its drawable size (usually bounds ×
        // contentsScale). The standalone smoke starts with an empty layer, so
        // seed a size only in that case; never resize an embedding app's
        // surface to the logical snapshot dimensions.
        if layer.drawableSize.width <= 0 || layer.drawableSize.height <= 0 {
            layer.drawableSize = CGSize(width: max(1, width), height: max(1, height))
        }
        guard let drawable = layer.nextDrawable() else {
            throw MetalSnapshotPresenterError.drawableUnavailable
        }
        let renderPass = MTLRenderPassDescriptor()
        renderPass.colorAttachments[0].texture = drawable.texture
        renderPass.colorAttachments[0].loadAction = .clear
        renderPass.colorAttachments[0].storeAction = .store
        renderPass.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 1)
        guard let commandBuffer = commandQueue.makeCommandBuffer(),
              let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: renderPass) else {
            throw MetalSnapshotPresenterError.commandQueueUnavailable
        }
        encoder.setRenderPipelineState(pipeline)
        encoder.setFragmentTexture(texture, index: 0)
        encoder.setFragmentSamplerState(sampler, index: 0)
        encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
        encoder.endEncoding()
        commandBuffer.present(drawable)
        commandBuffer.commit()
        let probe = MetalSurfaceProbe(
            status: "passed",
            source: "ios-metal-layer",
            hostSurfaceAttached: true,
            containerSurfaceAttached: false,
            gpuSurface: false,
            rendererBackend: "software-fallback",
            width: width,
            height: height,
            evidenceBoundary: "runtime-snapshot-upload",
            reason: nil,
        )
        lastProbe = probe
        return probe
    }

    /// Attach the app-owned Metal device/queue to the Rust runtime. This is a
    /// separate operation from the software snapshot presenter so a host can
    /// report exactly which rendering boundary was exercised.
    public func attach(runtime: WeappContainerHost) throws {
        let status = runtime.attachMetalContext(device: device, commandQueue: commandQueue)
        guard status == 0 else {
            throw MetalSnapshotPresenterError.runtimeAttachmentFailed(status)
        }
    }

    /// Draw the last committed runtime frame directly into a CAMetalLayer
    /// drawable through Rust Skia Ganesh Metal. No RGBA snapshot is copied
    /// across Swift and no software upload is involved in this path.
    @discardableResult
    public func present(runtime: WeappContainerHost) throws -> MetalSurfaceProbe {
        let revision = try runtime.renderRevision()
        guard let drawable = layer.nextDrawable() else {
            throw MetalSnapshotPresenterError.drawableUnavailable
        }
        let texture = drawable.texture
        let status = runtime.renderLastFrame(to: texture)
        guard status == 0 else {
            throw MetalSnapshotPresenterError.runtimeRenderFailed(status)
        }
        guard let commandBuffer = commandQueue.makeCommandBuffer() else {
            throw MetalSnapshotPresenterError.commandQueueUnavailable
        }
        commandBuffer.present(drawable)
        commandBuffer.commit()
        try runtime.acknowledgePresentation(revision: revision)
        let probe = MetalSurfaceProbe(
            status: "passed",
            source: "ios-skia-metal-layer",
            hostSurfaceAttached: true,
            containerSurfaceAttached: true,
            gpuSurface: true,
            rendererBackend: "skia-gpu-metal",
            width: texture.width,
            height: texture.height,
            evidenceBoundary: "rust-skia-metal-drawable",
            reason: nil,
        )
        lastProbe = probe
        return probe
    }

    /// Present one native Rust Skia frame, then report GPU completion on the
    /// main queue. `encode` can append a host pass or an explicit smoke
    /// readback to the same ordered command buffer; it never uploads a CPU
    /// snapshot. The caller must serialize this method and teardown on main.
    public func present(runtime: WeappContainerHost,
                        encode: ((MTLCommandBuffer, MTLTexture) throws -> Void)? = nil,
                        acknowledge: ((UInt64) throws -> Void)? = nil,
                        completion: @escaping (MetalPresentationCompletion) -> Void) throws {
        precondition(Thread.isMainThread, "Metal presentation owner must be on the main thread")
        guard pendingPresentation == nil else { throw MetalSnapshotPresenterError.presentationInFlight }
        let revision = try runtime.renderRevision()
        guard let drawable = layer.nextDrawable() else { throw MetalSnapshotPresenterError.drawableUnavailable }
        let texture = drawable.texture
        let status = runtime.renderLastFrame(to: texture)
        guard status == 0 else { throw MetalSnapshotPresenterError.runtimeRenderFailed(status) }
        guard let commandBuffer = commandQueue.makeCommandBuffer() else {
            throw MetalSnapshotPresenterError.commandQueueUnavailable
        }
        try encode?(commandBuffer, texture)
        commandBuffer.present(drawable)
        pendingPresentation = commandBuffer
        commandBuffer.addCompletedHandler { [weak self] completed in
            let status = completed.status
            let error = completed.error.map { String(describing: $0) }
            let probe = MetalSurfaceProbe(
                status: status == .completed ? "passed" : "failed",
                source: "ios-skia-metal-layer",
                hostSurfaceAttached: true,
                containerSurfaceAttached: status == .completed,
                gpuSurface: status == .completed,
                rendererBackend: "skia-gpu-metal",
                width: texture.width,
                height: texture.height,
                evidenceBoundary: "rust-skia-metal-drawable",
                reason: error ?? (status == .completed ? nil : "Metal command status \(status.rawValue)"),
                gpuCompletion: status == .completed ? "completed" : "failed",
            )
            DispatchQueue.main.async { [weak self] in
                // Teardown may already have drained and cleared this buffer.
                if let pending = self?.pendingPresentation, pending === completed {
                    self?.pendingPresentation = nil
                }
                self?.lastProbe = probe
                completion(MetalPresentationCompletion(probe: probe, commandBufferStatus: status, error: error))
            }
        }
        commandBuffer.commit()
        if let acknowledge { try acknowledge(revision) }
        else { try runtime.acknowledgePresentation(revision: revision) }
    }

    /// Drain the host queue before detaching Rust's context or releasing its
    /// device. A fence also covers Rust work submitted before a host encoding
    /// error, when no presentation command buffer reached `commit`.
    public func finishPendingPresentation() throws {
        precondition(Thread.isMainThread, "Metal presentation owner must be on the main thread")
        let commandBuffer: MTLCommandBuffer
        if let pending = pendingPresentation {
            commandBuffer = pending
        } else {
            guard let fence = commandQueue.makeCommandBuffer() else {
                throw MetalSnapshotPresenterError.commandQueueUnavailable
            }
            commandBuffer = fence
            commandBuffer.commit()
        }
        commandBuffer.waitUntilCompleted()
        pendingPresentation = nil
        guard commandBuffer.status == .completed else {
            throw MetalSnapshotPresenterError.commandBufferFailed(
                commandBuffer.error.map { String(describing: $0) } ?? "status \(commandBuffer.status.rawValue)")
        }
    }

    /// Detach the runtime context before tearing down the layer/device.
    public func detach(runtime: WeappContainerHost) throws {
        let status = runtime.detachMetalContext()
        guard status == 0 else {
            throw MetalSnapshotPresenterError.runtimeDetachFailed(status)
        }
        lastProbe = nil
    }

    public var surfaceProbe: MetalSurfaceProbe? { lastProbe }

    private func makeTexture(width: Int, height: Int, pixels: [UInt8], stride: Int) -> MTLTexture? {
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .rgba8Unorm,
            width: width,
            height: height,
            mipmapped: false,
        )
        guard let texture = device.makeTexture(descriptor: descriptor) else { return nil }
        pixels.withUnsafeBytes { rawBuffer in
            guard let baseAddress = rawBuffer.baseAddress else { return }
            texture.replace(
                region: MTLRegionMake2D(0, 0, width, height),
                mipmapLevel: 0,
                withBytes: baseAddress,
                bytesPerRow: stride,
            )
        }
        return texture
    }
}
