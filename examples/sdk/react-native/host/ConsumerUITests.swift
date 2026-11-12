import XCTest

@MainActor final class ConsumerUITests: XCTestCase {
    let app = XCUIApplication(bundleIdentifier: "__BUNDLE__")
    func wait(_ name: String, _ condition: @escaping () -> Bool) {
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in condition() }, object: nil)], timeout: 25), .completed, name + "\n" + app.debugDescription)
    }
    func receipt() -> [String: Any] {
        guard app.staticTexts["host-receipt"].exists, let data = app.staticTexts["host-receipt"].label.data(using: .utf8), let result = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return result
    }
    func message(_ kind: String) -> [String: Any] { (receipt()["messages"] as? [String: Any])?[kind] as? [String: Any] ?? [:] }
    func events(_ kind: String) -> Int { (receipt()["touchEvents"] as? [[String: Any]] ?? []).filter { $0["type"] as? String == kind }.count }
    func action(_ name: String) { let button = app.buttons[name]; wait(name + " is hittable") { button.isHittable }; button.tap(); wait(name) { self.app.staticTexts["host-status"].label == "passed:\(name)" } }
    var surface: XCUIElement { app.otherElements["host-container"] }
    func point(_ x: Double, _ y: Double) -> XCUICoordinate { surface.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y)) }
    func start() {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
        app.launch()
        wait("Native host harness ready") { self.app.staticTexts["host-status"].label == "ready" && self.receipt()["gpu"] != nil && self.message("geometry")["scroll"] != nil }
        XCTAssertTrue(String(describing: receipt()["gpu"] ?? "").contains("skia-gpu-metal"))
    }
    override func tearDownWithError() throws {
        if app.staticTexts["host-receipt"].exists {
            let evidence = XCTAttachment(string: app.staticTexts["host-receipt"].label); evidence.name = "host-receipt.json"; evidence.lifetime = .keepAlways; add(evidence)
            let screenshot = XCTAttachment(screenshot: app.screenshot()); screenshot.name = "host-route-and-scroll"; screenshot.lifetime = .keepAlways; add(screenshot)
        }
        if app.buttons["Finish"].isHittable {
            app.buttons["Finish"].tap()
            _ = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in self.receipt()["closed"] as? Bool == true }, object: nil)], timeout: 10)
        }
        app.terminate()
    }
    func testHostRoute() {
        start()
        let session = receipt()["session"] as? String
        let initial = message("initial")["stored"] as? Int ?? 0
        point(40, 80).tap()
        wait("Tap before host navigation") { (self.message("tap")["count"] as? Int ?? 0) == initial + 1 }
        action("MiniDetail")
        XCTAssertTrue(String(describing: receipt()["state"] ?? "").contains("pages/detail/index"))
        action("PushHost")
        wait("Native host route pushed") { self.receipt()["hostRoute"] as? String == "Other" && self.app.otherElements["other-route"].isHittable }
        action("PopHost")
        wait("Native host route popped") { self.receipt()["hostRoute"] as? String == "Embedded" && self.surface.isHittable }
        action("Inspect")
        XCTAssertEqual(receipt()["session"] as? String, session)
        XCTAssertTrue(String(describing: receipt()["state"] ?? "").contains("pages/detail/index"))
        point(40, 80).tap()
        wait("Page state survived native host push/pop") { (self.message("tap")["count"] as? Int ?? 0) == initial + 2 }
        XCTAssertNil(receipt()["nativeError"])
    }
    func testNestedScroll() {
        start()
        let area = app.otherElements["parent-drag-area"]
        let origin = area.coordinate(withNormalizedOffset: .zero)
        origin.withOffset(CGVector(dx: 180, dy: 95)).press(forDuration: 0.05, thenDragTo: origin.withOffset(CGVector(dx: 180, dy: 15)))
        wait("Host parent area scrolls") { (self.receipt()["parentOffset"] as? Double ?? 0) > 30 }
        action("ResetParent")
        wait("Host scroll reset") { abs(self.receipt()["parentOffset"] as? Double ?? 0) < 1 }
        let geometry = message("geometry")["scroll"] as? [String: Any] ?? [:]
        let x = (geometry["left"] as? Double ?? 28) + 50
        let y = (geometry["top"] as? Double ?? 124) + 130
        point(x, y).press(forDuration: 0.05, thenDragTo: point(x, y - 100))
        wait("Embedded mini-program scroll consumes its own drag") { (self.message("scroll")["scrollTop"] as? Double ?? 0) > 30 }
        XCTAssertLessThan(abs(receipt()["parentOffset"] as? Double ?? 0), 1, "Parent must not steal a drag that began in the native mini-program")
        XCTAssertGreaterThan(events("touchstart"), 0)
        XCTAssertGreaterThan(events("touchend"), 0)
        XCTAssertNil(receipt()["nativeError"])
    }
    func testTouchCancellationOnHostPush() {
        start()
        let initial = message("initial")["stored"] as? Int ?? 0
        let cancelled = events("touchcancel")
        action("ArmPush")
        point(40, 80).press(forDuration: 1.3)
        wait("Host route pushed while finger was down") { self.receipt()["hostRoute"] as? String == "Other" }
        wait("Native touch cancelled at route boundary") { self.events("touchcancel") > cancelled }
        XCTAssertNil(message("tap")["count"], "A cancelled native touch cannot become a tap")
        action("PopHost")
        wait("Host route returns after cancellation") { self.receipt()["hostRoute"] as? String == "Embedded" && self.surface.isHittable }
        point(40, 80).tap()
        wait("A fresh touch works after cancellation") { (self.message("tap")["count"] as? Int ?? 0) == initial + 1 }
        XCTAssertNil(receipt()["nativeError"])
    }
}
