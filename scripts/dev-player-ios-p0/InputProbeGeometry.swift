import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

enum InputProbeGeometryError: Error, Equatable {
    case invalidApplicationFrame
    case invalidSurfaceFrame
    case invalidContentFrame
    case invalidSelectorRect
    case surfaceOutsideApplication
    case selectorOutsideSurface
    case contentFrameMismatch
    case screenPointOutsideContent
    case applicationFrameChanged
}

/// A value-only measurement captured while the native view is still visible.
/// AX frames and guest selector geometry must already be logical UIKit points;
/// no viewport ratio, device pixel ratio, or later view lookup is involved.
struct InputProbeGeometry {
    let applicationFrame: CGRect
    let surfaceFrame: CGRect
    let contentFrame: CGRect
    let selectorRect: CGRect
    let screenPoint: CGPoint

    init(applicationFrame: CGRect, surfaceFrame: CGRect, contentFrame: CGRect, selectorRect: CGRect) throws {
        guard Self.valid(applicationFrame) else { throw InputProbeGeometryError.invalidApplicationFrame }
        guard Self.valid(surfaceFrame) else { throw InputProbeGeometryError.invalidSurfaceFrame }
        guard Self.valid(contentFrame) else { throw InputProbeGeometryError.invalidContentFrame }
        guard Self.valid(selectorRect) else { throw InputProbeGeometryError.invalidSelectorRect }
        guard Self.contains(applicationFrame, surfaceFrame) else { throw InputProbeGeometryError.surfaceOutsideApplication }
        guard Self.matches(surfaceFrame, contentFrame, tolerance: 1.5) else { throw InputProbeGeometryError.contentFrameMismatch }
        let localSurface = CGRect(origin: .zero, size: surfaceFrame.size)
        guard Self.contains(localSurface, selectorRect) else { throw InputProbeGeometryError.selectorOutsideSurface }
        let point = CGPoint(x: surfaceFrame.minX + selectorRect.midX,
                            y: surfaceFrame.minY + selectorRect.midY)
        guard contentFrame.contains(point) else { throw InputProbeGeometryError.screenPointOutsideContent }
        self.applicationFrame = applicationFrame
        self.surfaceFrame = surfaceFrame
        self.contentFrame = contentFrame
        self.selectorRect = selectorRect
        screenPoint = point
    }

    /// Anchor the saved screen point to the application, which remains present
    /// when the fault intentionally hides the native view from accessibility.
    /// A changed window must fail rather than silently retargeting the probe.
    func applicationOffset(currentApplicationFrame: CGRect) throws -> CGPoint {
        guard Self.valid(currentApplicationFrame),
              Self.matches(currentApplicationFrame, applicationFrame, tolerance: 0.5) else {
            throw InputProbeGeometryError.applicationFrameChanged
        }
        return CGPoint(x: screenPoint.x - currentApplicationFrame.minX,
                       y: screenPoint.y - currentApplicationFrame.minY)
    }

    var evidence: [String: Any] {
        ["coordinateSpace": "UIKit logical screen points",
         "applicationFrame": Self.record(applicationFrame),
         "surfaceFrame": Self.record(surfaceFrame),
         "acceptedContentFrame": Self.record(contentFrame),
         "selectorRect": Self.record(selectorRect),
         "screenPoint": ["x": Double(screenPoint.x), "y": Double(screenPoint.y)],
         "applicationOffset": ["x": Double(screenPoint.x - applicationFrame.minX),
                               "y": Double(screenPoint.y - applicationFrame.minY)],
         "anchor": "XCUIApplication; native surface is not resolved after fault"]
    }

    private static func valid(_ rect: CGRect) -> Bool {
        !rect.isNull && !rect.isInfinite
            && [rect.origin.x, rect.origin.y, rect.size.width, rect.size.height,
         rect.maxX, rect.maxY].allSatisfy { $0.isFinite }
            && rect.size.width > 0 && rect.size.height > 0
    }

    private static func contains(_ outer: CGRect, _ inner: CGRect) -> Bool {
        inner.minX >= outer.minX && inner.minY >= outer.minY
            && inner.maxX <= outer.maxX && inner.maxY <= outer.maxY
    }

    private static func matches(_ left: CGRect, _ right: CGRect, tolerance: CGFloat) -> Bool {
        abs(left.minX - right.minX) <= tolerance && abs(left.minY - right.minY) <= tolerance
            && abs(left.width - right.width) <= tolerance && abs(left.height - right.height) <= tolerance
    }

    private static func record(_ rect: CGRect) -> [String: Double] {
        ["left": Double(rect.minX), "top": Double(rect.minY),
         "width": Double(rect.width), "height": Double(rect.height)]
    }
}
