import Foundation
import CryptoKit

private enum Failure: Error { case assertion(String) }
private func expect(_ value: @autoclosure () throws -> Bool, _ message: String) throws {
    if try !value() { throw Failure.assertion(message) }
}

/// Records the actual portable-pack startup and subsequent complete session
/// operations. This verifies the Swift boundary, not native engine execution.
private final class Runtime: WeappContainerSessionRuntime {
    var sessionID = ""
    var engine = ""
    var manifest: [String: Any] = [:]
    var requests: [[String: Any]] = []
    var polls: [UInt64] = []
    var sizes: [[UInt32]] = []
    var unloads = 0
    var frame: UInt64 = 0
    var pageID: UInt64 = 0
    var revision: UInt64 = 0
    var stateReads = 0
    var route = ""
    var mode = "success"
    var dueNs: UInt64?
    var dirtyAfterNextRender = false
    var nativeCalls: [String] = []

    func loadManifest(_ bytes: Data) -> Int32 { -2 }
    func loadManifest(_ bytes: Data, engine: String, sessionID: String, width: Double, height: Double) -> Int32 {
        self.engine = engine; self.sessionID = sessionID
        manifest = try! JSONSerialization.jsonObject(with: bytes) as! [String: Any]
        return 0
    }
    func batch(_ messages: [[String: Any]]) -> (status: Int32, response: Data) {
        (0, try! JSONSerialization.data(withJSONObject: ["messages": messages]))
    }
    func event(_ op: String, _ payload: [String: Any]) -> [String: Any] {
        ["protocolVersion": "1.0", "sessionId": sessionID, "requestId": "host-event", "kind": "event", "op": op, "payload": payload]
    }
    func dispatch(_ bytes: Data) -> (status: Int32, response: Data) {
        let request = try! JSONSerialization.jsonObject(with: bytes) as! [String: Any]
        requests.append(request)
        let op = request["op"] as! String
        nativeCalls.append(op)
        let input = request["payload"] as! [String: Any]
        var payload: [String: Any] = ["ok": true]
        if op == "app.init" {
            payload["engineProviderAvailable"] = true
            payload["engine"] = engine
            payload["loadedModules"] = (manifest["modules"] as! [Any]).count
            payload["manifest"] = ["integrity": (manifest["integrity"] as! [String: Any])["root"]!]
        }
        if op == "page.push" {
            route = input["path"] as! String
            pageID += 1
            revision += 1
            payload["pageId"] = pageID
        }
        if op == "render.commit" {
            let candidate = (input["frameId"] as! NSNumber).uint64Value
            payload["frameId"] = candidate
            payload["source"] = "manifest"
            payload["templateId"] = input["templateId"]
            payload["committed"] = mode != "reject-frame"
            payload["revision"] = revision
            if mode != "reject-frame" { frame = candidate }
            // Model native ready/observer effects *after* frame publication.
            // No JS/data behavior is executed by this recording runtime.
            if dirtyAfterNextRender {
                dirtyAfterNextRender = false
                revision += 1
            }
        }
        if mode == "hook-error", op == "app.lifecycle" {
            payload = ["ok": false, "error": ["code": "ERR_ENGINE", "message": "hook threw"]]
        }
        if mode == "cancel-error", op == "event.batch",
           (input["events"] as? [[String: Any]])?.first?["type"] as? String == "touchcancel" {
            payload = ["ok": false, "error": ["code": "ERR_ENGINE", "message": "cancel listener threw"]]
        }
        var response = request
        response["kind"] = "response"
        response["payload"] = payload
        if mode == "wrong-id" { response["requestId"] = "unrelated" }
        if mode == "wrong-session" { response["sessionId"] = "unrelated" }
        if mode == "wrong-protocol" { response["protocolVersion"] = "99.0" }
        var messages = [response]
        if mode == "duplicate" { messages.append(response) }
        if mode == "sibling-error" {
            messages.append(event("error", ["code": "ERR_TIMEOUT", "message": "callback deadline", "committed": true, "frameId": frame]))
        }
        return batch(messages)
    }
    func pollTimers(nowNs: UInt64) -> (status: Int32, response: Data) {
        polls.append(nowNs)
        if mode == "bad-poll" { return (-1, Data("not-json".utf8)) }
        guard let dueNs, nowNs >= dueNs else { return batch([]) }
        self.dueNs = nil
        if mode != "timer-without-view-change" { revision += 1 }
        return batch([event("event.batch", ["timers": ["fired"]])])
    }
    func resize(width: UInt32, height: UInt32) -> (status: Int32, response: Data) {
        nativeCalls.append("host.resize")
        sizes.append([width, height])
        return batch([event("diagnostic", ["source": "host", "type": "host.resize"])])
    }
    func sessionState() -> (status: Int32, response: Data) {
        stateReads += 1
        let value: [String: Any] = ["schemaVersion": 1, "sessionId": sessionID,
            "page": ["id": pageID, "route": route], "frameId": frame, "viewRevision": revision]
        return (0, try! JSONSerialization.data(withJSONObject: value))
    }
    func unload() -> Int32 { nativeCalls.append("native.unload"); unloads += 1; return 0 }
}

