import Foundation
import Metal
import QuartzCore
import WeappContainerHost

private func require(_ label: String, _ value: (status: Int32, response: Data)) throws {
    let text = String(data: value.response, encoding: .utf8) ?? ""
    print("WEAPP_CONTAINER_IOS_SMOKE \(label) status=\(value.status) bytes=\(value.response.count) json=\(text)")
    guard value.status == 0, !value.response.isEmpty else {
        throw NSError(domain: "WeappContainerSmoke", code: Int(value.status), userInfo: [NSLocalizedDescriptionKey: "\(label) failed: \(text)"])
    }
}

let host = WeappContainerHost()
// This creates and queries the platform Metal device only. It does not attach
// Metal to the Rust renderer; the report intentionally keeps
// `containerSurfaceAttached` false until an app-owned CAMetalLayer adapter
// drives the host surface.
if let device = MTLCreateSystemDefaultDevice() {
    let software = device.name.localizedCaseInsensitiveContains("software")
        || device.name.localizedCaseInsensitiveContains("simulator")
    let probe: [String: Any] = [
        "schemaVersion": 1,
        "source": "ios-metal",
        "status": "passed",
        "contextCreated": true,
        "hardwareAccelerated": !software,
        "vendor": "Apple",
        "renderer": device.name,
        "containerSurfaceAttached": false,
        "evidenceBoundary": "device-context-only",
    ]
    let bytes = try! JSONSerialization.data(withJSONObject: probe, options: [])
    print("WEAPP_CONTAINER_GPU_PROBE \(String(data: bytes, encoding: .utf8)!)")
} else {
    print("WEAPP_CONTAINER_GPU_PROBE {\"schemaVersion\":1,\"source\":\"ios-metal\",\"status\":\"blocked\",\"contextCreated\":false,\"hardwareAccelerated\":false,\"containerSurfaceAttached\":false,\"evidenceBoundary\":\"device-context-only\",\"reason\":\"MTLCreateSystemDefaultDevice returned nil\"}")
}
do {
    try require("capabilities", host.capabilities())
    guard let directory = Bundle.module.url(forResource: "portable-pack", withExtension: nil) else {
        throw NSError(domain: "WeappContainerSmoke", code: 1, userInfo: [NSLocalizedDescriptionKey: "bundled portable-pack missing"])
    }
    let pack = try WeappPortablePack(directory: directory)
    let startup = try pack.start(on: host)
    for operation in ["app.init", "app.lifecycle", "page.push", "render.commit"] {
        try require(operation, (status: 0, response: startup.operations[operation]!))
    }
    guard startup.diagnostics.allSatisfy({ $0["op"] as? String != "error" }) else {
        throw NSError(domain: "WeappContainerSmoke", code: 1, userInfo: [NSLocalizedDescriptionKey: "post-publication runtime errors: \(startup.diagnostics)"])
    }
    print("WEAPP_CONTAINER_IOS_PACK route=\(startup.route) integrityRoot=\(startup.integrityRoot)")
    try require("render.snapshot", host.renderSnapshot())
} catch {
    print("WEAPP_CONTAINER_IOS_SMOKE startup failed: \(error)")
    exit(1)
}

// The standalone smoke owns a real CAMetalLayer object but has no UIView/window
// hierarchy. CoreAnimation may therefore refuse a drawable on a headless
// launch; that outcome is recorded as blocked. An app embedding this package
// should pass the CAMetalLayer from its view and receive the same direct Skia
// probe after the drawable is presented. The software Rust snapshot never
// upgrades the container GPU gate by itself.
let layer = CAMetalLayer()
layer.frame = CGRect(x: 0, y: 0, width: 2, height: 2)
do {
    let presenter = try MetalSnapshotPresenter(layer: layer)
    // This is the authoritative iOS GPU path: Rust owns the Skia Ganesh
    // Metal context and renders the committed frame directly into the
    // CAMetalLayer drawable. A readable snapshot upload is not used as a
    // substitute for this evidence boundary.
    try presenter.attach(runtime: host)
    let probe = try presenter.present(runtime: host)
    let bytes = try JSONSerialization.data(withJSONObject: probe.jsonObject(), options: [])
    print("WEAPP_CONTAINER_SURFACE_PROBE \(String(data: bytes, encoding: .utf8)!)")
    try presenter.detach(runtime: host)
} catch {
    let blocked: [String: Any] = [
        "schemaVersion": 1,
        "source": "ios-skia-metal-layer",
        "status": "blocked",
        "hostSurfaceAttached": false,
        "containerSurfaceAttached": false,
        "gpuSurface": false,
        "rendererBackend": "software-fallback",
        "evidenceBoundary": "rust-skia-metal-drawable",
        "reason": String(describing: error),
    ]
    let bytes = try! JSONSerialization.data(withJSONObject: blocked, options: [])
    print("WEAPP_CONTAINER_SURFACE_PROBE \(String(data: bytes, encoding: .utf8)!)")
}

let canvas = """
{"protocolVersion":"1.0","sessionId":"session-1","requestId":"canvas-1","kind":"request","op":"api.call","payload":{"name":"wx.canvas.draw","canvasId":"main","width":1,"height":1,"commands":[{"op":"setFillStyle","args":["#0a141e"]},{"op":"fillRect","args":[0,0,1,1]}]}}
""".data(using: .utf8)!
try require("canvas.draw", host.dispatch(canvas))
try require("canvas.snapshot", host.canvasSnapshot(canvasID: "main"))

let api = """
{"protocolVersion":"1.0","sessionId":"session-1","requestId":"api-1","kind":"request","op":"api.call","payload":{"name":"wx.canIUse","capability":"wx.getStorage"}}
""".data(using: .utf8)!
try require("api.call", host.dispatch(api))
