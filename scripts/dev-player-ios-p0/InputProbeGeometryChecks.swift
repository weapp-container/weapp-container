import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// Host-only numerical checks. No XCTest, simulator, application, or IO driver.
@main
enum InputProbeGeometryChecks {
    struct Failure: Error { let message: String }
    static var passed: [String] = []

    static func expect(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
        let result = try condition()
        if !result { throw Failure(message: message) }
    }
    static func check(_ name: String, _ body: () throws -> Void) throws {
        do { try body(); passed.append(name) }
        catch { throw Failure(message: name + ": " + String(describing: error)) }
    }
    static func rejected(_ expected: InputProbeGeometryError, _ body: () throws -> Void) throws {
        do { try body() }
        catch let error as InputProbeGeometryError {
            try expect(error == expected, "Unexpected refusal: \(error), expected \(expected)"); return
        }
        throw Failure(message: "Unsafe geometry was accepted: \(expected)")
    }
    static func main() throws {
        let app = CGRect(x: 0, y: 0, width: 375, height: 667)
        let surface = CGRect(x: 0, y: 64, width: 375, height: 555)
        let selector = CGRect(x: 20, y: 10, width: 80, height: 40)
        func capture(_ app: CGRect = app, _ surface: CGRect = surface,
                     _ selector: CGRect = selector, content: CGRect? = nil) throws -> InputProbeGeometry {
            try InputProbeGeometry(applicationFrame: app, surfaceFrame: surface,
                                   contentFrame: content ?? surface, selectorRect: selector)
        }
        try check("portrait-logical-screen-point-with-chrome") {
            let probe = try capture()
            try expect(probe.screenPoint == CGPoint(x: 60, y: 94), "Status-bar/chrome offset was lost or applied twice")
            try expect(try probe.applicationOffset(currentApplicationFrame: app) == CGPoint(x: 60, y: 94), "Wrong app anchor offset")
        }
        try check("nonzero-application-and-surface-origins") {
            let window = CGRect(x: 100, y: 200, width: 700, height: 800)
            let view = CGRect(x: 120, y: 244, width: 660, height: 700)
            let local = CGRect(x: 10, y: 20, width: 30, height: 40)
            let probe = try capture(window, view, local)
            try expect(probe.screenPoint == CGPoint(x: 145, y: 284), "Screen point used window-relative geometry")
            try expect(try probe.applicationOffset(currentApplicationFrame: window) == CGPoint(x: 45, y: 84), "Nonzero window origin was added twice")
        }
        try check("landscape-uses-unscaled-native-points") {
            let window = CGRect(x: 0, y: 0, width: 667, height: 375)
            let view = CGRect(x: 0, y: 44, width: 667, height: 287)
            let probe = try capture(window, view, selector)
            try expect(probe.screenPoint == CGPoint(x: 60, y: 74), "Landscape point was scaled")
        }
        try check("dpr-does-not-scale-screen-input") {
            for pixelRatio in [1.0, 2.0, 3.0] {
                let probe = try capture()
                let displayPixels = CGPoint(x: probe.screenPoint.x * pixelRatio, y: probe.screenPoint.y * pixelRatio)
                try expect(probe.screenPoint == CGPoint(x: 60, y: 94), "DPR leaked into input geometry")
                if pixelRatio != 1 { try expect(probe.screenPoint != displayPixels, "Device pixels used as screen points") }
            }
        }
        try check("frozen-values-survive-view-removal-or-mutation") {
            var view = surface, target = selector
            let probe = try capture(app, view, target)
            view = .null; target.origin = CGPoint(x: 300, y: 400)
            try expect(probe.surfaceFrame == surface && probe.selectorRect == selector, "Probe retained mutable source geometry")
            try expect(try probe.applicationOffset(currentApplicationFrame: app) == CGPoint(x: 60, y: 94), "Frozen point needed removed view")
        }
        try check("edge-aligned-visible-selector-is-valid") {
            let probe = try capture(app, surface, CGRect(x: 365, y: 545, width: 10, height: 10))
            try expect(probe.screenPoint == CGPoint(x: 370, y: 614), "Last visible target was displaced")
        }
        try check("application-nan-infinity-and-degenerate-refused") {
            for invalid in [CGRect.null, CGRect.infinite, CGRect(x: CGFloat.nan, y: 0, width: 375, height: 667),
                            CGRect(x: 0, y: 0, width: 0, height: 667), CGRect(x: 0, y: 0, width: -375, height: 667)] {
                try rejected(.invalidApplicationFrame) { _ = try capture(invalid) }
            }
        }
        try check("surface-nan-infinity-and-degenerate-refused") {
            for invalid in [CGRect.null, CGRect.infinite, CGRect(x: 0, y: CGFloat.nan, width: 375, height: 555),
                            CGRect(x: 0, y: 64, width: 375, height: 0), CGRect(x: 0, y: 64, width: 375, height: -1)] {
                try rejected(.invalidSurfaceFrame) { _ = try capture(app, invalid) }
            }
        }
        try check("selector-nan-infinity-and-degenerate-refused") {
            for invalid in [CGRect.null, CGRect.infinite, CGRect(x: 0, y: 0, width: CGFloat.nan, height: 20),
                            CGRect(x: 0, y: 0, width: 0, height: 20), CGRect(x: 0, y: 0, width: 80, height: -1)] {
                try rejected(.invalidSelectorRect) { _ = try capture(app, surface, invalid) }
            }
        }
        try check("surface-outside-window-refused") {
            for invalid in [CGRect(x: -1, y: 64, width: 375, height: 555), CGRect(x: 0, y: 113, width: 375, height: 555)] {
                try rejected(.surfaceOutsideApplication) { _ = try capture(app, invalid) }
            }
        }
        try check("partially-clipped-selector-refused-even-with-center-inside") {
            for invalid in [CGRect(x: -1, y: 10, width: 80, height: 40), CGRect(x: 340, y: 10, width: 70, height: 40),
                            CGRect(x: 20, y: -1, width: 80, height: 40), CGRect(x: 20, y: 540, width: 80, height: 30)] {
                try rejected(.selectorOutsideSurface) { _ = try capture(app, surface, invalid) }
            }
        }
        try check("accepted-content-frame-mismatch-refused") {
            for invalid in [CGRect(x: 0, y: 20, width: 375, height: 555), CGRect(x: 0, y: 64, width: 750, height: 1110)] {
                try rejected(.contentFrameMismatch) { _ = try capture(content: invalid) }
            }
        }
        try check("invalid-content-frame-refused") {
            try rejected(.invalidContentFrame) { _ = try capture(content: .null) }
        }
        try check("rounding-cannot-place-probe-outside-accepted-content") {
            try rejected(.screenPointOutsideContent) {
                _ = try capture(app, surface, CGRect(x: 0, y: 0, width: 1, height: 1),
                                content: CGRect(x: 1, y: 64, width: 374, height: 555))
            }
        }
        try check("subpoint-native-rounding-preserves-the-screen-point") {
            let probe = try capture()
            let window = CGRect(x: 0.25, y: 0.25, width: 375, height: 667)
            let offset = try probe.applicationOffset(currentApplicationFrame: window)
            try expect(CGPoint(x: offset.x + window.minX, y: offset.y + window.minY) == probe.screenPoint,
                       "Permitted frame rounding retargeted the screen point")
        }
        try check("moved-resized-or-rotated-window-refused") {
            let probe = try capture()
            for moved in [CGRect(x: 1, y: 0, width: 375, height: 667), CGRect(x: 0, y: 1, width: 375, height: 667),
                          CGRect(x: 0, y: 0, width: 376, height: 667), CGRect(x: 0, y: 0, width: 667, height: 375), .null] {
                try rejected(.applicationFrameChanged) { _ = try probe.applicationOffset(currentApplicationFrame: moved) }
            }
        }
        try check("evidence-is-serializable-and-retains-original-geometry") {
            let probe = try capture()
            let bytes = try JSONSerialization.data(withJSONObject: probe.evidence)
            let record = try JSONSerialization.jsonObject(with: bytes) as! [String: Any]
            try expect(record["surfaceFrame"] != nil && record["acceptedContentFrame"] != nil
                       && record["screenPoint"] != nil && record["applicationOffset"] != nil, "Probe evidence lost measurement fields")
        }
        let report: [String: Any] = ["schemaVersion": 1, "status": "passed", "checks": passed,
                                   "count": passed.count, "simulatorUsed": false]
        print(String(decoding: try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), as: UTF8.self))
    }
}
