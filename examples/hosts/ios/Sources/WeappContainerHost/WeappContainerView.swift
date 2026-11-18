#if canImport(UIKit)
import Foundation
import Metal
import QuartzCore
import UIKit

public enum WeappContainerViewError: Error, CustomStringConvertible {
    case nativeRuntimeRequired
    case sessionUnavailable

    public var description: String {
        switch self {
        case .nativeRuntimeRequired: return "WeappContainerView requires the native iOS Rust runtime and Metal backend"
        case .sessionUnavailable: return "WeappContainerView cannot own a closed or failed session"
        }
    }
}

@MainActor
private final class WeappContainerDisplayLinkTarget: NSObject {
    weak var view: WeappContainerView?

    @objc func tick(_ displayLink: CADisplayLink) {
        view?.displayTick(displayLink)
    }
}

/// An embeddable native mini-program surface. Its Rust session, input,
/// lifecycle, resize and timer operations stay on the UIKit main thread.
/// Rendering uses Rust Skia directly into CAMetalLayer; an unavailable Metal
/// backend is an error and never selects a software snapshot upload.
///
/// The view owns `session`. Removing it from a window pauses that session;
/// adding it again resumes it. Call `close()` when the embedding feature is
/// finished. Deinitialization also releases owned resources on the main queue.
public final class WeappContainerView: UIView {
    public override class var layerClass: AnyClass { CAMetalLayer.self }

    public let session: WeappContainerSession
    public private(set) var isClosed = false
    public private(set) var lastError: Error?
    public private(set) var lastPresentedFrameID: UInt64?

    /// Surface failures suspend input and automatic rendering while business
    /// timers continue. Fatal runtime/protocol failures also stop the pump.
    /// Call render() explicitly to retry a suspended presentation.
    public var onError: ((Error) -> Void)?

    /// Optional host GPU pass, including a smoke-only drawable readback.
    /// Called on main before presentation; it must not mutate the session.
    public var onEncodeFrame: ((UInt64, MTLCommandBuffer, MTLTexture) throws -> Void)?

    /// Called on main after the presentation command buffer has completed.
    /// A submitted frame alone does not satisfy this callback's GPU evidence.
    public var onPresented: ((UInt64, MetalPresentationCompletion) -> Void)?

    public var metalLayer: CAMetalLayer { layer as! CAMetalLayer }
    public var metalDevice: MTLDevice? { presenter?.device }

    private let runtime: WeappContainerHost
    private var presenter: MetalSnapshotPresenter?
    private var metalAttached = false
    private var displayLink: CADisplayLink?
    private let displayLinkTarget = WeappContainerDisplayLinkTarget()
    private var notificationTokens: [NSObjectProtocol] = []
    private var effectiveForeground = false
    private var hasBecomeForeground = false
    private var applicationSuspended = false
    private var sceneSuspended = false
    private var observedSceneID: ObjectIdentifier?
    private var presentationInFlight = false
    private var surfaceEpoch: UInt64 = 0
    private var presentedSurfaceEpoch: UInt64?
    private var trackedTouch: UITouch?
    private var trackedLocation = CGPoint.zero
    private var ignoringMultipleTouches = false
    private var ownedLayer: CAMetalLayer?

    public convenience init(pack: WeappPortablePack, engine: String = "quickjs",
                            sessionID: String = UUID().uuidString, route: String? = nil,
                            width: Double = 375, height: Double = 667,
                            device: MTLDevice? = MTLCreateSystemDefaultDevice()) throws {
        precondition(Thread.isMainThread, "WeappContainerView must be created on the main thread")
        let runtime = WeappContainerHost(pageRenderMode: .nativeGpu)
        let session = try WeappContainerSession(pack: pack, runtime: runtime, engine: engine,
                                                sessionID: sessionID, route: route, width: width, height: height)
        try self.init(session: session, device: device)
    }

    public init(session: WeappContainerSession,
                device: MTLDevice? = MTLCreateSystemDefaultDevice()) throws {
        precondition(Thread.isMainThread, "WeappContainerView must be created on the main thread")
        guard !session.isClosed, !session.isFailed else { throw WeappContainerViewError.sessionUnavailable }
        guard let runtime = session.runtime as? WeappContainerHost else {
            throw WeappContainerViewError.nativeRuntimeRequired
        }
        // This no-op transition checks the Foundation owner's thread before
        // any Metal/FFI operation can touch an externally supplied session.
        try session.setForeground(session.isForeground)
        self.session = session
        self.runtime = runtime
        super.init(frame: .zero)
        isOpaque = false
        backgroundColor = .clear
        isMultipleTouchEnabled = true
        metalLayer.isOpaque = false
        metalLayer.presentsWithTransaction = false
        ownedLayer = metalLayer
        let presenter = try MetalSnapshotPresenter(layer: metalLayer, device: device)
        self.presenter = presenter
        try presenter.attach(runtime: runtime)
        metalAttached = true
        // Launch has already shown the session. Until this host first becomes
        // active, an absent/inactive window only pauses pump and input.
        applicationSuspended = UIApplication.shared.applicationState != .active
        displayLinkTarget.view = self
        observeActivity()
    }

