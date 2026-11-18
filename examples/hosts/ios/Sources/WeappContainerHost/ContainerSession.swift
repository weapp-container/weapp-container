import Foundation

/// Whole-session operations only. `pollTimers` takes Unix epoch nanoseconds,
/// matching the native runtime's Date.now()/system-clock timer deadlines.
public protocol WeappContainerSessionRuntime: WeappPortablePackRuntime {
    func pollTimers(nowNs: UInt64) -> (status: Int32, response: Data)
    func resize(width: UInt32, height: UInt32) -> (status: Int32, response: Data)
    func sessionState() -> (status: Int32, response: Data)
    @discardableResult func unload() -> Int32
}

/// Thread-affine owner of a running portable pack. UIKit and tests share this
/// lifecycle/input/pump implementation. Rendering always uses live page data
/// and the *current* route, including navigation performed by JS callbacks.
public final class WeappContainerSession {
    public let runtime: any WeappContainerSessionRuntime
    public let startup: WeappPortablePackStartup
    public private(set) var frameID: UInt64 = 1
    public private(set) var route: String
    public private(set) var viewportWidth: Double
    public private(set) var viewportHeight: Double
    public private(set) var isForeground = true
    public private(set) var isClosed = false
    /// Fatal runtime/protocol failures stop business scheduling. A failed
    /// presentation has its own state and does not imply an app hide.
    public private(set) var isFailed = false
    public private(set) var isPresentationSuspended = false
    public private(set) var diagnostics: [[String: Any]] = []
    public var canRun: Bool { !isClosed && !isFailed && isForeground }
    public var canAcceptInput: Bool { canRun && !isPresentationSuspended }
    public var canAutomaticallyRender: Bool { canRun && !isPresentationSuspended }
    /// Requests and responses are whole batches; no per-node native calls.
    public var onOperation: ((String, Data, Data) -> Void)?
    public var onDiagnostic: (([String: Any]) -> Void)?

    private let owner = Thread.current
    private let pack: WeappPortablePack
    private var renderedRevision: UInt64 = 0
    private var renderedPageID: UInt64?
    private var sequence: UInt64 = 0
    private var pointer: Contact?
    // Observers run only after the complete native transaction has settled.
    // A consumer may then close the session without invalidating an in-flight
    // event/render operation or causing another native call after unload.
    private var transactionDepth = 0
    private var deliveringNotifications = false
    private var notifications: [() -> Void] = []
    private struct Contact {
        let id: Int
        let x: Double
        let y: Double
        let timeMs: UInt64
        var lastX: Double
        var lastY: Double
        var lastTimeMs: UInt64
        var moved = false
    }

    public init(pack: WeappPortablePack, runtime: any WeappContainerSessionRuntime,
                engine: String = "quickjs", sessionID: String = "session-1",
                route: String? = nil, width: Double = 375, height: Double = 667) throws {
        let size = try Self.dimensions(width, height)
        self.pack = pack
        self.runtime = runtime
        self.viewportWidth = Double(size.0)
        self.viewportHeight = Double(size.1)
        do {
            startup = try pack.start(on: runtime, route: route, engine: engine, sessionID: sessionID,
                                     width: Double(size.0), height: Double(size.1))
        } catch {
            // An init/lifecycle hook may have failed after creating a native
            // session. Never leave that partially started engine pumping.
            _ = runtime.unload()
            throw error
        }
        self.route = startup.route
        func acknowledgement(_ operation: String) -> [String: Any] {
            guard let bytes = startup.operations[operation],
                  let batch = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
                  let messages = batch["messages"] as? [[String: Any]] else { return [:] }
            return messages.first { $0["kind"] as? String == "response" && $0["op"] as? String == operation }?["payload"] as? [String: Any] ?? [:]
        }
        renderedRevision = acknowledgement("render.commit")["revision"] as? UInt64 ?? 0
        renderedPageID = acknowledgement("page.push")["pageId"] as? UInt64
        diagnostics = startup.diagnostics
        if let error = startup.diagnostics.first(where: { $0["op"] as? String == "error" }) {
            _ = runtime.unload()
            let body = error["payload"] as? [String: Any] ?? [:]
            throw WeappPortablePackError("startup", body["code"] as? String ?? "ERR_ENGINE",
                                         body["message"] as? String ?? "post-publication runtime failure")
        }
    }

