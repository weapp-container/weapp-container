import CryptoKit
import Foundation
import UIKit
import XCTest

/// Actions enter UIKit through Apple's UI automation. AX is an observation
/// channel only; this runner has no runtime bridge or synthetic input API.
@MainActor
final class WeappContainerUITests: XCTestCase {
    private var report: [String: Any] = [:]
    private var steps: [[String: Any]] = []
    private var originalOrientation: UIDeviceOrientation?
    private var originalInterfaceOrientation: UIInterfaceOrientation?
    private var originalViewport: CGSize?
    private var observedApp: XCUIApplication?
    private var observedSurface: XCUIElement?
    private var orientationMutated = false
    private let surfaceIdentifier = "weapp-container-surface"
    private var cache: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
    }
    private enum Failure: Error { case contract(String) }

    override func setUpWithError() throws {
        continueAfterFailure = false
        let environment = ProcessInfo.processInfo.environment
        guard let target = environment["WEAPP_CONTAINER_UI_TARGET_BUNDLE_ID"],
              let session = environment["WEAPP_CONTAINER_UI_SESSION_ID"], !session.isEmpty else {
            throw Failure.contract("explicit target bundle and session identity required")
        }
        report = ["schemaVersion": 1, "status": "running", "evidenceBoundary": "xctest-os-interaction",
                  "targetBundleId": target, "runnerBundleId": Bundle.main.bundleIdentifier ?? "",
                  "runnerPid": ProcessInfo.processInfo.processIdentifier,
                  "sessionId": session, "surfaceIdentifier": surfaceIdentifier,
                  "startedAtUnixMs": now(), "orientationRestored": false, "actions": [:]]
        try persist()
    }

    override func tearDownWithError() throws {
        if orientationMutated, let orientation = originalOrientation {
            XCUIDevice.shared.orientation = orientation
            let observation: [String: Any]?
            if let app = observedApp, let surface = observedSurface {
                observation = try? waitSurface(app, surface, timeout: 5) { self.isOriginalOrientation($0) }
            } else { observation = nil }
            let restored = observation != nil
            report["orientationRestored"] = restored
            if !restored { report["status"] = "failed"; report["restorationError"] = "borrowed simulator orientation did not restore" }
        }
        // hasSucceeded is not final until teardown returns. Record failures
        // observed so far; the harness separately requires xcodebuild exit 0.
        if let run = testRun {
            report["recordedFailureCount"] = run.totalFailureCount
            if run.totalFailureCount > 0 { report["status"] = "failed" }
        } else {
            report["status"] = "failed"
            report["error"] = "XCTest run identity is unavailable during teardown"
        }
        report["finishedAtUnixMs"] = now()
        try persist()
    }

    func testNativeInteraction() throws {
        do {
            let target = report["targetBundleId"] as! String
            let app = XCUIApplication(bundleIdentifier: target)
            observedApp = app
            app.launch()
            let surface = app.otherElements[surfaceIdentifier]
            observedSurface = surface
            try require(surface.waitForExistence(timeout: 15), "surface AX anchor did not appear")
            let initial = try waitSurface(app, surface) { value in
                self.page(value, "count") == 0 && self.page(value, "timerCount") == 0 && self.page(value, "microtaskCount") == 0
            }
            report["targetPid"] = initial["pid"]
            try require(!(lifecycle(initial).contains("page:hide")), "launch emitted an artificial hide")
            let interface = try interfaceOrientation(initial)
            let device = try deviceOrientation(for: interface)
            originalInterfaceOrientation = interface
            originalOrientation = device
            originalViewport = viewport(initial)
            report["initialOrientation"] = ["source": "UIWindowScene.interfaceOrientation",
                "deviceSensorRawValue": XCUIDevice.shared.orientation.rawValue,
                "interfaceRawValue": interface.rawValue, "restoreDeviceRawValue": device.rawValue]
            try record("initial", app: app, surface: surface, value: initial)

            action("tap", ["api": "XCUICoordinate.tap", "logicalX": 40, "logicalY": 40])
            surface.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 40, dy: 40)).tap()
            let tapped = try waitSurface(app, surface) { self.page($0, "count") == 1 }
            try record("tap", app: app, surface: surface, value: tapped)
            let timer = try waitSurface(app, surface) {
                self.page($0, "count") == 1 && self.page($0, "timerCount") == 1 && self.page($0, "microtaskCount") == 1
            }
            try record("timer", app: app, surface: surface, value: timer)

            action("home", ["api": "XCUIDevice.press(home)"])
            XCUIDevice.shared.press(.home)
            try require(wait(10) { app.state == .runningBackground || app.state == .runningBackgroundSuspended },
                        "Home did not background the existing app")
            try record("background", app: app)

            action("resume", ["api": "XCUIApplication.activate"])
            app.activate() // launch() would terminate and recreate the original session.
            let resumed = try waitSurface(app, surface) { value in
                let trace = self.lifecycle(value)
                guard let hide = trace.firstIndex(of: "page:hide") else { return false }
                return trace.dropFirst(hide + 1).contains("page:show") && self.page(value, "count") == 1
                    && self.page(value, "timerCount") == 1 && self.page(value, "microtaskCount") == 1
            }
            try record("resumed", app: app, surface: surface, value: resumed)

            let previous = viewport(initial)
            let nextInterface: UIInterfaceOrientation = interface.isPortrait ? .landscapeLeft : .portrait
            let nextOrientation = try deviceOrientation(for: nextInterface)
            action("rotate", ["api": "XCUIDevice.orientation", "fromInterfaceRawValue": interface.rawValue,
                              "toInterfaceRawValue": nextInterface.rawValue, "deviceRawValue": nextOrientation.rawValue])
            orientationMutated = true
            XCUIDevice.shared.orientation = nextOrientation
            let rotated = try waitSurface(app, surface) { value in
                let size = self.viewport(value)
                return (try? self.interfaceOrientation(value)) == nextInterface
                    && abs(size.width - previous.width) > 1 && abs(size.height - previous.height) > 1
            }
            try record("rotated", app: app, surface: surface, value: rotated)

            action("restore", ["api": "XCUIDevice.orientation", "interfaceRawValue": interface.rawValue, "deviceRawValue": device.rawValue])
            XCUIDevice.shared.orientation = device
            let restored = try waitSurface(app, surface) { self.isOriginalOrientation($0) }
            orientationMutated = false
            report["orientationRestored"] = true
            try record("restored", app: app, surface: surface, value: restored)
            report["status"] = "passed"
            try persist()
        } catch {
            report["status"] = "failed"
            report["error"] = String(describing: error)
            try? persist()
            throw error
        }
    }

    private func waitSurface(_ app: XCUIApplication, _ surface: XCUIElement,
                             timeout: TimeInterval = 15,
                             condition: @escaping ([String: Any]) -> Bool) throws -> [String: Any] {
        var observed: [String: Any] = [:]
        let succeeded = wait(timeout) {
            guard app.state == .runningForeground, surface.exists,
                  let text = surface.value as? String, let data = text.data(using: .utf8),
                  let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
            observed = value
            guard value["schemaVersion"] as? Int == 1, value["sessionId"] as? String == self.report["sessionId"] as? String,
                  value["foreground"] as? Bool == true, value["closed"] as? Bool == false, value["failed"] as? Bool == false,
                  let frame = value["frameId"] as? UInt64, frame > 0,
                  value["presentedFrameId"] as? UInt64 == frame,
                  let pid = value["pid"] as? Int, pid > 0 else { return false }
            if let expected = self.report["targetPid"] as? Int, pid != expected { return false }
            let size = self.viewport(value)
            guard abs(size.width - surface.frame.width) <= 1, abs(size.height - surface.frame.height) <= 1 else { return false }
            return condition(value)
        }
        try require(succeeded, "bounded surface observation failed; last value: \(observed)")
        return observed
    }

    private func wait(_ seconds: TimeInterval, _ condition: @escaping () -> Bool) -> Bool {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in condition() }, object: nil)
        return XCTWaiter.wait(for: [expectation], timeout: seconds) == .completed
    }

    private func page(_ value: [String: Any], _ key: String) -> Int? {
        (value["pageData"] as? [String: Any])?[key] as? Int
    }
    private func lifecycle(_ value: [String: Any]) -> [String] {
        (value["pageData"] as? [String: Any])?["lifecycleTrace"] as? [String] ?? []
    }
    private func viewport(_ value: [String: Any]) -> CGSize {
        let size = value["viewport"] as? [String: Any] ?? [:]
        return CGSize(width: size["width"] as? Double ?? 0, height: size["height"] as? Double ?? 0)
    }
    private func interfaceOrientation(_ value: [String: Any]) throws -> UIInterfaceOrientation {
        guard let raw = value["interfaceOrientation"] as? Int,
              let orientation = UIInterfaceOrientation(rawValue: raw),
              [.portrait, .landscapeLeft, .landscapeRight].contains(orientation) else {
            throw Failure.contract("window interface orientation is unknown or unsupported; cannot safely restore")
        }
        return orientation
    }
    private func deviceOrientation(for interface: UIInterfaceOrientation) throws -> UIDeviceOrientation {
        switch interface {
        case .portrait: return .portrait
        case .landscapeLeft: return .landscapeRight
        case .landscapeRight: return .landscapeLeft
        default: throw Failure.contract("window interface orientation has no supported exact device mapping")
        }
    }
    private func isOriginalOrientation(_ value: [String: Any]) -> Bool {
        guard let interface = originalInterfaceOrientation, let initial = originalViewport,
              (try? interfaceOrientation(value)) == interface else { return false }
        let size = viewport(value)
        return abs(size.width - initial.width) <= 1 && abs(size.height - initial.height) <= 1
    }
    private func require(_ value: Bool, _ message: String) throws { if !value { throw Failure.contract(message) } }
    private func now() -> Double { Date().timeIntervalSince1970 * 1_000 }
    private func action(_ name: String, _ value: [String: Any]) {
        var actions = report["actions"] as? [String: Any] ?? [:]
        actions[name] = value.merging(["issuedAtUnixMs": now()]) { _, rhs in rhs }
        report["actions"] = actions
    }
    private func record(_ phase: String, app: XCUIApplication, surface: XCUIElement? = nil, value: [String: Any]? = nil) throws {
        let image = XCUIScreen.main.screenshot()
        let bytes = image.pngRepresentation
        let folder = cache.appendingPathComponent("screenshots", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = "screenshots/\(phase).png"
        try bytes.write(to: cache.appendingPathComponent(file), options: .atomic)
        var step: [String: Any] = ["phase": phase, "atUnixMs": now(), "appState": app.state.rawValue,
            "deviceSensorRawValue": XCUIDevice.shared.orientation.rawValue,
            "screenshot": ["file": file, "sha256": SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()]]
        if let surface, let value {
            step["surface"] = value
            step["surfaceFrame"] = ["x": surface.frame.minX, "y": surface.frame.minY, "width": surface.frame.width, "height": surface.frame.height]
        }
        steps.append(step)
        try persist()
        XCTContext.runActivity(named: "Weapp Container OS phase: \(phase)") { activity in
            let attachment = XCTAttachment(data: try! JSONSerialization.data(withJSONObject: step, options: [.sortedKeys]), uniformTypeIdentifier: "public.json")
            attachment.name = phase + ".json"
            attachment.lifetime = .keepAlways
            activity.add(attachment)
            let screenshot = XCTAttachment(screenshot: image)
            screenshot.name = phase + ".png"
            screenshot.lifetime = .keepAlways
            activity.add(screenshot)
        }
    }
    private func persist() throws {
        report["steps"] = steps
        try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
            .write(to: cache.appendingPathComponent("weapp-ios-ui-test-report.json"), options: .atomic)
    }
}