    @available(*, unavailable, message: "Create WeappContainerView with a verified portable pack or session")
    public required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

    deinit {
        // CADisplayLink retains only the weak target above. If an application
        // releases its final Swift reference off-main, retain the Rust owner
        // until the main queue has completed teardown and destruction.
        let link = displayLink
        let tokens = notificationTokens
        let presenter = presenter
        let runtime = runtime
        let session = session
        let layer = ownedLayer
        let attached = metalAttached
        let release = {
            link?.invalidate()
            for token in tokens { NotificationCenter.default.removeObserver(token) }
            if let presenter {
                do { try presenter.finishPendingPresentation() }
                catch { NSLog("Weapp Container Metal drain failed during teardown: %@", String(describing: error)) }
                if attached {
                    do { try presenter.detach(runtime: runtime) }
                    catch { NSLog("Weapp Container Metal detach failed during teardown: %@", String(describing: error)) }
                }
            }
            layer?.device = nil
            do { try session.close() }
            catch { NSLog("Weapp Container session close failed during teardown: %@", String(describing: error)) }
        }
        if Thread.isMainThread { release() }
        else { DispatchQueue.main.async(execute: release) }
    }

    public override func didMoveToWindow() {
        super.didMoveToWindow()
        guard !isClosed else { return }
        let sceneID = window?.windowScene.map(ObjectIdentifier.init)
        if sceneID != observedSceneID {
            observedSceneID = sceneID
            sceneSuspended = false
        }
        surfaceEpoch &+= 1
        setNeedsLayout()
        synchronizeActivity()
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        guard !isClosed, !session.isFailed else { return }
        guard bounds.width.isFinite, bounds.height.isFinite, bounds.width > 0, bounds.height > 0 else {
            // A collapsed surface still owns the preceding UIKit contact.
            // End it now, before input suppression can hide touchesEnded.
            do { try cancelTrackedTouch() } catch { fail(error) }
            ignoringMultipleTouches = false
            return
        }
        let scale = window?.screen.scale ?? contentScaleFactor
        guard scale.isFinite, scale > 0, bounds.width.isFinite, bounds.height.isFinite else { return }
        let drawableSize = CGSize(width: max(1, (bounds.width * scale).rounded()),
                                  height: max(1, (bounds.height * scale).rounded()))
        if metalLayer.contentsScale != scale || metalLayer.drawableSize != drawableSize {
            metalLayer.contentsScale = scale
            metalLayer.drawableSize = drawableSize
            surfaceEpoch &+= 1
        }
        do {
            // AppService reports integral logical points, while the Metal
            // drawable uses physical pixels. Touches use the inverse mapping.
            let width = Double(max(1, bounds.width.rounded()))
            let height = Double(max(1, bounds.height.rounded()))
            if width != session.viewportWidth || height != session.viewportHeight {
                try cancelTrackedTouch()
                _ = try session.resize(width: width, height: height)
            }
            try presentIfNeeded()
        } catch { fail(error) }
    }

    /// Idempotent final teardown. All cleanup steps run even if a preceding
    /// step fails; the first failure is returned to the embedding application.
    public func close() throws {
        precondition(Thread.isMainThread, "WeappContainerView must be closed on the main thread")
        guard !isClosed else { return }
        isClosed = true
        displayLink?.invalidate()
        displayLink = nil
        displayLinkTarget.view = nil
        for token in notificationTokens { NotificationCenter.default.removeObserver(token) }
        notificationTokens.removeAll()
        var firstError: Error?
        func attempt(_ operation: () throws -> Void) {
            do { try operation() } catch { if firstError == nil { firstError = error } }
        }
        attempt { try cancelTrackedTouch() }
        attempt { try session.setForeground(false) }
        effectiveForeground = false
        if let presenter {
            attempt { try presenter.finishPendingPresentation() }
            if metalAttached { attempt { try presenter.detach(runtime: runtime) } }
        }
        metalAttached = false
        presenter = nil
        ownedLayer?.device = nil
        attempt { try session.close() }
        if let firstError { throw firstError }
    }

    /// Retry the current live page after a rendering/presentation failure.
    /// Successful Metal completion restores input and automatic rendering.
    /// A fatal runtime failure requires a new session instead.
    public func render() throws {
        precondition(Thread.isMainThread, "WeappContainerView must render on the main thread")
        guard !isClosed, effectiveForeground, session.canRun else { return }
        guard !presentationInFlight else { return }
        do {
            guard try session.render() else { return }
            try presentIfNeeded(force: true)
        } catch {
            fail(error)
            throw error
        }
    }