    /// An absolute clock is required: CADisplayLink.timestamp, uptime and a
    /// session-relative duration have different epochs and must not be used.
    public static func clockNowNs() -> UInt64 {
        let value = Date().timeIntervalSince1970 * 1_000_000_000
        if !value.isFinite || value <= 0 { return 0 }
        if value >= Double(UInt64.max) { return UInt64.max }
        return UInt64(value)
    }

    public func setForeground(_ visible: Bool) throws {
        try checkOwner()
        guard !isClosed, isForeground != visible else { return }
        // Consume a platform transition before running user hooks, so a
        // throwing onShow/onHide cannot cause an accidental replay.
        isForeground = visible
        guard !isFailed else { pointer = nil; return }
        try transaction {
            if !visible { try cancelPointerForHostTransition() }
            var payload: [String: Any] = ["event": visible ? "show" : "hide"]
            if visible { payload["options"] = ["path": route] }
            _ = try dispatch("app.lifecycle", payload)
            if visible, !isPresentationSuspended { try renderFrame() }
        }
    }

    @discardableResult
    public func resize(width: Double, height: Double) throws -> Bool {
        try checkOwner()
        let size = try Self.dimensions(width, height)
        guard !isClosed, !isFailed else { return false }
        guard Double(size.0) != viewportWidth || Double(size.1) != viewportHeight else { return false }
        return try transaction {
            try cancelPointerForHostTransition()
            let request = try JSONSerialization.data(withJSONObject: ["width": size.0, "height": size.1])
            let result = runtime.resize(width: size.0, height: size.1)
            notifyOperation("host.resize", request, result.response)
            _ = try validateBatch(result, phase: "host.resize")
            viewportWidth = Double(size.0)
            viewportHeight = Double(size.1)
            if !isPresentationSuspended { try renderFrame() }
            return true
        }
    }

    @discardableResult
    public func pollTimers(nowNs: UInt64) throws -> Bool {
        try checkOwner()
        guard canRun else { return false }
        return try transaction {
            let result = runtime.pollTimers(nowNs: nowNs)
            let messages = try validateBatch(result, phase: "host.pollTimers")
            if !messages.isEmpty {
                let request = try JSONSerialization.data(withJSONObject: ["nowNs": nowNs])
                notifyOperation("host.pollTimers", request, result.response)
            }
            // Surface failure suspends rendering/input, not AppService time.
            // Accumulated writes stay dirty until an explicit render retry.
            guard !isPresentationSuspended else { return false }
            // Ready/observer callbacks can leave live data dirty after the
            // preceding render, even if no timer fires in this tick.
            let state = try readRenderState()
            guard state.revision != renderedRevision || state.pageID != renderedPageID || state.route != route else { return false }
            try renderFrame(state: state)
            return true
        }
    }

    /// One contact is supported. Additional contacts cancel it explicitly.
    /// x/y and slop are logical view points; UIKit performs no native hit test.
    @discardableResult
    public func pointer(action: String, id: Int, x: Double, y: Double,
                        timeMs: UInt64, slop: Double = 10) throws -> Bool {
        try checkOwner()
        guard canAcceptInput else { return false }
        guard x.isFinite, y.isFinite, slop.isFinite, slop >= 0 else {
            throw WeappPortablePackError("input", "ERR_INVALID_REQUEST", "non-finite input geometry")
        }
        var events: [[String: Any]] = []
        func event(_ type: String, _ contact: Contact, _ active: Bool, _ px: Double, _ py: Double) -> [String: Any] {
            pointerEvent(type, contact: contact, active: active, x: px, y: py, timeMs: timeMs)
        }
        switch action {
        case "down":
            guard pointer == nil, x >= 0, y >= 0, x < viewportWidth, y < viewportHeight else { return false }
            let contact = Contact(id: id, x: x, y: y, timeMs: timeMs, lastX: x, lastY: y, lastTimeMs: timeMs)
            pointer = contact
            events.append(event("touchstart", contact, true, x, y))
        case "move", "up":
            guard var contact = pointer, contact.id == id else { return false }
            contact.moved = contact.moved || hypot(x - contact.x, y - contact.y) > slop
            contact.lastX = x; contact.lastY = y
            contact.lastTimeMs = timeMs
            pointer = action == "up" ? nil : contact
            events.append(event(action == "up" ? "touchend" : "touchmove", contact, action != "up", x, y))
            if action == "up", !contact.moved, timeMs >= contact.timeMs, timeMs - contact.timeMs <= 500,
               x >= 0, y >= 0, x < viewportWidth, y < viewportHeight {
                events.append(event("tap", contact, false, x, y))
            }
        case "cancel", "multiple":
            guard let contact = pointer else { return false }
            pointer = nil
            events.append(event("touchcancel", contact, false, contact.lastX, contact.lastY))
        default:
            throw WeappPortablePackError("input", "ERR_INVALID_REQUEST", "unsupported pointer action: \(action)")
        }
        return try transaction {
            _ = try dispatch("event.batch", ["events": events])
            try renderFrame()
            return true
        }
    }

