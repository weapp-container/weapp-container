import XCTest
import UIKit

/// The dashboard endpoint only reads pages/state. All guest actions below use
/// the real native preview or Player chrome, never a remote mutation command.
final class PlayerP0Tests: XCTestCase {
    let env = ProcessInfo.processInfo.environment
    lazy var player = XCUIApplication(bundleIdentifier: env["P0_PLAYER_BUNDLE"] ?? "dev.weapp.weappContainerDevPlayer")
    var dashboardKey: String?
    override func setUp() { super.setUp(); continueAfterFailure = false; player.activate() }
    func fail(_ message: String) -> NSError { NSError(domain: "PlayerP0", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    func object(_ value: Any?) -> [String: Any] { value as? [String: Any] ?? [:] }
    func number(_ value: Any?) -> Double { (value as? NSNumber)?.doubleValue ?? .nan }
    func button(_ labels: [String]) -> XCUIElement {
        player.buttons.matching(NSPredicate(format: "label IN %@", labels)).firstMatch
    }
    func request(_ path: String, value: [String: Any]? = nil) throws -> Data {
        guard let origin = env["P0_DASHBOARD"], origin.range(of: #"^http://127\.0\.0\.1:[0-9]+$"#, options: .regularExpression) != nil else { throw fail("A loopback dashboard is required") }
        var request = URLRequest(url: URL(string: origin + path)!)
        request.timeoutInterval = 8
        request.setValue(origin, forHTTPHeaderField: "Origin")
        if let key = dashboardKey { request.setValue("Bearer " + key, forHTTPHeaderField: "Authorization") }
        if let value { request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type"); request.httpBody = try JSONSerialization.data(withJSONObject: value) }
        let done = DispatchSemaphore(value: 0)
        var bytes: Data?; var status = 0; var error: Error?
        let task = URLSession.shared.dataTask(with: request) { data, response, failure in
            bytes = data; error = failure; status = (response as? HTTPURLResponse)?.statusCode ?? 0; done.signal()
        }
        task.resume()
        guard done.wait(timeout: .now() + 10) == .success else { task.cancel(); throw fail("Dashboard timeout") }
        guard error == nil, (200..<300).contains(status), let bytes else { throw fail("Dashboard HTTP " + String(status)) }
        return bytes
    }
    func api(_ path: String, value: [String: Any]? = nil) throws -> [String: Any] {
        if dashboardKey == nil {
            let html = String(decoding: try request("/"), as: UTF8.self)
            let regex = try NSRegularExpression(pattern: "const key=(\"[^\"\\n]+\")")
            guard let match = regex.firstMatch(in: html, range: NSRange(html.startIndex..., in: html)), let range = Range(match.range(at: 1), in: html) else { throw fail("Dashboard authentication unavailable") }
            dashboardKey = try JSONSerialization.jsonObject(with: Data(html[range].utf8), options: .fragmentsAllowed) as? String
        }
        return object(try JSONSerialization.jsonObject(with: request(path, value: value)))
    }
    func snapshot() throws -> [String: Any] {
        guard let deviceId = env["P0_DEVICE_ID"], !deviceId.isEmpty else { throw fail("Pin the owned device ID") }
        let devices = try api("/state")["devices"] as? [[String: Any]] ?? []
        guard devices.contains(where: { $0["id"] as? String == deviceId && $0["connected"] as? Bool == true && $0["platform"] as? String == "ios" }) else { throw fail("Pinned iOS device is not connected") }
        guard let id = try api("/inspect", value: ["deviceId": deviceId])["requestId"] as? String else { throw fail("Missing inspection request") }
        let deadline = Date().addingTimeInterval(8)
        while Date() < deadline {
            let response = try api("/inspections/" + id)
            if response["status"] as? String == "completed" { return object(response["snapshot"]) }
            if response["status"] as? String != "pending" { throw fail("Read-only inspection failed") }
            Thread.sleep(forTimeInterval: 0.1)
        }
        throw fail("Inspection deadline")
    }
    func page(_ snapshot: [String: Any]) -> [String: Any] { (snapshot["pages"] as? [[String: Any]])?.last ?? [:] }
    func state(_ snapshot: [String: Any]) -> [String: Any] { object(snapshot["state"]) }
    func data(_ snapshot: [String: Any]) -> [String: Any] { object(page(snapshot)["data"]) }
    func awaitSnapshot(_ message: String, timeout: Double = 25, _ condition: ([String: Any]) -> Bool) throws -> [String: Any] {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let captured = try snapshot()
            if condition(captured) { return captured }
            Thread.sleep(forTimeInterval: 0.1)
        }
        throw fail(message)
    }
    @discardableResult func ready(_ route: String) throws -> [String: Any] {
        try awaitSnapshot("No presented/input-enabled frame for " + route) {
            self.page($0)["route"] as? String == route && self.state($0)["inputEnabled"] as? Bool == true && self.state($0)["pendingNavigation"] is NSNull
        }
    }
    func surface() throws -> XCUIElement {
        let surface = player.otherElements.matching(NSPredicate(format: "identifier BEGINSWITH %@", "platform_view[")).firstMatch
        guard surface.waitForExistence(timeout: 8), surface.frame.width > 0, surface.frame.height > 0 else { throw fail("No measurable native view") }
        return surface
    }
    func target(_ id: String, snapshot: [String: Any]) throws -> XCUICoordinate {
        try assertLayout(snapshot)
        let targets = data(snapshot)["targets"] as? [[String: Any]] ?? []
        guard let target = targets.first(where: { $0["id"] as? String == id }) else { throw fail("Missing measured selector target " + id) }
        // AX and UIKit use logical screen points. First independently compare
        // native bounds with the committed viewport, then use direct offsets;
        // a guest/native scale ratio could hide a consistently wrong viewport.
        let view = try surface()
        let x = number(target["left"]) + number(target["width"]) / 2
        let y = number(target["top"]) + number(target["height"]) / 2
        guard x.isFinite, y.isFinite, x >= 0, y >= 0, x < view.frame.width, y < view.frame.height else { throw fail("Selector target outside visible native surface: " + id) }
        return view.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y))
    }
    func tap(_ id: String, route: String) throws { try target(id, snapshot: ready(route)).tap() }
    struct FrozenScreenInputProbe {
        let geometry: InputProbeGeometry
        let orientation: UIDeviceOrientation
    }
    func freezeScreenInputProbe(_ id: String, snapshot: [String: Any]) throws -> FrozenScreenInputProbe {
        try assertLayout(snapshot)
        let targets = data(snapshot)["targets"] as? [[String: Any]] ?? []
        guard let selector = targets.first(where: { $0["id"] as? String == id }) else {
            throw fail("Missing measured selector for screen input probe " + id)
        }
        let native = state(snapshot), content = object(object(object(state(snapshot)["acceptedLayout"])["chrome"])["contentRect"])
        guard let owner = native["ownerId"] as? String, !owner.isEmpty,
              let session = native["sessionId"] as? String, !session.isEmpty,
              let generation = native["generation"] as? NSNumber,
              !object(native["acceptedPackIdentity"]).isEmpty else {
            throw fail("C012 screen probe needs a complete accepted native identity")
        }
        let geometry = try InputProbeGeometry(
            applicationFrame: player.frame,
            surfaceFrame: surface().frame,
            contentFrame: CGRect(x: number(content["left"]), y: number(content["top"]),
                                 width: number(content["width"]), height: number(content["height"])),
            selectorRect: CGRect(x: number(selector["left"]), y: number(selector["top"]),
                                 width: number(selector["width"]), height: number(selector["height"])))
        let orientation = XCUIDevice.shared.orientation
        let evidence: [String: Any] = [
            "schemaVersion": 1, "selectorId": id, "geometry": geometry.evidence,
            "orientation": orientation.rawValue,
            "nativeIdentity": ["ownerId": owner, "sessionId": session, "generation": generation,
                               "hostSurface": object(native["hostSurface"]),
                               "acceptedPackIdentity": object(native["acceptedPackIdentity"]),
                               "acceptedLayout": object(native["acceptedLayout"])],
        ]
        let bytes = try JSONSerialization.data(withJSONObject: evidence, options: [.prettyPrinted, .sortedKeys])
        let record = XCTAttachment(data: bytes, uniformTypeIdentifier: "public.json")
        record.name = "C012-before-fault-screen-input-probe"; record.lifetime = .keepAlways; add(record)
        return FrozenScreenInputProbe(geometry: geometry, orientation: orientation)
    }
    func assertScreenInputProbeIdentity(_ before: [String: Any], _ after: [String: Any], sameSurface: Bool = true) throws {
        let original = state(before), current = state(after)
        guard current["ownerId"] as? String == original["ownerId"] as? String,
              current["sessionId"] as? String == original["sessionId"] as? String,
              number(current["generation"]) == number(original["generation"]),
              object(current["acceptedPackIdentity"]) as NSDictionary == object(original["acceptedPackIdentity"]) as NSDictionary,
              page(after)["route"] as? String == page(before)["route"] as? String else {
            throw fail("C012 screen input probe changed native/page/pack identity")
        }
        if sameSurface, object(current["hostSurface"]) as NSDictionary != object(original["hostSurface"]) as NSDictionary {
            throw fail("C012 frozen screen input probe changed native surface")
        }
    }
    func tapFrozenScreenInputProbe(_ probe: FrozenScreenInputProbe, before: [String: Any], fault: [String: Any]) throws {
        try assertScreenInputProbeIdentity(before, fault)
        guard state(fault)["inputEnabled"] as? Bool == false,
              XCUIDevice.shared.orientation == probe.orientation else {
            throw fail("C012 screen input probe needs blocked input and unchanged orientation")
        }
        // The failing View is hidden intentionally. Only the application's
        // stable screen anchor may be resolved here; do not look up surface().
        let offset = try probe.geometry.applicationOffset(currentApplicationFrame: player.frame)
        player.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: offset.x, dy: offset.y)).tap()
    }
    func incrementJournal(_ snapshot: [String: Any]) throws -> [String] {
        let journal = object(data(snapshot)["journal"])
        guard number(journal["schemaVersion"]) == 1, let events = journal["events"] as? [String] else {
            throw fail("C012 input probe requires the complete callback journal")
        }
        var previousSequence = 0
        return try events.filter { encoded in
            guard let entry = try JSONSerialization.jsonObject(with: Data(encoded.utf8)) as? [Any],
                  entry.count == 6, let event = entry[3] as? String,
                  let sequence = entry[0] as? Int, sequence > previousSequence else {
                throw fail("Malformed or non-monotonic C012 callback journal tuple")
            }
            previousSequence = sequence
            return event.hasPrefix("increment.")
        }
    }
    func assertScreenInputProbeJournalRetained(_ before: [String: Any], _ after: [String: Any]) throws {
        let previous = object(data(before)["journal"]), current = object(data(after)["journal"])
        guard let previousEvents = previous["events"] as? [String], let events = current["events"] as? [String],
              let previousGeometries = previous["geometries"] as? [String], let geometries = current["geometries"] as? [String],
              events.starts(with: previousEvents), geometries.starts(with: previousGeometries) else {
            throw fail("C012 screen input probe callback journal was truncated or replaced")
        }
        XCTAssertEqual(try incrementJournal(after), try incrementJournal(before), "Blocked screen input must not invoke a guest increment handler")
    }
    func attach(_ name: String, _ snapshot: [String: Any]) throws {
        let json = try JSONSerialization.data(withJSONObject: snapshot, options: [.prettyPrinted, .sortedKeys])
        let record = XCTAttachment(data: json, uniformTypeIdentifier: "public.json"); record.name = name + "-snapshot"; record.lifetime = .keepAlways; add(record)
        let image = XCTAttachment(screenshot: player.screenshot()); image.name = name; image.lifetime = .keepAlways; add(image)
        let tree = XCTAttachment(string: player.debugDescription); tree.name = name + "-accessibility"; tree.lifetime = .keepAlways; add(tree)
    }
    func assertLayout(_ captured: [String: Any], first: Bool = false) throws {
        let native = state(captured); let layout = object(native["acceptedLayout"])
        let identity = object(native["acceptedPackIdentity"]); let host = object(native["hostSurface"])
        XCTAssertEqual(layout["ownerId"] as? String, native["ownerId"] as? String)
        XCTAssertEqual(layout["surfaceGeneration"] as? String, host["surfaceGeneration"] as? String)
        for key in ["ownerId", "surfaceGeneration", "observationId", "layoutRevision"] {
            XCTAssertNotNil((layout[key] as? String)?.range(of: #"^[1-9][0-9]*$"#, options: .regularExpression), key)
        }
        XCTAssertEqual(identity["sessionId"] as? String, native["sessionId"] as? String)
        let metrics = object(layout["windowMetrics"]); let viewport = object(native["viewport"])
        let chrome = object(layout["chrome"]); let content = object(chrome["contentRect"])
        XCTAssertEqual(number(viewport["width"]), number(metrics["windowWidth"]), accuracy: 1)
        XCTAssertEqual(number(viewport["height"]), number(metrics["windowHeight"]), accuracy: 1)
        XCTAssertEqual(number(content["width"]), number(metrics["windowWidth"]), accuracy: 1)
        XCTAssertEqual(number(content["height"]), number(metrics["windowHeight"]), accuracy: 1)
        let view = try surface().frame
        XCTAssertEqual(number(content["left"]), view.minX, accuracy: 1.5)
        XCTAssertEqual(number(content["top"]), view.minY, accuracy: 1.5)
        XCTAssertEqual(number(content["width"]), view.width, accuracy: 1.5)
        XCTAssertEqual(number(content["height"]), view.height, accuracy: 1.5)
        if first {
            let sample = object(data(captured)["first"])
            XCTAssertEqual(sample["event"] as? String, "onLoad")
            let geometries = data(captured)["geometries"] as? [String] ?? []
            guard let index = sample["geometry"] as? Int, geometries.indices.contains(index) else { throw fail("First lifecycle geometry absent") }
            let geometry = object(try JSONSerialization.jsonObject(with: Data(geometries[index].utf8)))
            let window = object(geometry["window"])
            XCTAssertEqual(number(window["windowWidth"]), number(viewport["width"]), accuracy: 1)
            XCTAssertEqual(number(window["windowHeight"]), number(viewport["height"]), accuracy: 1)
            let capsule = object(geometry["capsule"]); let menu = object(chrome["menuButtonRect"])
            for edge in ["left", "top", "right", "bottom", "width", "height"] { XCTAssertEqual(number(capsule[edge]), number(menu[edge]), accuracy: 1.5, edge) }
        }
    }
    func toolsRoundTrip() throws {
        let more = button(["更多", "More"]); XCTAssertTrue(more.waitForExistence(timeout: 8)); more.tap()
        let tools = button(["开发工具", "Developer tools"]); XCTAssertTrue(tools.waitForExistence(timeout: 5)); tools.tap()
        let back = button(["返回小程序", "Return to mini program"]); XCTAssertTrue(back.waitForExistence(timeout: 8)); back.tap()
        XCTAssertTrue(more.waitForExistence(timeout: 8))
    }
    func assertAdvanced(_ before: [String: Any], _ after: [String: Any]) throws {
        let previous = object(state(before)["acceptedLayout"]), next = object(state(after)["acceptedLayout"])
        XCTAssertEqual(previous["ownerId"] as? String, next["ownerId"] as? String)
        for field in ["observationId", "layoutRevision"] {
            guard let old = previous[field] as? String, let new = next[field] as? String,
                  let oldNumber = UInt64(old), let newNumber = UInt64(new) else { throw fail("Invalid decimal layout identity") }
            XCTAssertGreaterThan(newNumber, oldNumber, field)
        }
    }
    func assertRotationCallbacks(_ before: [String: Any], _ after: [String: Any], name: String) throws {
        // Persist every captured callback before asserting. Final frame geometry
        // alone cannot disprove a mixed window/capsule inside an earlier hook.
        let raw = try JSONSerialization.data(withJSONObject: ["before": before, "after": after], options: [.prettyPrinted, .sortedKeys])
        let attachment = XCTAttachment(data: raw, uniformTypeIdentifier: "public.json")
        attachment.name = name + "-complete-callback-journal"; attachment.lifetime = .keepAlways; add(attachment)
        let previousJournal = object(data(before)["journal"]), nextJournal = object(data(after)["journal"])
        guard number(previousJournal["schemaVersion"]) == 1, number(nextJournal["schemaVersion"]) == 1,
              let previous = previousJournal["events"] as? [String], let events = nextJournal["events"] as? [String],
              let previousGeometry = previousJournal["geometries"] as? [String], let geometries = nextJournal["geometries"] as? [String],
              events.starts(with: previous), geometries.starts(with: previousGeometry) else {
            throw fail("C013 requires an untruncated, append-only callback journal")
        }
        func tuple(_ encoded: String) throws -> [Any] {
            guard let value = try JSONSerialization.jsonObject(with: Data(encoded.utf8)) as? [Any], value.count == 6,
                  let sequence = value[0] as? Int, sequence > 0 else { throw fail("Malformed C013 journal tuple") }
            return value
        }
        var lastSequence = 0
        for encoded in previous {
            let entry = try tuple(encoded); let sequence = entry[0] as! Int
            guard sequence > lastSequence else { throw fail("C013 journal sequence is not strictly increasing") }
            lastSequence = sequence
        }
        let beforeLayout = object(state(before)["acceptedLayout"]), afterLayout = object(state(after)["acceptedLayout"])
        func sameNumber(_ left: Any?, _ right: Any?) -> Bool {
            let a = number(left), b = number(right)
            return a.isFinite && b.isFinite && abs(a - b) <= 0.01
        }
        func matches(_ geometry: [String: Any], _ arguments: [String: Any], _ layout: [String: Any]) -> Bool {
            let window = object(geometry["window"]), metrics = object(layout["windowMetrics"])
            for key in ["windowWidth", "windowHeight", "pixelRatio", "screenWidth", "screenHeight", "statusBarHeight", "screenTop"] {
                if !sameNumber(window[key], metrics[key]) { return false }
            }
            let observedSafe = object(window["safeArea"]), expectedSafe = object(metrics["safeArea"])
            if observedSafe.isEmpty != expectedSafe.isEmpty { return false }
            if !expectedSafe.isEmpty {
                for key in ["left", "top", "right", "bottom", "width", "height"] {
                    if !sameNumber(observedSafe[key], expectedSafe[key]) { return false }
                }
            }
            guard let orientation = arguments["deviceOrientation"] as? String,
                  orientation == metrics["deviceOrientation"] as? String else { return false }
            let capsule = object(geometry["capsule"]), menu = object(object(layout["chrome"])["menuButtonRect"])
            for key in ["left", "top", "right", "bottom", "width", "height"] {
                if !sameNumber(capsule[key], menu[key]) { return false }
            }
            return true
        }
        var resizeCount = 0, finalLayoutCount = 0
        for encoded in events.dropFirst(previous.count) {
            let entry = try tuple(encoded); let sequence = entry[0] as! Int
            guard sequence > lastSequence else { throw fail("C013 journal sequence regressed during rotation") }
            lastSequence = sequence
            guard entry[3] as? String == "onResize" else { continue }
            resizeCount += 1
            guard let index = entry[4] as? Int, geometries.indices.contains(index),
                  let geometry = try JSONSerialization.jsonObject(with: Data(geometries[index].utf8)) as? [String: Any],
                  geometry["error"] == nil else { throw fail("C013 resize geometry is missing or failed at sequence \(sequence)") }
            let window = object(geometry["window"]), arguments = object(object(entry[5])["size"]), size = object(arguments["size"])
            for key in ["windowWidth", "windowHeight"] {
                guard sameNumber(size[key], window[key]) else { throw fail("C013 onResize argument and synchronous window disagree at sequence \(sequence): \(key)") }
            }
            if matches(geometry, arguments, afterLayout) { finalLayoutCount += 1 }
            else if !matches(geometry, arguments, beforeLayout) {
                // A genuine intermediate native commit needs its own receipt.
                // Never pair that window with the final capsule or silently
                // skip an unobserved tuple merely because the final frame works.
                throw fail("C013 resize sequence \(sequence) has a mixed or uncorrelated native metric/capsule tuple; inspect the complete callback journal")
            }
        }
        guard resizeCount > 0, finalLayoutCount > 0 else { throw fail("C013 rotation produced no onResize callback matching the newly presented complete layout") }
    }
    func test10C013TenRotationNavigationCycles() throws {
        let home = "pages/home/index"
        let baseline = try ready(home); try assertLayout(baseline, first: true); try attach("C013-baseline", baseline)
        let identity = object(state(baseline)["acceptedPackIdentity"])
        defer { XCUIDevice.shared.orientation = .portrait }
        for cycle in 1...10 {
            let before = try ready(home)
            let previousObservation = object(state(before)["acceptedLayout"])["observationId"] as? String
            XCUIDevice.shared.orientation = .landscapeLeft
            let landscape = try awaitSnapshot("Rotation did not publish fresh atomic layout") {
                let current = self.state($0); let viewport = self.object(current["viewport"])
                return current["inputEnabled"] as? Bool == true && self.number(viewport["width"]) > self.number(viewport["height"]) && self.object(current["acceptedLayout"])["observationId"] as? String != previousObservation
            }
            try assertRotationCallbacks(before, landscape, name: "C013-\(cycle)-landscape")
            try assertLayout(landscape); try assertAdvanced(before, landscape); try attach("C013-\(cycle)-landscape", landscape)
            XCUIDevice.shared.orientation = .portrait
            let landscapeObservation = object(state(landscape)["acceptedLayout"])["observationId"] as? String
            let portrait = try awaitSnapshot("Portrait layout did not recover") {
                let viewport = self.object(self.state($0)["viewport"])
                return self.state($0)["inputEnabled"] as? Bool == true && self.number(viewport["width"]) < self.number(viewport["height"]) && self.object(self.state($0)["acceptedLayout"])["observationId"] as? String != landscapeObservation
            }
            try assertRotationCallbacks(landscape, portrait, name: "C013-\(cycle)-portrait")
            try assertLayout(portrait); try assertAdvanced(landscape, portrait)
            try tap("p0-normal", route: home)
            let normal = try ready("pages/detail/index"); try assertLayout(normal, first: true); try assertAdvanced(portrait, normal); try attach("C013-\(cycle)-normal", normal)
            try tap("p0-back", route: "pages/detail/index"); let normalReturned = try ready(home); try assertAdvanced(normal, normalReturned)
            try tap("p0-custom", route: home)
            let custom = try ready("pages/custom/index"); try assertLayout(custom, first: true); try assertAdvanced(normalReturned, custom); try attach("C013-\(cycle)-custom", custom)
            try tap("p0-back", route: "pages/custom/index")
            let returned = try ready(home); try assertLayout(returned); try assertAdvanced(custom, returned)
            XCTAssertEqual(object(state(returned)["acceptedPackIdentity"]) as NSDictionary, identity as NSDictionary)
            let count = number(data(returned)["count"])
            try tap("p0-increment", route: home)
            let incremented = try awaitSnapshot("Input after navigation/rotation missed") { self.number(self.data($0)["count"]) == count + 1 }
            try attach("C013-\(cycle)-returned", incremented)
        }
    }
    func test20ToolsCloseReopenPersistentStorage() throws {
        let home = "pages/home/index"; let starting = try ready(home)
        try tap("p0-increment", route: home)
        let expected = number(data(starting)["count"]) + 1
        let before = try awaitSnapshot("Memory marker was not set") { self.number(self.data($0)["count"]) == expected }
        let count = number(data(before)["count"])
        try tap("p0-save", route: home)
        _ = try awaitSnapshot("Storage not saved") { self.number(self.data($0)["stored"]) == count }
        try toolsRoundTrip(); try assertLayout(ready(home))
        let close = button(["关闭小程序", "Close mini program"]); XCTAssertTrue(close.waitForExistence(timeout: 5)); close.tap()
        let open = button(["打开小程序", "Open mini program"]); XCTAssertTrue(open.waitForExistence(timeout: 8))
        let nativeViews = player.otherElements.matching(NSPredicate(format: "identifier BEGINSWITH %@", "platform_view["))
        XCTAssertEqual(nativeViews.count, 0, "Closed Player must unmount its native surface")
        guard let device = env["P0_DEVICE_ID"], let requestId = try api("/inspect", value: ["deviceId": device])["requestId"] as? String else { throw fail("Closed inspection request unavailable") }
        var closedInspection: [String: Any] = [:]
        for _ in 0..<60 {
            closedInspection = try api("/inspections/" + requestId)
            if closedInspection["status"] as? String != "pending" { break }
            Thread.sleep(forTimeInterval: 0.1)
        }
        XCTAssertNotEqual(closedInspection["status"] as? String, "completed", "Closed guest must not expose active page data")
        XCTAssertNotEqual(closedInspection["status"] as? String, "pending", "Closed state needs a terminal inspection refusal")
        open.tap()
        let reopened = try ready(home)
        XCTAssertNotEqual(state(before)["sessionId"] as? String, state(reopened)["sessionId"] as? String)
        XCTAssertEqual(number(data(reopened)["stored"]), count)
        XCTAssertEqual(number(data(reopened)["count"]), 0, "In-memory marker must reset while storage survives")
        XCTAssertEqual(number(data(reopened)["instance"]), 1)
        try assertLayout(reopened, first: true); try attach("close-reopen", reopened)
    }
    func test30C012ViewFaultTimersAndRetry() throws {
        let home = "pages/home/index"; let before = try ready(home)
        let count = number(data(before)["count"])
        let increment = try freezeScreenInputProbe("p0-increment", snapshot: before)
        try tap("p0-fault", route: home)
        let fault = try awaitSnapshot("WXS fault not sticky") { self.object(self.state($0)["executionHealth"])["requiresRestart"] as? Bool == true }
        let health = object(state(fault)["executionHealth"]), viewFault = object(object(state(fault)["executionHealth"])["viewFault"])
        XCTAssertEqual(viewFault["domain"] as? String, "view")
        XCTAssertEqual(viewFault["code"] as? String, "ERR_TIMEOUT")
        XCTAssertTrue(health["appServiceFault"] is NSNull)
        XCTAssertTrue(health["navigationFault"] is NSNull)
        XCTAssertEqual(state(fault)["inputEnabled"] as? Bool, false)
        XCTAssertEqual(state(fault)["foreground"] as? Bool, true)
        let ticks = number(data(fault)["ticks"])
        let incrementEvents = try incrementJournal(fault)
        try attach("C012-before-blocked-screen-input", fault)
        try tapFrozenScreenInputProbe(increment, before: before, fault: fault)
        let ticking = try awaitSnapshot("Healthy AppService timer was stopped by View failure") { self.number(self.data($0)["ticks"]) > ticks + 2 }
        try assertScreenInputProbeIdentity(before, ticking)
        XCTAssertEqual(object(state(ticking)["executionHealth"]) as NSDictionary, object(state(fault)["executionHealth"]) as NSDictionary)
        XCTAssertEqual(state(ticking)["inputEnabled"] as? Bool, false)
        XCTAssertEqual(state(ticking)["foreground"] as? Bool, true)
        XCTAssertEqual(try incrementJournal(ticking), incrementEvents, "Blocked screen tap must not invoke a guest increment handler")
        try assertScreenInputProbeJournalRetained(fault, ticking)
        XCTAssertEqual(number(data(ticking)["count"]), count)
        try attach("C012-sticky-fault-business-timer", ticking)
        XCUIDevice.shared.orientation = .landscapeLeft; XCUIDevice.shared.orientation = .portrait
        try toolsRoundTrip()
        let stillFaulted = try snapshot()
        // Rotation may legitimately rebuild a surface, while guest ownership
        // and sticky execution health must survive until the explicit Retry.
        try assertScreenInputProbeIdentity(before, stillFaulted, sameSurface: false)
        XCTAssertEqual(object(state(stillFaulted)["executionHealth"]) as NSDictionary, object(state(fault)["executionHealth"]) as NSDictionary)
        XCTAssertEqual(state(stillFaulted)["inputEnabled"] as? Bool, false)
        XCTAssertEqual(state(stillFaulted)["foreground"] as? Bool, true)
        XCTAssertEqual(number(data(stillFaulted)["count"]), count)
        try assertScreenInputProbeJournalRetained(ticking, stillFaulted)
        try attach("C012-fault-retained-before-explicit-retry", stillFaulted)
        let retry = button(["重试预览", "Retry preview"]); XCTAssertTrue(retry.waitForExistence(timeout: 8)); retry.tap()
        let recovered = try ready(home)
        XCTAssertNotEqual(state(before)["sessionId"] as? String, state(recovered)["sessionId"] as? String)
        try assertLayout(recovered, first: true); try attach("C012-fresh-session-recovered", recovered)
    }
    /// Root orchestrates candidate source failure externally. Stage one captures
    /// immutable accepted ownership; stage two consumes it after failure, and
    /// requires a native ACK plus working input on the retained old session.
    func test40C018CaptureAcceptedBaseline() throws { try attach("C018-baseline", ready("pages/home/index")) }
    func test41C018RejectedCandidateRetainsOwner() throws {
        guard let expectedSession = env["P0_EXPECT_SESSION"], let expectedRoot = env["P0_EXPECT_ROOT"], let revision = env["P0_EXPECT_ACCEPTED_REVISION"] else { throw XCTSkip("C018 needs pinned baseline identity from stage40") }
        guard let rejectedRoot = env["P0_REJECTED_ROOT"], let rejectedGeneration = env["P0_REJECTED_GENERATION"], let rejectedRun = env["P0_REJECTED_RUN_ID"], rejectedRoot != expectedRoot else { throw XCTSkip("C018 needs the actual candidate descriptor") }
        let captured = try awaitSnapshot("Actual candidate rejection was not exported") {
            let observation = self.object($0["developmentAttempt"]), receipt = self.object(self.object($0["developmentAttempt"])["receipt"])
            return observation["targetRoot"] as? String == rejectedRoot && observation["generation"] as? String == rejectedGeneration && observation["runId"] as? String == rejectedRun && observation["resolution"] as? String == "terminal" && receipt["status"] as? String == "rejected" && self.state($0)["inputEnabled"] as? Bool == true
        }
        let accepted = object(state(captured)["acceptedPackIdentity"]), observation = object(captured["developmentAttempt"])
        let receipt = object(observation["receipt"]), attemptError = object(object(observation["receipt"])["error"])
        XCTAssertEqual(state(captured)["ownerId"] as? String, receipt["ownerId"] as? String)
        XCTAssertNotNil((receipt["attemptId"] as? String)?.range(of: #"^[1-9][0-9]*$"#, options: .regularExpression))
        XCTAssertEqual(receipt["targetRoot"] as? String, rejectedRoot)
        XCTAssertEqual(object(receipt["expectedAccepted"]) as NSDictionary, accepted as NSDictionary)
        XCTAssertEqual(object(receipt["acceptedPackIdentity"]) as NSDictionary, accepted as NSDictionary)
        XCTAssertEqual(object(captured["acceptedPack"])["root"] as? String, expectedRoot)
        XCTAssertNotEqual(object(captured["acceptedPack"])["generation"] as? String, rejectedGeneration)
        XCTAssertNotNil((attemptError["code"] as? String)?.range(of: #"^ERR_[A-Z0-9_]+$"#, options: .regularExpression))
        XCTAssertTrue((attemptError["message"] as? String ?? "").contains("P0_CANDIDATE_STARTUP_FAILURE"))
        XCTAssertEqual(accepted["sessionId"] as? String, expectedSession)
        XCTAssertEqual(accepted["root"] as? String, expectedRoot)
        XCTAssertEqual(accepted["acceptedPackRevision"] as? String, revision)
        let count = number(data(captured)["count"]); let ticks = number(data(captured)["ticks"])
        try tap("p0-increment", route: "pages/home/index")
        let after = try awaitSnapshot("Rejected candidate did not restore old input/timer") { self.number(self.data($0)["count"]) == count + 1 && self.number(self.data($0)["ticks"]) > ticks }
        try assertLayout(after); try attach("C018-old-owner-restored-ack-input", after)
    }
}