    fileprivate func displayTick(_ displayLink: CADisplayLink) {
        guard !isClosed, effectiveForeground, session.canRun else { return }
        do {
            // Runtime scheduling currently uses Unix nanoseconds. Event time
            // stamps intentionally remain UIKit's monotonic milliseconds.
            _ = try session.pollTimers(nowNs: WeappContainerSession.clockNowNs())
            try presentIfNeeded()
        } catch { fail(error) }
    }

    private func presentIfNeeded(force: Bool = false) throws {
        guard !isClosed, effectiveForeground, session.canRun,
              force || session.canAutomaticallyRender,
              !presentationInFlight, bounds.width > 0, bounds.height > 0,
              let presenter,
              lastPresentedFrameID != session.frameID || presentedSurfaceEpoch != surfaceEpoch else { return }
        let frameID = session.frameID
        let epoch = surfaceEpoch
        var acknowledgementAccepted = false
        presentationInFlight = true
        do {
            try presenter.present(runtime: runtime, encode: { [weak self] buffer, texture in
                try self?.onEncodeFrame?(frameID, buffer, texture)
            }, acknowledge: { [weak self] revision in
                guard let self, !self.isClosed else { return }
                try self.session.consumePresentationAcknowledgement(
                    self.runtime.acknowledgePresentationBatch(revision: revision), revision: revision)
                acknowledgementAccepted = true
            }, completion: { [weak self] result in
                guard let self, !self.isClosed else { return }
                self.presentationInFlight = false
                guard result.succeeded else {
                    self.fail(MetalSnapshotPresenterError.commandBufferFailed(
                        result.error ?? "status \(result.commandBufferStatus.rawValue)"))
                    self.onPresented?(frameID, result)
                    return
                }
                self.lastPresentedFrameID = frameID
                self.presentedSurfaceEpoch = epoch
                if acknowledgementAccepted, !self.session.isFailed,
                   frameID == self.session.frameID, epoch == self.surfaceEpoch,
                   force || !self.session.isPresentationSuspended {
                    do {
                        try self.session.resumePresentation()
                        self.lastError = nil
                    } catch { self.fail(error) }
                }
                self.onPresented?(frameID, result)
            })
        } catch MetalSnapshotPresenterError.drawableUnavailable {
            // Offscreen, backgrounded and temporarily exhausted layers may
            // have no drawable. A healthy pump retries next tick; an explicit
            // recovery reports that it has not yet restored the surface.
            presentationInFlight = presenter.hasPendingPresentation
            if force, session.isPresentationSuspended {
                throw MetalSnapshotPresenterError.drawableUnavailable
            }
        } catch {
            // A ready callback may throw after command-buffer submission.
            // Its completion still owns this in-flight slot and teardown.
            presentationInFlight = presenter.hasPendingPresentation
            throw error
        }
    }