    /// Explicit retry of the latest live route/data. Only the surface owner's
    /// successful presentation may resume input and automatic rendering.
    @discardableResult
    public func render() throws -> Bool {
        try checkOwner()
        guard canRun else { return false }
        return try transaction {
            try renderFrame()
            return true
        }
    }

    /// Retain the last accepted frame and running AppService after a surface
    /// fault. A contact is retained only to send one cancel after recovery;
    /// events cannot be sent against an unpresented runtime topology.
    public func suspendPresentation(_ error: Error) throws {
        try checkOwner()
        guard !isClosed, !isFailed else { return }
        isPresentationSuspended = true
        recordFailure(error, presentation: true)
        deliverNotifications()
    }

    public func resumePresentation() throws {
        try checkOwner()
        guard canRun, isPresentationSuspended else { return }
        try transaction {
            try cancelPointer()
            isPresentationSuspended = false
        }
    }

    /// Preserve the complete ready/observer acknowledgement in the same
    /// diagnostic/operation stream as normal bridge calls. Presentation is
    /// already submitted: callback errors cannot roll its identity back.
    public func consumePresentationAcknowledgement(
        _ result: (status: Int32, response: Data), revision: UInt64
    ) throws {
        try checkOwner()
        guard !isClosed, !isFailed else { return }
        try transaction {
            let request = try JSONSerialization.data(withJSONObject: ["revision": revision])
            notifyOperation("view.presented", request, result.response)
            _ = try validateBatch(result, phase: "view.presented")
        }
    }

    /// Ends a host-owned contact before visibility, geometry or native lifetime
    /// changes. Consume it before dispatch, including when its listener fails.
    /// No intermediate frame is painted during the surrounding transition.
    private func cancelPointer() throws {
        guard let contact = pointer else { return }
        pointer = nil
        let event = pointerEvent("touchcancel", contact: contact, active: false,
                                 x: contact.lastX, y: contact.lastY, timeMs: contact.lastTimeMs)
        _ = try dispatch("event.batch", ["events": [event]])
    }

    private func cancelPointerForHostTransition() throws {
        if isPresentationSuspended {
            // Native resize/hide/unload cancels its captured route internally.
            // Do not prepend host input against an unpresented frame and
            // accidentally prevent the real lifecycle transition from running.
            pointer = nil
        } else {
            try cancelPointer()
        }
    }

    private func pointerEvent(_ type: String, contact: Contact, active: Bool,
                              x: Double, y: Double, timeMs: UInt64) -> [String: Any] {
        let touch: [String: Any] = ["identifier": contact.id, "clientX": x, "clientY": y, "pageX": x, "pageY": y]
        return ["type": type, "x": x, "y": y, "timeStamp": timeMs, "bubbles": true,
                "detail": type == "tap" ? ["x": x, "y": y] : [:],
                "touches": active ? [touch] : [], "changedTouches": [touch]]
    }

    /// The surface owner must drain/detach Metal before calling close. Even a
    /// throwing unload hook cannot prevent native timers/providers releasing.
    public func close() throws {
        try checkOwner()
        guard !isClosed else { return }
        isClosed = true
        isForeground = false
        try transaction {
            var failure: Error?
            do { try cancelPointerForHostTransition() } catch { failure = error }
            do { _ = try dispatch("app.lifecycle", ["event": "unload"]) }
            catch { if failure == nil { failure = error } }
            let status = runtime.unload()
            if let failure { throw failure }
            if status != 0 { throw WeappPortablePackError("unload", "ERR_ENGINE", "native unload status \(status)") }
        }
    }

