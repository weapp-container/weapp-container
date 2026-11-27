import XCTest

final class ConsumerUITests: XCTestCase {
    func testHostCallsAndReopen() {
        let app = XCUIApplication(bundleIdentifier: "dev.weapp.vendor")
        app.launch()
        let ready = app.staticTexts.matching(NSPredicate(format: "identifier == %@ AND label == %@", "host-status", "Ready")).firstMatch
        XCTAssertTrue(ready.waitForExistence(timeout: 20))
        let surface = app.otherElements["mini-program"]
        XCTAssertTrue(surface.waitForExistence(timeout: 10))
        let profile = surface.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.26))
        profile.tap()
        XCTAssertTrue(app.staticTexts["Profile returned"].waitForExistence(timeout: 10))
        app.buttons["Reject profile"].tap()
        XCTAssertTrue(app.buttons["Allow profile"].exists)
        profile.tap()
        XCTAssertTrue(app.staticTexts["Profile rejected"].waitForExistence(timeout: 10))
        app.buttons["Reopen"].tap()
        XCTAssertTrue(ready.waitForExistence(timeout: 20))
        profile.tap()
        XCTAssertTrue(app.staticTexts["Profile rejected"].waitForExistence(timeout: 10))
        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertTrue(app.staticTexts["Profile rejected"].exists)
    }
}