    private func observeActivity() {
        let names: [Notification.Name] = [
            UIApplication.didBecomeActiveNotification, UIApplication.willResignActiveNotification,
            UIApplication.didEnterBackgroundNotification,
            UIScene.didActivateNotification, UIScene.willDeactivateNotification,
            UIScene.didEnterBackgroundNotification, UIScene.didDisconnectNotification,
        ]
        notificationTokens = names.map { name in
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] notification in
                self?.activityChanged(notification)
            }
        }
    }

    private func activityChanged(_ notification: Notification) {
        guard !isClosed else { return }
        if notification.name == UIApplication.didBecomeActiveNotification {
            applicationSuspended = false
        } else if notification.name == UIApplication.willResignActiveNotification || notification.name == UIApplication.didEnterBackgroundNotification {
            applicationSuspended = true
        } else {
            guard let scene = notification.object as? UIScene, scene === window?.windowScene else { return }
            sceneSuspended = notification.name != UIScene.didActivateNotification
        }
        synchronizeActivity()
    }

    private func synchronizeActivity() {
        guard !isClosed, !session.isFailed else { return }
        let activeScene: Bool
        if let scene = window?.windowScene { activeScene = scene.activationState == .foregroundActive && !sceneSuspended }
        else { activeScene = UIApplication.shared.applicationState == .active }
        let foreground = window != nil && activeScene && !applicationSuspended
        // UIKit can attach the first window while its app/scene is inactive.
        // That is startup, not a foreground-to-background transition. Keep
        // the already-shown session intact until this host first activates.
        guard foreground || hasBecomeForeground else {
            displayLink?.isPaused = true
            return
        }
        if foreground { hasBecomeForeground = true }
        do {
            if foreground != effectiveForeground || foreground != session.isForeground {
                if !foreground {
                    try cancelTrackedTouch()
                    ignoringMultipleTouches = false
                }
                try session.setForeground(foreground)
                // Completed-operation observers may close the embedding view.
                // Do not recreate a display link after that teardown returns.
                guard !isClosed, !session.isClosed, !session.isFailed else {
                    effectiveForeground = false
                    displayLink?.isPaused = true
                    return
                }
                effectiveForeground = foreground
            }
            if foreground, displayLink == nil {
                let link = CADisplayLink(target: displayLinkTarget, selector: #selector(WeappContainerDisplayLinkTarget.tick(_:)))
                link.preferredFramesPerSecond = 60
                link.add(to: .main, forMode: .common)
                displayLink = link
            }
            displayLink?.isPaused = !foreground
            if foreground { try presentIfNeeded() }
        } catch { fail(error) }
    }

    private func fail(_ error: Error) {
        guard !isClosed else { return }
        lastError = error
        // The session retains its contact for cancellation after a successful
        // retry; sending it now could target an unpresented runtime frame.
        trackedTouch = nil
        ignoringMultipleTouches = false
        if session.isFailed {
            displayLink?.isPaused = true
        } else if !session.isPresentationSuspended {
            do { try session.suspendPresentation(error) }
            catch { onError?(error) }
        }
        onError?(error)
    }

    public override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard acceptsInput else { return }
        if ignoringMultipleTouches { return }
        if trackedTouch != nil || touches.count != 1 || activeTouchCount(event) > 1 {
            do { try cancelTrackedTouch() } catch { fail(error) }
            ignoringMultipleTouches = true
            return
        }
        guard let touch = touches.first else { return }
        trackedTouch = touch
        trackedLocation = touch.location(in: self)
        dispatchPointer("down", touch: touch)
    }

    public override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard acceptsInput else {
            do { try cancelTrackedTouch() } catch { fail(error) }
            return
        }
        if activeTouchCount(event) > 1 {
            do { try cancelTrackedTouch() } catch { fail(error) }
            ignoringMultipleTouches = true
            return
        }
        guard !ignoringMultipleTouches, let touch = trackedTouch, touches.contains(touch) else { return }
        trackedLocation = touch.location(in: self)
        dispatchPointer("move", touch: touch)
    }

    public override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        defer { if activeTouchCount(event) == 0 { ignoringMultipleTouches = false } }
        guard let touch = trackedTouch, touches.contains(touch) else { return }
        guard acceptsInput, !ignoringMultipleTouches else {
            do { try cancelTrackedTouch() } catch { fail(error) }
            return
        }
        trackedLocation = touch.location(in: self)
        dispatchPointer("up", touch: touch)
        trackedTouch = nil
    }

    public override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        defer { if activeTouchCount(event) == 0 { ignoringMultipleTouches = false } }
        guard let touch = trackedTouch, touches.contains(touch) else { return }
        do { try cancelTrackedTouch() } catch { fail(error) }
    }

    private var acceptsInput: Bool {
        !isClosed && effectiveForeground && session.canAcceptInput
            && lastPresentedFrameID == session.frameID && presentedSurfaceEpoch == surfaceEpoch
            && bounds.width.isFinite && bounds.height.isFinite && bounds.width > 0 && bounds.height > 0
    }

    private func activeTouchCount(_ event: UIEvent?) -> Int {
        event?.allTouches?.filter { $0.phase != .ended && $0.phase != .cancelled }.count ?? 0
    }

    private func dispatchPointer(_ action: String, touch: UITouch) {
        do {
            let coordinate = logicalCoordinate(trackedLocation)
            _ = try session.pointer(action: action, id: 0, x: coordinate.x, y: coordinate.y,
                                    timeMs: Self.touchTimeMs(touch.timestamp), slop: coordinate.slop)
            try presentIfNeeded()
        } catch { fail(error) }
    }

    private func cancelTrackedTouch() throws {
        guard let touch = trackedTouch else { return }
        trackedTouch = nil
        let coordinate = logicalCoordinate(trackedLocation)
        _ = try session.pointer(action: "cancel", id: 0, x: coordinate.x, y: coordinate.y,
                                timeMs: Self.touchTimeMs(touch.timestamp), slop: coordinate.slop)
    }

    private func logicalCoordinate(_ point: CGPoint) -> (x: Double, y: Double, slop: Double) {
        let scaleX = session.viewportWidth / Double(max(1, bounds.width))
        let scaleY = session.viewportHeight / Double(max(1, bounds.height))
        return (Double(point.x) * scaleX, Double(point.y) * scaleY, 10 * max(scaleX, scaleY))
    }

    private static func touchTimeMs(_ timestamp: TimeInterval) -> UInt64 {
        let value = timestamp * 1_000
        guard value.isFinite, value > 0 else { return 0 }
        return value < Double(UInt64.max) ? UInt64(value) : UInt64.max
    }
}
#endif