    private static func dimensions(_ width: Double, _ height: Double) throws -> (UInt32, UInt32) {
        guard width.isFinite, height.isFinite, width >= 1, height >= 1,
              width.rounded() <= Double(UInt32.max), height.rounded() <= Double(UInt32.max) else {
            throw WeappPortablePackError("viewport", "ERR_RENDER", "viewport must have positive UInt32 dimensions")
        }
        return (UInt32(width.rounded()), UInt32(height.rounded()))
    }

    private func checkOwner() throws {
        guard Thread.current === owner else {
            throw WeappPortablePackError("thread", "ERR_ENGINE", "session must stay on its creating thread")
        }
    }

    private func transaction<T>(_ body: () throws -> T) throws -> T {
        transactionDepth += 1
        defer {
            transactionDepth -= 1
            deliverNotifications()
        }
        do { return try body() }
        catch {
            if Self.isPresentationError(error) {
                isPresentationSuspended = true
            } else {
                isFailed = true
                pointer = nil
            }
            recordFailure(error)
            throw error
        }
    }

    private static func isPresentationError(_ error: Error) -> Bool {
        guard let failure = error as? WeappPortablePackError else { return false }
        return failure.code == "ERR_RENDER"
            || (failure.phase == "view.presented" && failure.code == "ERR_CANCELLED")
    }

    private func recordFailure(_ error: Error, presentation: Bool = false) {
        let failure = error as? WeappPortablePackError
        let diagnostic = failure?.jsonObject ?? ["phase": presentation ? "presentation" : "session",
            "code": presentation ? "ERR_RENDER" : "ERR_ENGINE", "message": String(describing: error)]
        diagnostics.append(diagnostic)
        if diagnostics.count > 64 { diagnostics.removeFirst(diagnostics.count - 64) }
        notifyDiagnostic(diagnostic)
    }

    private func notifyOperation(_ name: String, _ request: Data, _ response: Data) {
        guard let callback = onOperation else { return }
        notifications.append { callback(name, request, response) }
    }

    private func notifyDiagnostic(_ diagnostic: [String: Any]) {
        guard let callback = onDiagnostic else { return }
        notifications.append { callback(diagnostic) }
    }

    private func deliverNotifications() {
        guard transactionDepth == 0, !deliveringNotifications else { return }
        deliveringNotifications = true
        defer { deliveringNotifications = false }
        // Reentrant observers append to a later batch; none run inside native
        // dispatch/validation. close() is idempotent even from its own receipt.
        while !notifications.isEmpty {
            let batch = notifications
            notifications.removeAll(keepingCapacity: true)
            for callback in batch { callback() }
        }
    }

    private func decodeBatch(_ result: (status: Int32, response: Data), phase: String) throws -> [[String: Any]] {
        guard let batch = try? JSONSerialization.jsonObject(with: result.response) as? [String: Any],
              let messages = batch["messages"] as? [[String: Any]] else {
            throw WeappPortablePackError(phase, "ERR_ENGINE", "missing bridge batch (ABI status \(result.status))")
        }
        for message in messages {
            guard message["sessionId"] as? String == startup.sessionID,
                  message["protocolVersion"] as? String == "1.0" else {
                throw WeappPortablePackError(phase, "ERR_ENGINE", "batch session/protocol mismatch")
            }
        }
        guard result.status == 0 else { throw WeappPortablePackError(phase, "ERR_ENGINE", "ABI status \(result.status)") }
        return messages
    }

    private func checkBatchErrors(_ messages: [[String: Any]], phase: String) throws {
        var failure: WeappPortablePackError?
        for message in messages {
            let body = message["payload"] as? [String: Any] ?? [:]
            if message["op"] as? String == "diagnostic" || message["op"] as? String == "error" {
                diagnostics.append(message)
                if diagnostics.count > 64 { diagnostics.removeFirst() }
                notifyDiagnostic(message)
            }
            if message["op"] as? String == "error" || body["ok"] as? Bool == false {
                let error = body["error"] as? [String: Any] ?? body
                let candidate = WeappPortablePackError(phase, error["code"] as? String ?? "ERR_ENGINE",
                                                       error["message"] as? String ?? "runtime rejected operation")
                if failure == nil || (Self.isPresentationError(failure!) && !Self.isPresentationError(candidate)) {
                    failure = candidate
                }
            }
        }
        if let failure { throw failure }
    }