@main
private struct SessionTests {
    static func main() throws {
        let pack = try WeappPortablePack(directory: URL(fileURLWithPath: CommandLine.arguments[1]))
        var passed = 0
        func test(_ name: String, _ body: () throws -> Void) throws {
            try body(); passed += 1; print("PASS \(name)")
        }
        func make(_ configure: ((Runtime) -> Void)? = nil) throws -> (Runtime, WeappContainerSession) {
            let runtime = Runtime()
            configure?(runtime)
            return (runtime, try WeappContainerSession(pack: pack, runtime: runtime, sessionID: "ios-session-test"))
        }
        func requireError(_ code: String, _ body: () throws -> Void) throws {
            do { try body(); throw Failure.assertion("expected \(code)") }
            catch let error as WeappPortablePackError { try expect(error.code == code, "unexpected \(error)") }
        }
        func types(_ runtime: Runtime) -> [String] {
            runtime.requests.filter { $0["op"] as? String == "event.batch" }.flatMap {
                (($0["payload"] as! [String: Any])["events"] as! [[String: Any]]).map { $0["type"] as! String }
            }
        }
        try test("takes ownership of real portable-pack startup without replaying onShow") {
            let (runtime, session) = try make()
            try expect(runtime.requests.count == 4 && session.frameID == 1, "checked startup")
            try session.setForeground(true)
            try expect(runtime.requests.count == 4, "no duplicate show")
            try expect(session.canRun && session.route == pack.manifest["routes"].flatMap { ($0 as? [[String: Any]])?.first?["path"] as? String }, "active route")
            try session.close()
        }
        try test("idle pump reads compact dirty metadata without rendering or emitting receipts") {
            let (runtime, session) = try make()
            var receipts = 0
            session.onOperation = { _, _, _ in receipts += 1 }
            for index in 1...60 { try expect(try session.pollTimers(nowNs: UInt64(index)) == false, "empty tick") }
            try expect(receipts == 0 && runtime.requests.count == 4 && session.frameID == 1, "idle work elided")
            try expect(runtime.stateReads == 60, "empty batches still read page identity/revision")
            try session.close()
        }
        try test("epoch timer deadline fires once and rendering leaves data ownership with runtime") {
            let (runtime, session) = try make()
            let due = WeappContainerSession.clockNowNs()
            try expect(due > 1_600_000_000_000_000_000, "Unix epoch nanoseconds")
            runtime.dueNs = due
            try expect(try session.pollTimers(nowNs: due - 1) == false, "not early")
            try expect(try session.pollTimers(nowNs: due) == true, "due callback")
            try expect(try session.pollTimers(nowNs: due + 1) == false, "not repeated")
            let render = runtime.requests.last!["payload"] as! [String: Any]
            try expect(render["data"] == nil && render["root"] == nil && render["blobs"] == nil, "wrapper must not replace native data or supply inline nodes")
            try expect(render["useSessionResources"] as? Bool == true, "resource reuse is an explicit native protocol request")
            try expect(session.frameID == 2, "one committed change")
            try session.close()
        }
        try test("empty timer batch repairs post-startup dirty revision once") {
            let (runtime, session) = try make { $0.dirtyAfterNextRender = true }
            try expect(runtime.revision == 2 && session.frameID == 1, "startup publication consumed the earlier revision")
            try expect(try session.pollTimers(nowNs: 1), "dirty revision is visible without a timer message")
            try expect(runtime.polls == [1] && session.frameID == 2, "one complete follow-up publication")
            let renders = runtime.requests.filter { $0["op"] as? String == "render.commit" }
            try expect(renders.count == 2, "exactly one redraw after startup")
            try expect(try !session.pollTimers(nowNs: 2), "revision consumed; following empty tick is idle")
            try expect(runtime.requests.filter { $0["op"] as? String == "render.commit" }.count == 2, "no redraw loop")
            try session.close()
        }
        try test("empty timer batch distinguishes a new page instance with the same route and revision") {
            let (runtime, session) = try make()
            let route = runtime.route, revision = runtime.revision
            runtime.pageID += 1
            try expect(try session.pollTimers(nowNs: 1), "same-route page instance needs its own frame")
            try expect(session.route == route && runtime.revision == revision && session.frameID == 2, "page identity drives render without fabricated data change")
            try expect(try !session.pollTimers(nowNs: 2), "new identity consumed once")
            try session.close()
        }
        try test("post-publication effects require a later redraw even when its timer batch is empty") {
            let (runtime, session) = try make()
            runtime.dirtyAfterNextRender = true
            _ = try session.resize(width: 400, height: 800)
            try expect(session.frameID == 2, "first frame accepted before callback effects")
            try expect(try session.pollTimers(nowNs: 1), "ready/observer revision left dirty by preceding render")
            try expect(session.frameID == 3, "second frame consumes callback writes")
            try expect(try !session.pollTimers(nowNs: 2), "settled state is idle")
            try session.close()
        }
        try test("a timer message without a View change does not manufacture a new frame") {
            let (runtime, session) = try make()
            var operations: [String] = []
            session.onOperation = { name, _, _ in operations.append(name) }
            runtime.mode = "timer-without-view-change"
            runtime.dueNs = 1
            try expect(try !session.pollTimers(nowNs: 1), "timer callback alone is not a rendering change")
            try expect(operations == ["host.pollTimers"] && session.frameID == 1, "retain callback receipt but no redundant render")
            try session.close()
        }
        try test("hide/show are consumed once and background input/pump is suppressed") {
            let (runtime, session) = try make()
            try session.setForeground(false); try session.setForeground(false)
            try expect(try session.pollTimers(nowNs: .max) == false, "background tick")
            try expect(try session.pointer(action: "down", id: 1, x: 2, y: 3, timeMs: 1) == false, "background touch")
            try expect(runtime.polls.isEmpty, "no hidden timer execution")
            try session.setForeground(true); try session.setForeground(true)
            let events = runtime.requests.filter { $0["op"] as? String == "app.lifecycle" }.map { ($0["payload"] as! [String: Any])["event"] as! String }
            try expect(events == ["launch", "hide", "show"], "lifecycle ordering")
            try session.close()
        }
        try test("resize uses logical points, preserves native session and suppresses duplicates") {
            let (runtime, session) = try make()
            try expect(try session.resize(width: 390.1, height: 844.1), "changed size")
            try expect(try !session.resize(width: 390, height: 844), "same logical size")
            try expect(runtime.sizes == [[390, 844]] && runtime.unloads == 0, "no session restart")
            let viewport = (runtime.requests.last!["payload"] as! [String: Any])["viewport"] as! [String: Any]
            try expect(viewport["width"] as? Double == 390 && viewport["height"] as? Double == 844, "matching render geometry")
            try session.close()
        }
        try test("invalid resize rejected before native mutation") {
            let (runtime, session) = try make()
            for width in [0, -1, Double.infinity, Double.nan, Double(UInt32.max) + 1] {
                try requireError("ERR_RENDER") { _ = try session.resize(width: width, height: 100) }
            }
            try expect(runtime.sizes.isEmpty && session.canRun, "invalid caller geometry is not native failure")
            try session.close()
        }
        try test("tap dispatches touchend and tap in one batch with native hit-test coordinates") {
            let (runtime, session) = try make()
            _ = try session.pointer(action: "down", id: 42, x: 12.5, y: 20, timeMs: 100)
            _ = try session.pointer(action: "up", id: 42, x: 13, y: 21, timeMs: 200)
            try expect(types(runtime) == ["touchstart", "touchend", "tap"], "touch/tap ordering")
            let batches = runtime.requests.filter { $0["op"] as? String == "event.batch" }
            let events = (batches.last!["payload"] as! [String: Any])["events"] as! [[String: Any]]
            try expect(events.count == 2 && events[0]["target"] == nil, "one complete batch, native target")
            let touch = (events[0]["changedTouches"] as! [[String: Any]])[0]
            try expect(touch["identifier"] as? Int == 42 && touch["pageX"] as? Double == 13, "contact data")
            try expect((events[0]["touches"] as! [Any]).isEmpty, "released contact not active")
            try session.close()
        }
        try test("movement, long press and backwards timestamps never synthesize tap") {
            for (move, upTime) in [(true, UInt64(200)), (false, UInt64(601)), (false, UInt64(1))] {
                let (runtime, session) = try make()
                _ = try session.pointer(action: "down", id: 1, x: 10, y: 10, timeMs: 100)
                if move { _ = try session.pointer(action: "move", id: 1, x: 50, y: 10, timeMs: 150) }
                _ = try session.pointer(action: "up", id: 1, x: 10, y: 10, timeMs: upTime)
                try expect(!types(runtime).contains("tap"), "no accidental tap")
                try session.close()
            }
        }
        try test("multiple contacts cancel once and stale ups cannot tap") {
            let (runtime, session) = try make()
            _ = try session.pointer(action: "down", id: 1, x: 10, y: 10, timeMs: 100)
            _ = try session.pointer(action: "multiple", id: 2, x: 0, y: 0, timeMs: 110)
            _ = try session.pointer(action: "cancel", id: 1, x: 0, y: 0, timeMs: 111)
            _ = try session.pointer(action: "up", id: 1, x: 10, y: 10, timeMs: 120)
            try expect(types(runtime) == ["touchstart", "touchcancel"], "one cancel")
            try session.close()
        }
        try test("unknown pointer and non-finite coordinates fail without dispatch") {
            let (runtime, session) = try make()
            try requireError("ERR_INVALID_REQUEST") { _ = try session.pointer(action: "hover", id: 1, x: 2, y: 3, timeMs: 0) }
            try requireError("ERR_INVALID_REQUEST") { _ = try session.pointer(action: "down", id: 1, x: .nan, y: 3, timeMs: 0) }
            try expect(runtime.requests.count == 4, "caller input not dispatched")
            try session.close()
        }
        try test("host changes cannot reuse a stale gesture") {
            let (runtime, session) = try make()
            _ = try session.pointer(action: "down", id: 1, x: 10, y: 10, timeMs: 100)
            _ = try session.resize(width: 400, height: 800)
            _ = try session.pointer(action: "up", id: 1, x: 10, y: 10, timeMs: 150)
            try expect(types(runtime) == ["touchstart", "touchcancel"], "resize ends original contact exactly once")
            try session.close()
        }
        try test("direct session visibility and close cancel before lifecycle and native teardown") {
            for transition in ["hide", "close"] {
                let (runtime, session) = try make()
                _ = try session.pointer(action: "down", id: 7, x: 10, y: 20, timeMs: 100)
                _ = try session.pointer(action: "move", id: 7, x: 12, y: 22, timeMs: 125)
                let offset = runtime.requests.count
                if transition == "hide" { try session.setForeground(false) }
                else { try session.close() }
                let tail = Array(runtime.requests.dropFirst(offset))
                try expect(tail.map { $0["op"] as! String } == ["event.batch", "app.lifecycle"], "cancel precedes \(transition) without an intermediate render")
                let events = (tail[0]["payload"] as! [String: Any])["events"] as! [[String: Any]]
                try expect(events.count == 1 && events[0]["type"] as? String == "touchcancel", "one terminal event")
                let contact = (events[0]["changedTouches"] as! [[String: Any]])[0]
                try expect(contact["identifier"] as? Int == 7 && contact["pageX"] as? Double == 12 && events[0]["timeStamp"] as? Int == 125, "last contact coordinates and clock retained")
                if transition == "hide" { try session.setForeground(true) }
                _ = try session.pointer(action: "up", id: 7, x: 12, y: 22, timeMs: 130)
                try expect(types(runtime) == ["touchstart", "touchmove", "touchcancel"], "stale up cannot terminate twice or tap")
                try session.close()
                try expect(runtime.unloads == 1, "one native release")
            }
        }
        try test("native resize is preceded by cancel and followed by one new geometry frame") {
            let (runtime, session) = try make()
            _ = try session.pointer(action: "down", id: 1, x: 10, y: 10, timeMs: 100)
            let offset = runtime.nativeCalls.count
            _ = try session.resize(width: 400, height: 800)
            try expect(Array(runtime.nativeCalls.dropFirst(offset)) == ["event.batch", "host.resize", "render.commit"], "no old-coordinate gesture survives host geometry mutation")
            try session.close()
        }
        try test("cancel listener failure does not skip lifecycle unload or native release") {
            let (runtime, session) = try make()
            _ = try session.pointer(action: "down", id: 1, x: 10, y: 10, timeMs: 100)
            runtime.mode = "cancel-error"
            try requireError("ERR_ENGINE") { try session.close() }
            try expect(Array(runtime.nativeCalls.suffix(3)) == ["event.batch", "app.lifecycle", "native.unload"], "teardown continues after cancel exception")
            try session.close()
            try expect(session.isClosed && runtime.unloads == 1, "idempotent release after error")
        }
        try test("operation observer can close only after event and render transaction has settled") {
            let (runtime, session) = try make()
            var closeError: Error?
            var observedAcceptedFrame: UInt64?
            session.onOperation = { name, _, _ in
                if name == "event.batch" {
                    observedAcceptedFrame = session.frameID
                    do { try session.close() } catch { closeError = error }
                }
            }
            _ = try session.pointer(action: "down", id: 1, x: 10, y: 10, timeMs: 100)
            try expect(closeError == nil && session.isClosed && !session.isFailed, "observer close is not an in-flight runtime failure")
            try expect(observedAcceptedFrame == 2 && runtime.unloads == 1, "observer sees complete publication")
            try expect(runtime.nativeCalls.last == "native.unload", "no render or state access after unload")
        }
        try test("native auto-publication cannot cause frame ID reuse") {
            let (runtime, session) = try make()
            runtime.frame = 50; runtime.dueNs = 1
            _ = try session.pollTimers(nowNs: 1)
            try expect(session.frameID == 51, "continue from actual accepted runtime frame")
            try session.close()
        }
        try test("missing current-route template fails rather than painting old page") {
            let (runtime, session) = try make()
            runtime.route = "pages/not-in-pack/index"; runtime.dueNs = 1
            try requireError("ERR_INVALID_MANIFEST") { _ = try session.pollTimers(nowNs: 1) }
            try expect(session.isFailed && session.frameID == 1 && runtime.requests.count == 4, "last accepted frame retained")
            try session.close()
        }
        try test("invalid protocol acknowledgement stops runtime without accepting uncorrelated publication") {
            for (mode, code) in [("wrong-id", "ERR_ENGINE"), ("wrong-session", "ERR_ENGINE"), ("wrong-protocol", "ERR_ENGINE"), ("duplicate", "ERR_ENGINE")] {
                let (runtime, session) = try make()
                runtime.mode = mode; runtime.dueNs = 1
                try requireError(code) { _ = try session.pollTimers(nowNs: 1) }
                let count = runtime.requests.count
                try expect(try session.pollTimers(nowNs: 2) == false, "failed session doesn't pump")
                try expect(session.isFailed && session.frameID == 1 && count == runtime.requests.count, "unvalidated publication cannot update Swift evidence identity")
                runtime.mode = "success"; try session.close()
            }
        }
        try test("rejected frame suspends input and automatic redraw while business timers continue") {
            let (runtime, session) = try make()
            runtime.mode = "reject-frame"; runtime.dueNs = 1
            try requireError("ERR_RENDER") { _ = try session.pollTimers(nowNs: 1) }
            try expect(!session.isFailed && session.isPresentationSuspended && session.canRun, "surface failure is recoverable")
            try expect(!session.canAcceptInput && !session.canAutomaticallyRender && session.frameID == 1, "old frame retained with input blocked")
            let requests = runtime.requests.count
            runtime.dueNs = 2
            try expect(try !session.pollTimers(nowNs: 2), "timer callback does not automatically retry rejected frame")
            try expect(runtime.polls == [1, 2] && runtime.requests.count == requests, "business polling continues without rendering")
            try expect(try !session.pointer(action: "down", id: 1, x: 1, y: 1, timeMs: 1), "input remains blocked")
            runtime.mode = "success"
            try expect(try session.render(), "explicit retry compiles latest live state")
            try expect(session.frameID == 2 && session.isPresentationSuspended, "commit alone does not confirm a surface")
            try session.resumePresentation()
            try expect(session.canAcceptInput && session.canAutomaticallyRender, "accepted presentation restores surface work")
            try expect(try !session.pollTimers(nowNs: 3), "retry consumed all accumulated changes")
            try session.close()
        }
        try test("native presenter failure does not send hide and defers contact cancellation until recovery") {
            let (runtime, session) = try make()
            _ = try session.pointer(action: "down", id: 7, x: 10, y: 20, timeMs: 1)
            let count = runtime.requests.count
            try session.suspendPresentation(Failure.assertion("Metal submission failed"))
            try expect(session.isForeground && !session.isFailed && runtime.requests.count == count, "no lifecycle transition or stale-topology dispatch")
            runtime.dueNs = 2
            try expect(try !session.pollTimers(nowNs: 2), "no automatic render during suspension")
            _ = try session.render()
            try session.resumePresentation()
            try session.resumePresentation()
            try expect(types(runtime) == ["touchstart", "touchcancel"], "one terminal cancel after geometry becomes available")
            try expect(try !session.pointer(action: "up", id: 7, x: 10, y: 20, timeMs: 3), "old up cannot tap")
            try session.close()
        }
        try test("resize and foreground transitions cannot silently recover suspended rendering") {
            let (runtime, session) = try make()
            try session.suspendPresentation(Failure.assertion("surface failed"))
            _ = try session.resize(width: 400, height: 800)
            try session.setForeground(false)
            try expect(try !session.pollTimers(nowNs: 1), "background still suppresses business timers")
            try session.setForeground(true)
            _ = try session.pollTimers(nowNs: 2)
            try expect(runtime.polls == [2] && runtime.sizes == [[400, 800]], "real activity and geometry still update")
            try expect(runtime.requests.filter { $0["op"] as? String == "render.commit" }.count == 1, "only explicit retry may render")
            try expect(session.isPresentationSuspended && session.frameID == 1, "suspension survives resize/show")
            try session.close()
        }
        try test("suspended contact cannot block native resize or hide with stale input") {
            for transition in ["resize", "hide"] {
                let (runtime, session) = try make()
                _ = try session.pointer(action: "down", id: 1, x: 10, y: 10, timeMs: 1)
                try session.suspendPresentation(Failure.assertion("surface failed"))
                let offset = runtime.nativeCalls.count
                if transition == "resize" { _ = try session.resize(width: 400, height: 800) }
                else { try session.setForeground(false) }
                try expect(Array(runtime.nativeCalls.dropFirst(offset)) == [transition == "resize" ? "host.resize" : "app.lifecycle"], "native lifecycle owns suspended-route cancellation")
                try expect(types(runtime) == ["touchstart"], "no host event sent against pending geometry")
                try session.close()
            }
        }
        try test("fatal timer protocol failure stops polling even during presentation suspension") {
            let (runtime, session) = try make()
            try session.suspendPresentation(Failure.assertion("surface failed"))
            runtime.mode = "bad-poll"
            try requireError("ERR_ENGINE") { _ = try session.pollTimers(nowNs: 1) }
            try expect(session.isFailed && !session.canRun, "runtime failure is fatal")
            try expect(try !session.pollTimers(nowNs: 2), "fatal runtime does not keep polling")
            try expect(try !session.render(), "surface retry cannot revive a fatal runtime")
            try session.resumePresentation()
            try expect(runtime.polls == [1] && !session.canAcceptInput, "no native work after fatal failure")
            runtime.mode = "success"; try session.close()
        }
        try test("successful presentation acknowledgement retains complete diagnostic batch and operation") {
            let (runtime, session) = try make()
            let diagnostic = runtime.event("diagnostic", ["message": "ready subscribed observer", "level": "debug"])
            var operations: [String] = [], observed: [String] = []
            session.onOperation = { name, _, response in
                operations.append(name)
                try! expect(response == runtime.batch([diagnostic]).response, "untruncated acknowledgement bytes")
            }
            session.onDiagnostic = { value in observed.append(value["op"] as? String ?? "") }
            try session.consumePresentationAcknowledgement(runtime.batch([diagnostic]), revision: 1)
            try expect(operations == ["view.presented"] && observed == ["diagnostic"], "ready receipt and diagnostics both delivered")
            try expect(session.diagnostics.last?["op"] as? String == "diagnostic" && session.canRun, "history retained without failing runtime")
            session.onOperation = nil
            try session.close()
        }
        try test("presentation callback errors retain submitted frame and stop fatal runtime") {
            let (runtime, session) = try make()
            let failure = runtime.event("error", ["code": "ERR_ENGINE", "message": "ready callback threw", "committed": true])
            try requireError("ERR_ENGINE") {
                try session.consumePresentationAcknowledgement(runtime.batch([failure]), revision: 1)
            }
            try expect(session.isFailed && session.frameID == 1 && runtime.frame == 1, "post-submission error never rolls accepted identity back")
            try expect(session.diagnostics.contains { $0["op"] as? String == "error" }, "original structured error remains in history")
            try expect(try !session.pollTimers(nowNs: 1), "fatal callback failure stops business pump")
            try session.close()
        }
        try test("fatal acknowledgement error wins over an earlier surface error and retains later diagnostics") {
            let (runtime, session) = try make()
            let renderError = runtime.event("error", ["code": "ERR_RENDER", "message": "observer geometry unavailable"])
            let engineError = runtime.event("error", ["code": "ERR_ENGINE", "message": "engine failed"])
            let diagnostic = runtime.event("diagnostic", ["message": "cleanup complete"])
            try requireError("ERR_ENGINE") {
                try session.consumePresentationAcknowledgement(runtime.batch([renderError, engineError, diagnostic]), revision: 1)
            }
            try expect(session.isFailed && session.diagnostics.contains { ($0["payload"] as? [String: Any])?["message"] as? String == "cleanup complete" }, "full acknowledgement inspected before fatal decision")
            try session.close()
        }
        try test("stale presentation receipt suspends only presentation and preserves business scheduling") {
            let (runtime, session) = try make()
            let failure = runtime.event("error", ["code": "ERR_CANCELLED", "message": "stale revision"])
            try requireError("ERR_CANCELLED") {
                try session.consumePresentationAcknowledgement(runtime.batch([failure]), revision: 1)
            }
            _ = try session.pollTimers(nowNs: 1)
            try expect(session.isPresentationSuspended && !session.isFailed && runtime.polls == [1], "stale surface receipt is recoverable")
            try session.close()
        }
        try test("successful correlated frame remains authoritative when a sibling callback fails after publication") {
            let (runtime, session) = try make()
            runtime.mode = "sibling-error"; runtime.dueNs = 1
            try requireError("ERR_TIMEOUT") { _ = try session.pollTimers(nowNs: 1) }
            try expect(session.isFailed && session.frameID == 2 && runtime.frame == 2, "accepted native frame is not rolled back behind an error")
            try expect(session.route == runtime.route, "accepted route retained")
            let requests = runtime.requests.count, polls = runtime.polls.count
            try expect(try !session.pollTimers(nowNs: 2), "post-publication failure still stops the pump")
            try expect(runtime.requests.count == requests && runtime.polls.count == polls, "no subsequent native mutation")
            runtime.mode = "success"; try session.close()
        }
        try test("close releases native state once even after a throwing onUnload") {
            let (runtime, session) = try make()
            runtime.mode = "hook-error"
            try requireError("ERR_ENGINE") { try session.close() }
            try session.close()
            try expect(runtime.unloads == 1 && session.isClosed && !session.canRun, "finally-style cleanup")
            try expect(try !session.pollTimers(nowNs: .max), "closed pump suppressed")
        }
        try test("wrong-thread mutation is rejected before native access") {
            let (runtime, session) = try make()
            let semaphore = DispatchSemaphore(value: 0)
            var code = ""
            Thread.detachNewThread {
                do { _ = try session.pollTimers(nowNs: 1) }
                catch let error as WeappPortablePackError { code = error.code }
                catch { code = "unexpected" }
                semaphore.signal()
            }
            semaphore.wait()
            try expect(code == "ERR_ENGINE" && runtime.polls.isEmpty, "thread-affine boundary")
            try session.close()
        }
        print("Weapp Container session Swift tests: \(passed) passed; native engine/UIKit/GPU not run")
    }
}
