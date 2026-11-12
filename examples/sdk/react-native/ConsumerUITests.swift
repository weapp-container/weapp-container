import XCTest

@MainActor final class ConsumerUITests: XCTestCase {
    let app = XCUIApplication(bundleIdentifier: "__BUNDLE__")
    override func tearDownWithError() throws { if app.staticTexts["receipt"].exists { let evidence = XCTAttachment(string: app.staticTexts["receipt"].label); evidence.name = "react-native-receipt.json"; evidence.lifetime = .keepAlways; add(evidence) }; XCUIDevice.shared.orientation = .portrait; app.terminate() }
    func wait(_ description: String, _ condition: @escaping () -> Bool) {
        let predicate = NSPredicate { _, _ in condition() }
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: nil)], timeout: 30), .completed, description + "\n" + app.debugDescription)
    }
    func receipt() -> [String: Any] {
        let element = app.staticTexts["receipt"]
        guard element.exists, let data = element.label.data(using: .utf8), let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return value
    }
    func message(_ name: String) -> [String: Any] { (receipt()["messages"] as? [String: Any])?[name] as? [String: Any] ?? [:] }
    func action(_ name: String) { let button = app.buttons[name]; wait("Hittable \(name)") { button.isHittable }; button.tap(); wait(name) { self.app.staticTexts["status"].label == "passed:\(name)" } }
    func shot(_ name: String) { let item = XCTAttachment(screenshot: app.screenshot()); item.name = name; item.lifetime = .keepAlways; add(item) }
    func testDevelopmentReload() async throws {
        continueAfterFailure = false
        app.launch()
        try XCTSkipUnless(app.buttons["ReloadRuntime"].waitForExistence(timeout: 15), "Requires a Debug app and Metro")
        wait("Initial development sessions") { self.app.staticTexts["status"].label == "ready" && self.receipt()["firstGpuCapabilities"] != nil && self.receipt()["secondGpuCapabilities"] != nil }
        let original = receipt()["session"] as? String
        let surface = app.otherElements["container-main"]
        surface.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 40, dy: 80)).tap()
        wait("Persistent input before refresh") { (self.message("first:tap")["count"] as? Int ?? 0) >= 1 }
        let (_, response) = try await URLSession.shared.data(from: URL(string: "__REFRESH_URL__")!)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        wait("Actual Metro Fast Refresh") { self.app.staticTexts["refresh-marker"].label == "refreshed" && self.app.staticTexts["status"].label == "ready" && self.receipt()["session"] as? String != original && self.receipt()["firstGpuCapabilities"] != nil && self.receipt()["secondGpuCapabilities"] != nil }
        XCTAssertGreaterThanOrEqual(message("first:initial")["stored"] as? Int ?? 0, 1)
        XCTAssertNil(receipt()["nativeError"])
        let refreshed = receipt()["session"] as? String
        app.buttons["ReloadRuntime"].tap()
        wait("Full React instance reload") { self.app.staticTexts["status"].label == "ready" && self.receipt()["session"] as? String != refreshed && self.receipt()["firstGpuCapabilities"] != nil && self.receipt()["secondGpuCapabilities"] != nil && (self.receipt()["hostCalls"] as? Int ?? 0) >= 2 && (self.receipt()["cancelled"] as? Int ?? 0) >= 1 }
        XCTAssertGreaterThanOrEqual(message("first:initial")["stored"] as? Int ?? 0, 1)
        XCTAssertNil(receipt()["nativeError"])
        let result: [String: Any] = ["original": original ?? "", "fastRefresh": refreshed ?? "", "fullReload": receipt()["session"] ?? "", "receipt": receipt()]
        let evidence = XCTAttachment(data: try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), uniformTypeIdentifier: "public.json")
        evidence.name = "react-native-reload.json"; evidence.lifetime = .keepAlways; add(evidence)
        shot("rn-after-runtime-reload")
        action("Finish")
    }
    func sceneObservation() -> [String: Any] {
        let element = app.staticTexts["consumer-scene-observation"]
        guard element.exists, let text = element.value as? String, let data = text.data(using: .utf8), let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return value
    }
    func testNativeSessions() {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
        let sceneRotation = "__RN_ROTATION_MODE__" == "scene"
        if sceneRotation { app.launchArguments.append("--weapp-scene-rotation") }
        app.launch()
        wait("Initial sessions") { self.app.staticTexts["status"].label == "ready" }
        wait("Native host and cancellation") { (self.receipt()["hostCalls"] as? Int ?? 0) >= 2 && (self.receipt()["cancelled"] as? Int ?? 0) >= 1 && (self.receipt()["presented"] as? Int ?? 0) >= 2 }
        XCTAssertNil(receipt()["nativeError"])
        XCTAssertTrue(String(describing: receipt()["firstGpuCapabilities"] ?? "").contains("skia-gpu-metal"))
        XCTAssertTrue(String(describing: receipt()["secondGpuCapabilities"] ?? "").contains("skia-gpu-metal"))
        let surface = app.otherElements["container-main"]
        XCTAssertTrue(surface.waitForExistence(timeout: 5))
        surface.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 40, dy: 80)).tap()
        wait("Real touch and timer") { (self.message("first:tap")["count"] as? Int ?? 0) >= 1 && self.message("first:timer")["count"] != nil }
        let scroll = message("first:geometry")["scroll"] as? [String: Any] ?? [:]
        let y = (scroll["top"] as? Double ?? 124) + 130
        let x = (scroll["left"] as? Double ?? 28) + 50
        surface.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y)).press(forDuration: 0.05, thenDragTo: surface.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y - 100)))
        wait("Native scrolling") { (self.message("first:scroll")["scrollTop"] as? Double ?? 0) > 0 }
        shot("rn-two-native-surfaces")
        let session = receipt()["session"] as? String
        action("Rerender")
        XCTAssertEqual(receipt()["session"] as? String, session)
        let beforeRemount = receipt()["presented"] as? Int ?? 0
        action("RapidRemount")
        XCTAssertEqual(receipt()["rapidRemountSession"] as? String, session)
        wait("Recycled Fabric surface presents") { (self.receipt()["presented"] as? Int ?? 0) > beforeRemount }
        action("Navigate")
        XCTAssertTrue(String(describing: receipt()["state"] ?? "").contains("pages/detail/index"))
        action("Back")
        action("Detach")
        wait("Hidden asynchronous completion") { self.message("first:hiddenDone")["result"] != nil }
        let beforeReattach = receipt()["presented"] as? Int ?? 0
        action("Reattach")
        XCTAssertEqual(receipt()["detachedSession"] as? String, session)
        XCTAssertEqual(receipt()["reattachedSession"] as? String, session)
        wait("Reattached Fabric surface presents") { (self.receipt()["presented"] as? Int ?? 0) > beforeReattach }
        action("Pause")
        XCUIDevice.shared.press(.home)
        wait("App entered background") { self.app.state == .runningBackground || self.app.state == .runningBackgroundSuspended }
        app.activate()
        wait("App entered foreground") { self.app.state == .runningForeground }
        action("Resume")
        wait("Resume") { (self.message("first:show")["shows"] as? Int ?? 0) >= 2 }
        let portraitWidth = surface.frame.width
        if sceneRotation { app.buttons["consumer-scene-rotate"].tap() } else { XCUIDevice.shared.orientation = .landscapeLeft }
        wait("Rotation") { self.message("first:resize")["deviceOrientation"] as? String == "landscape" && surface.frame.width != portraitWidth && (!sceneRotation || [3, 4].contains(self.sceneObservation()["interfaceOrientation"] as? Int ?? 0)) }
        if sceneRotation {
            XCTAssertNil(sceneObservation()["error"])
            let evidence = XCTAttachment(data: try! JSONSerialization.data(withJSONObject: sceneObservation()), uniformTypeIdentifier: "public.json")
            evidence.name = "host-scene-landscape.json"; evidence.lifetime = .keepAlways; add(evidence)
        }
        shot("rn-landscape")
        if sceneRotation { app.buttons["consumer-scene-rotate"].tap() } else { XCUIDevice.shared.orientation = .portrait }
        wait("Portrait") { self.message("first:resize")["deviceOrientation"] as? String == "portrait" && surface.frame.width == portraitWidth && (!sceneRotation || self.sceneObservation()["interfaceOrientation"] as? Int == 1) }
        action("Close")
        action("Reopen")
        wait("Durable reopen") { (self.message("reopened:initial")["stored"] as? Int ?? 0) >= 1 }
        XCTAssertNotEqual(receipt()["reopened"] as? String, session)
        action("Finish")
        XCTAssertEqual(receipt()["allClosed"] as? Bool, true)
        XCTAssertNil(receipt()["error"])
        let evidence = XCTAttachment(string: app.staticTexts["receipt"].label); evidence.name = "react-native-receipt.json"; evidence.lifetime = .keepAlways; add(evidence)
    }
}