    private func validateBatch(_ result: (status: Int32, response: Data), phase: String) throws -> [[String: Any]] {
        let messages = try decodeBatch(result, phase: phase)
        try checkBatchErrors(messages, phase: phase)
        return messages
    }

    private func dispatch(_ operation: String, _ payload: [String: Any],
                          acknowledged: (([String: Any]) throws -> Void)? = nil) throws -> [String: Any] {
        guard sequence < UInt64.max else { throw WeappPortablePackError(operation, "ERR_ENGINE", "request sequence exhausted") }
        sequence += 1
        let requestID = "ios-session-\(sequence)"
        let request = try JSONSerialization.data(withJSONObject: ["protocolVersion": "1.0", "sessionId": startup.sessionID,
            "requestId": requestID, "kind": "request", "op": operation, "payload": payload], options: [.sortedKeys])
        let result = runtime.dispatch(request)
        notifyOperation(operation, request, result.response)
        let messages = try decodeBatch(result, phase: operation)
        let replies = messages.filter { $0["kind"] as? String == "response" && $0["op"] as? String == operation && $0["requestId"] as? String == requestID }
        guard replies.count == 1, let body = replies.first?["payload"] as? [String: Any], body["ok"] as? Bool == true else {
            try checkBatchErrors(messages, phase: operation)
            throw WeappPortablePackError(operation, "ERR_ENGINE", "missing or ambiguous correlated acknowledgement")
        }
        // A render acknowledgement is authoritative even when onReady or an
        // observer throws *after* publication. Record its accepted metadata
        // before delivering those errors and stopping the event pump.
        try acknowledged?(body)
        try checkBatchErrors(messages, phase: operation)
        return body
    }

    private struct RenderState {
        let route: String
        let pageID: UInt64
        let frameID: UInt64
        let revision: UInt64
    }

    private func readRenderState() throws -> RenderState {
        let state = runtime.sessionState()
        guard state.status == 0, let object = try? JSONSerialization.jsonObject(with: state.response) as? [String: Any],
              object["schemaVersion"] as? Int == 1, object["sessionId"] as? String == startup.sessionID,
              let page = object["page"] as? [String: Any], let currentRoute = page["route"] as? String,
              let pageID = page["id"] as? UInt64, let revision = object["viewRevision"] as? UInt64,
              let nativeFrame = object["frameId"] as? UInt64 else {
            throw WeappPortablePackError("host.state", "ERR_ENGINE", "missing current route/frame metadata")
        }
        return RenderState(route: currentRoute, pageID: pageID, frameID: nativeFrame, revision: revision)
    }

    private func renderFrame(state supplied: RenderState? = nil) throws {
        let state = try supplied ?? readRenderState()
        let currentRoute = state.route
        let template = "template:" + currentRoute + ".wxml"
        guard let templates = pack.manifest["templates"] as? [[String: Any]], templates.contains(where: { $0["id"] as? String == template }) else {
            throw WeappPortablePackError("render.commit", "ERR_INVALID_MANIFEST", "current route has no template: \(currentRoute)")
        }
        let previous = max(frameID, state.frameID)
        guard previous < UInt64.max else { throw WeappPortablePackError("render.commit", "ERR_RENDER", "frame ID exhausted") }
        let candidate = previous + 1
        let styles = try pack.styleIDs(forRoute: currentRoute)
        _ = try dispatch("render.commit", ["frameId": candidate, "templateId": template, "styleIds": styles,
            "useSessionResources": true,
            "viewport": ["x": 0, "y": 0, "width": viewportWidth, "height": viewportHeight]], acknowledged: { body in
                guard body["committed"] as? Bool == true, body["source"] as? String == "manifest",
                      body["templateId"] as? String == template, body["frameId"] as? UInt64 == candidate else {
                    throw WeappPortablePackError("render.commit", "ERR_RENDER", "runtime did not publish requested current-route frame")
                }
                self.frameID = candidate
                self.route = currentRoute
                self.renderedRevision = state.revision
                self.renderedPageID = state.pageID
            })
    }
}
