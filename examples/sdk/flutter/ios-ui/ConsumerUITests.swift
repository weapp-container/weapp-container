import XCTest

final class FlutterSDKConsumerUITests: XCTestCase {
    let app = XCUIApplication(bundleIdentifier: "__SDK_BUNDLE_ID__")
    var status: XCUIElement { app.descendants(matching: .any).matching(identifier: "sdk-status").firstMatch }

    func report() -> [String: Any] {
        guard status.exists else { return [:] }
        for text in [status.label, status.value as? String ?? ""] {
            if let bytes = text.data(using: .utf8),
               let value = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] { return value }
        }
        return [:]
    }

    func wait(_ description: String, seconds: Double = 45, until condition: @escaping ([String: Any]) -> Bool) {
        let predicate = NSPredicate { _, _ in
            let value = self.report()
            return value["status"] as? String == "failed" || condition(value)
        }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: seconds), .completed, description + ": " + String(describing: report()))
        XCTAssertNotEqual(report()["status"] as? String, "failed", String(describing: report()))
    }

    func capture(_ name: String) {
        let image = XCTAttachment(screenshot: app.screenshot())
        image.name = name; image.lifetime = .keepAlways; add(image)
    }

    func testInstalledFlutterPlatformView() throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
        if __SDK_ACTIVATE_EXISTING__ {
            XCTAssertNotEqual(app.state, .notRunning, "Hot-restarted consumer must still be running")
            app.activate()
        } else {
            app.launch()
        }
        wait("Shared pack initialized") { $0["stage"] as? String == "ready-for-input" }
        let geometry = try XCTUnwrap(report()["geometry"] as? [String: Any])
        let origin = try XCTUnwrap(geometry["viewOrigin"] as? [String: Any])
        let tap = try XCTUnwrap(geometry["tap"] as? [String: Any])
        let scroll = try XCTUnwrap(geometry["scroll"] as? [String: Any])
        func number(_ object: [String: Any], _ key: String) throws -> Double {
            try XCTUnwrap(object[key] as? NSNumber, key).doubleValue
        }
        let ox = try number(origin, "x"), oy = try number(origin, "y")
        let zero = app.coordinate(withNormalizedOffset: .zero)
        capture("flutter-installed-native-initial")
        zero.withOffset(CGVector(dx: ox + (try number(tap, "x")), dy: oy + (try number(tap, "y")))).tap()
        wait("UIKit tap reached JavaScript and timer") {
            ($0["tapCount"] as? NSNumber)?.intValue == 1 && $0["timer"] as? Bool == true
        }
        capture("flutter-installed-native-after-tap")
        let x = ox + (try number(scroll, "left")) + (try number(scroll, "width")) / 2
        let y = oy + (try number(scroll, "top")), height = try number(scroll, "height")
        zero.withOffset(CGVector(dx: x, dy: y + height * 0.8)).press(forDuration: 0.1,
            thenDragTo: zero.withOffset(CGVector(dx: x, dy: y + height * 0.2)))
        wait("Native scroll and controller lifecycle contracts completed", seconds: 90) { $0["stage"] as? String == "complete" }
        let result = report()
        XCTAssertEqual(result["status"] as? String, "passed")
        XCTAssertGreaterThan((result["scrollTop"] as? NSNumber)?.doubleValue ?? 0, 0)
        XCTAssertGreaterThanOrEqual((result["checks"] as? [String])?.count ?? 0, 10)
        capture("flutter-installed-consumer-completed")
        app.terminate()
    }
}
