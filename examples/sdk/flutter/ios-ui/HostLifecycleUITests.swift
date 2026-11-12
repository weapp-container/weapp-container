import XCTest

final class FlutterSDKHostLifecycleUITests: XCTestCase {
    let app = XCUIApplication(bundleIdentifier: "__SDK_BUNDLE_ID__")

    func report() -> [String: Any] {
        let status = app.descendants(matching: .any).matching(NSPredicate(
            format: "label BEGINSWITH %@ AND label CONTAINS %@", "{", "\"controllerId\":"
        )).firstMatch
        guard status.exists, let data = status.label.data(using: .utf8),
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return value
    }

    @discardableResult
    func wait(_ description: String, until condition: @escaping ([String: Any]) -> Bool) -> [String: Any] {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            let value = self.report()
            return value["status"] as? String == "failed" || condition(value)
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: 45), .completed,
                       description + ": " + String(describing: report()))
        let value = report()
        XCTAssertNotEqual(value["status"] as? String, "failed", String(describing: value))
        return value
    }

    func capture(_ name: String) {
        let image = XCTAttachment(screenshot: app.screenshot())
        image.name = name; image.lifetime = .keepAlways; add(image)
    }

    func number(_ object: [String: Any], _ key: String) throws -> Double {
        try XCTUnwrap(object[key] as? NSNumber, key).doubleValue
    }

    func point(_ value: [String: Any], x: Double, y: Double) throws -> XCUICoordinate {
        let origin = try XCTUnwrap(value["viewOrigin"] as? [String: Any])
        let size = try XCTUnwrap(value["viewSize"] as? [String: Any])
        let geometry = try XCTUnwrap(value["geometry"] as? [String: Any])
        return app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(
            dx: try number(origin, "x") + x * number(size, "width") / number(geometry, "windowWidth"),
            dy: try number(origin, "y") + y * number(size, "height") / number(geometry, "windowHeight")
        ))
    }

    func testHostNavigationAndParentScrolling() throws {
        continueAfterFailure = false
        let original = XCUIDevice.shared.orientation
        defer { app.terminate(); XCUIDevice.shared.orientation = original }
        XCUIDevice.shared.orientation = .portrait
        app.launch()
        let initial = wait("Public view attached") { $0["stage"] as? String == "scroll-parent-then-check" && $0["geometry"] != nil }
        let origin = try XCTUnwrap(initial["viewOrigin"] as? [String: Any])
        let size = try XCTUnwrap(initial["viewSize"] as? [String: Any])
        let x = try number(origin, "x") + number(size, "width") / 2
        let y = try number(origin, "y")
        let zero = app.coordinate(withNormalizedOffset: .zero)
        capture("host-initial")
        zero.withOffset(CGVector(dx: x, dy: y - 30)).press(forDuration: 0.1,
            thenDragTo: zero.withOffset(CGVector(dx: x, dy: y - 110)),
            withVelocity: XCUIGestureVelocity(rawValue: 80), thenHoldForDuration: 1)
        var lastOffset = -1.0
        var stableSince = Date()
        wait("Flutter parent received the outside drag and stopped moving") { value in
            let offset = (value["parentOffset"] as? NSNumber)?.doubleValue ?? 0
            if abs(offset - lastOffset) > 0.5 {
                lastOffset = offset
                stableSince = Date()
            }
            return offset >= 20 && Date().timeIntervalSince(stableSince) >= 1.5
        }
        app.buttons["Check parent"].tap()
        let tapped = wait("Inspect moved child") { $0["stage"] as? String == "click-child-after-parent-scroll" }
        let geometry = try XCTUnwrap(tapped["geometry"] as? [String: Any])
        let tap = try XCTUnwrap(geometry["tap"] as? [String: Any])
        let movedOrigin = try XCTUnwrap(tapped["viewOrigin"] as? [String: Any])
        // Keep the embedded target below the host app bar. A fling can move
        // it under that bar even though the native view remains attached.
        XCTAssertGreaterThan(try number(movedOrigin, "y"), 120)
        try point(tapped, x: number(tap, "x"), y: number(tap, "y")).tap()
        let child = wait("Native tap at moved coordinates") { $0["stage"] as? String == "scroll-child" }
        let scroll = try XCTUnwrap((child["geometry"] as? [String: Any])?["scroll"] as? [String: Any])
        let sx = try number(scroll, "left") + number(scroll, "width") / 2
        let sy = try number(scroll, "top"), height = try number(scroll, "height")
        try point(child, x: sx, y: sy + height * 0.8).press(forDuration: 0.1,
            thenDragTo: point(child, x: sx, y: sy + height * 0.2))
        let scrolled = wait("Child owns its drag") { $0["stage"] as? String == "move-route" }
        XCTAssertEqual((scrolled["issues"] as? [String])?.count, 0)
        capture("host-child-scroll")
        app.buttons["Move route"].tap()
        // The primary route's semantics are hidden by Navigator. Wait on the
        // real second route; the final report also requires its attachment and
        // retirement history before it can reach ready-to-close.
        XCTAssertTrue(app.staticTexts["SDK on second Flutter route"].waitForExistence(timeout: 45))
        let back = app.buttons["Back"].firstMatch
        XCTAssertTrue(back.waitForExistence(timeout: 45))
        capture("host-second-route")
        back.tap()
        wait("Return preserves session and generation") { $0["stage"] as? String == "ready-to-close" }
        app.buttons["Close SDK"].tap()
        let result = wait("All presentation ownership retired") { $0["stage"] as? String == "complete" }
        XCTAssertEqual(result["status"] as? String, "passed")
        XCTAssertEqual((result["checks"] as? [String])?.count, 8)
        XCTAssertEqual(result["closed"] as? Bool, true)
        XCTAssertEqual((result["platformViewCount"] as? NSNumber)?.intValue, 0)
        capture("host-complete")
    }
}
