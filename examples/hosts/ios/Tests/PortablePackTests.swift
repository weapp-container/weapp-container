import Foundation
import CryptoKit

private enum Failure: Error { case assertion(String) }
private func expect(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    if try !condition() { throw Failure.assertion(message) }
}

private final class RecordingRuntime: WeappPortablePackRuntime {
    var loadStatus: Int32 = 0
    var mode = "success"
    var loaded = false
    var requests: [[String: Any]] = []
    var engine = "quickjs"
    var sessionID = "session-1"
    var root = ""
    var moduleCount = 0
    var viewport: [Double] = []
    func loadManifest(_ manifest: Data) -> Int32 {
        loaded = true
        let object = try! JSONSerialization.jsonObject(with: manifest) as! [String: Any]
        root = (object["integrity"] as! [String: Any])["root"] as! String
        moduleCount = (object["modules"] as! [[String: Any]]).count
        return loadStatus
    }
    func loadManifest(_ manifest: Data, engine: String, sessionID: String) -> Int32 {
        self.engine = engine; self.sessionID = sessionID
        return loadManifest(manifest)
    }
    func loadManifest(_ manifest: Data, engine: String, sessionID: String,
                      width: Double, height: Double) -> Int32 {
        viewport = [width, height]
        return loadManifest(manifest, engine: engine, sessionID: sessionID)
    }
    func dispatch(_ bytes: Data) -> (status: Int32, response: Data) {
        let request = try! JSONSerialization.jsonObject(with: bytes) as! [String: Any]
        requests.append(request)
        let operation = request["op"] as! String
        var payload: [String: Any] = ["ok": true]
        if operation == "app.init" {
            payload["engineProviderAvailable"] = mode != "unavailable"
            payload["engine"] = mode == "wrong-engine" ? "other" : engine
            payload["loadedModules"] = mode == "wrong-count" ? 0 : moduleCount
            payload["manifest"] = ["integrity": mode == "wrong-root" ? "other" : root]
        }
        if operation == "render.commit" {
            payload["committed"] = mode != "uncommitted"
            payload["source"] = mode == "explicit-frame" ? "explicit" : "manifest"
            payload["templateId"] = ((request["payload"] as! [String: Any])["templateId"] as! String)
            payload["frameId"] = mode == "wrong-frame" ? 999 : 1
        }
        if mode == "error", operation == "page.push" {
            payload = ["ok": false, "error": ["code": "ERR_UNSUPPORTED_CAPABILITY", "message": "explicit provider failure"]]
        }
        var message: [String: Any] = ["kind": mode == "wrong-kind" ? "event" : "response",
                                      "op": operation, "sessionId": mode == "wrong-session" ? "unrelated" : sessionID,
                                      "requestId": request["requestId"]!, "payload": payload]
        if mode == "wrong-id" { message["requestId"] = "unrelated" }
        var messages = [message]
        if mode == "duplicate" { messages.append(message) }
        if mode == "post-error", operation == "render.commit" {
            messages.append(["kind": "event", "op": "error", "payload": ["code": "ERR_ENGINE", "message": "ready hook failed after publication"]])
        }
        if mode == "sibling-failed", operation == "render.commit" {
            messages.append(["kind": "response", "op": "event.batch", "payload": ["ok": false]])
        }
        let data = try! JSONSerialization.data(withJSONObject: ["messages": messages])
        return (mode == "abi-error" ? -1 : 0, data)
    }
}

@main
private struct PortablePackTests {
    static func main() throws {
        let source = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        let modernSource = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
        var passed = 0
        func test(_ name: String, _ body: () throws -> Void) throws {
            try body(); passed += 1; print("PASS \(name)")
        }
        func withCopy(_ body: (URL) throws -> Void) throws {
            let path = FileManager.default.temporaryDirectory.appendingPathComponent("weapp-ios-pack-" + UUID().uuidString)
            try FileManager.default.copyItem(at: source, to: path)
            defer { try? FileManager.default.removeItem(at: path) }
            try body(path)
        }
        func requireError(_ code: String, _ body: () throws -> Void) throws {
            do { try body(); throw Failure.assertion("expected \(code)") }
            catch let error as WeappPortablePackError { try expect(error.code == code, "unexpected error: \(error)") }
        }
        let pack = try WeappPortablePack(directory: source)
        let modernPack = try WeappPortablePack(directory: modernSource)
        func withModernCopy(_ body: (URL) throws -> Void) throws {
            let path = FileManager.default.temporaryDirectory.appendingPathComponent("weapp-ios-modern-pack-" + UUID().uuidString)
            try FileManager.default.copyItem(at: modernSource, to: path)
            defer { try? FileManager.default.removeItem(at: path) }
            try body(path)
        }
        func canonical(_ value: Any) throws -> String {
            if let object = value as? [String: Any] {
                return "{" + (try object.keys.sorted { $0.utf8.lexicographicallyPrecedes($1.utf8) }.map {
                    try canonical($0) + ":" + canonical(object[$0]!)
                }).joined(separator: ",") + "}"
            }
            if let array = value as? [Any] { return "[" + (try array.map(canonical)).joined(separator: ",") + "]" }
            return String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .withoutEscapingSlashes]), as: UTF8.self)
        }
        func writeManifest(_ manifest: [String: Any], to directory: URL) throws {
            var value = manifest
            value["integrity"] = ["algorithm": "sha256", "root": ""]
            let root = SHA256.hash(data: Data(try canonical(value).utf8)).map { String(format: "%02x", $0) }.joined()
            value["integrity"] = ["algorithm": "sha256", "root": root]
            try Data(try canonical(value).utf8).write(to: directory.appendingPathComponent("manifest.json"))
        }
        // Handwritten graph metadata reuses verified blobs solely to exercise
        // the Swift selection/transport contract, not native WXSS evaluation.
        func styleManifest() -> [String: Any] {
            var value = pack.manifest
            let firstRoute = (value["routes"] as! [[String: Any]])[0]
            value["routes"] = [firstRoute, ["id": "route:pages/settings/index", "path": "pages/settings/index",
                "kind": "page", "entryModule": "pages/settings/index.js", "config": "features/settings.json"]]
            var secondTemplate = (value["templates"] as! [[String: Any]])[0]
            secondTemplate["id"] = "template:pages/settings/index.wxml"
            value["templates"] = (value["templates"] as! [[String: Any]]) + [secondTemplate]
            value["components"] = [
                ["owner": "app.json", "usingComponents": ["shared": "components/shared/index"]],
                ["owner": "pages/home/index.json", "usingComponents": ["counter": "components/counter/index"]],
                ["owner": "components/counter/index.json", "usingComponents": ["label": "components/label/index"]],
                ["owner": "components/label/index.json", "usingComponents": ["cycle": "components/counter/index"]],
                ["owner": "features/settings.json", "usingComponents": ["unrelated": "components/unrelated/index"]],
            ] as [[String: Any]]
            let pointer = (value["styles"] as! [[String: Any]])[0]["wxssIr"] as! String
            let declarations = [("app", "app"), ("pages/home/index", "page"), ("features/settings", "page"),
                ("components/shared/index", "component"), ("components/counter/index", "component"),
                ("components/label/index", "component"), ("components/unrelated/index", "component"),
                ("pages/unused/index", "page")]
            value["styles"] = declarations.map { ["id": "style:" + $0.0 + ".wxss", "scope": $0.1, "wxssIr": pointer] }
            return value
        }
        // Synthetic compilation descriptors isolate host transport/validation.
        // They are not claimed as runtime/compiler conformance evidence.
        func withCompilationCopy(_ body: (URL, [String: String]) throws -> Void) throws {
            try withCopy { directory in
                let sources = ["source": "module.exports={read:function(){return [].constructor;}};",
                               "module": "module.exports={read:function(){return __wcWxs0.read([],\"constructor\");}};",
                               "expression": "__wcWxs0.read(value,\"constructor\")"]
                var digests: [String: String] = [:]
                for (name, text) in sources {
                    let data = Data(text.utf8)
                    let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
                    digests[name] = digest
                    try data.write(to: directory.appendingPathComponent("blobs/sha256/" + digest))
                }
                var manifest = pack.manifest
                let template = (manifest["templates"] as! [[String: Any]])[0]
                manifest["viewCompilation"] = [
                    "compiler": "weapp-container-wxs", "version": "1.0.0", "abi": "1.0",
                    "modules": [["id": "wxs:loader-probe.wxs", "sourceSha256": digests["source"]!,
                                 "executableSha256": digests["module"]!, "helper": "__wcWxs0"]],
                    "documents": [["documentId": String((template["id"] as! String).dropFirst(9)),
                                   "wxmlAst": template["wxmlAst"]!,
                                   "expressions": [["source": "value.constructor", "shorthand": false,
                                                    "executableSha256": digests["expression"]!, "helper": "__wcWxs0"]]]]
                ]
                try writeManifest(manifest, to: directory)
                try body(directory, digests)
            }
        }
        try test("real canonical pack and all referenced blobs") {
            try expect(pack.blobs.count >= 7, "reference pack blob count")
            try expect(pack.integrityRoot.count == 64, "validated root")
            let original = try Data(contentsOf: source.appendingPathComponent("manifest.json"))
            try expect(pack.manifestData == original, "manifest bytes preserved")
        }
        try test("real TypeScript modern schema-v2 closure reaches both startup batches") {
            try expect(modernPack.manifest["schemaVersion"] as? Int == 2, "explicit modern schema")
            let modern = modernPack.manifest["modernView"] as! [String: Any]
            let unit = (modern["units"] as! [[String: Any]])[0]
            var digests = [unit["executableSha256"] as! String, unit["sourceMapSha256"] as! String]
            digests += (unit["sources"] as! [[String: Any]]).map { $0["sha256"] as! String }
            let map = try JSONSerialization.jsonObject(with: modernPack.blobs["sha256:" + (unit["sourceMapSha256"] as! String)]!) as! [String: Any]
            try expect((map["sourcesContent"] as! [String]).contains { $0.contains("interface Input") }, "real TypeScript source map retained")
            let runtime = RecordingRuntime()
            _ = try modernPack.start(on: runtime)
            for request in runtime.requests where ["app.init", "render.commit"].contains(request["op"] as! String) {
                let blobs = (request["payload"] as! [String: Any])["blobs"] as! [String: [Int]]
                for digest in digests { try expect(blobs["sha256:" + digest] != nil, "modern closure preloaded") }
            }
        }
        try test("modern executable, map and every original source reject missing and corrupt bytes") {
            let unit = ((modernPack.manifest["modernView"] as! [String: Any])["units"] as! [[String: Any]])[0]
            var digests = [unit["executableSha256"] as! String, unit["sourceMapSha256"] as! String]
            digests += (unit["sources"] as! [[String: Any]]).map { $0["sha256"] as! String }
            for digest in digests {
                for corrupt in [false, true] {
                    try withModernCopy { directory in
                        let file = directory.appendingPathComponent("blobs/sha256/" + digest)
                        if corrupt { try Data("tampered".utf8).write(to: file) }
                        else { try FileManager.default.removeItem(at: file) }
                        try requireError("ERR_INVALID_MANIFEST") { _ = try WeappPortablePack(directory: directory) }
                    }
                }
            }
        }
        try test("modern schema and compiler identity fail closed even with a recomputed root") {
            let changes: [([String: Any]) -> [String: Any]] = [
                { var value = $0; value["schemaVersion"] = 1; return value },
                { var value = $0; value.removeValue(forKey: "modernView"); return value },
                { var value = $0; value["schemaVersion"] = 3; return value },
            ] + ["compiler", "version", "abi", "target"].map { field in
                return { value in
                    var result = value
                    var modern = result["modernView"] as! [String: Any]
                    modern[field] = "unsupported"
                    result["modernView"] = modern
                    return result
                }
            }
            for change in changes {
                try withModernCopy { directory in
                    try writeManifest(change(modernPack.manifest), to: directory)
                    try requireError("ERR_INVALID_MANIFEST") { _ = try WeappPortablePack(directory: directory) }
                }
            }
        }
        try test("schema v3 verifies renderer profiles and preserves modern resources") {
            let rendering: [String: Any] = ["version": "1.0", "default": "skia", "pages": [String: String]()]
            for modern in [false, true] {
                let withFixture = modern ? withModernCopy : withCopy
                try withFixture { directory in
                    var value = modern ? modernPack.manifest : pack.manifest
                    value["schemaVersion"] = 3
                    value["rendering"] = rendering
                    try writeManifest(value, to: directory)
                    let loaded = try WeappPortablePack(directory: directory)
                    try expect(loaded.blobs.count == (modern ? modernPack.blobs.count : pack.blobs.count), "schema v3 retains full resource closure")
                }
            }
            let invalid: [Any] = [NSNull(),
                ["version": "1.0", "default": "native", "pages": [String: String]()],
                ["version": "1.0", "default": "skia", "pages": ["undeclared": "webview"]],
                ["version": "1.0", "default": "skia", "pages": [String: String](), "unknown": true]]
            for profiles in invalid {
                try withCopy { directory in
                    var value = pack.manifest
                    value["schemaVersion"] = 3
                    value["rendering"] = profiles
                    try writeManifest(value, to: directory)
                    try requireError("ERR_INVALID_MANIFEST") { _ = try WeappPortablePack(directory: directory) }
                }
            }
        }
        try test("canonical root uses packer UTF-8 key ordering for BMP and astral names") {
            try withCopy { directory in
                var manifest = pack.manifest
                manifest["capabilities"] = ["\u{e000}": "partial", "😀": "partial"]
                try writeManifest(manifest, to: directory)
                _ = try WeappPortablePack(directory: directory)
            }
        }
        try test("startup sequence carries modules/view blobs and preserves live page data") {
            let runtime = RecordingRuntime()
            let result = try pack.start(on: runtime)
            try expect(runtime.loaded, "manifest must be loaded first")
            try expect(runtime.requests.compactMap { $0["op"] as? String } == ["app.init", "app.lifecycle", "page.push", "render.commit"], "startup order")
            let initPayload = runtime.requests[0]["payload"] as! [String: Any]
            let modules = initPayload["modules"] as! [[String: Any]]
            try expect(modules.count == (pack.manifest["modules"] as! [[String: Any]]).count, "all modules")
            try expect((initPayload["blobs"] as! [String: [Int]]).count == pack.blobs.count, "preload all view resources before onLoad")
            let render = runtime.requests[3]["payload"] as! [String: Any]
            try expect(render["data"] == nil, "do not overwrite app's onLoad/setData state")
            try expect(render["root"] == nil && render["templateId"] != nil, "render real WXML instead of synthetic rectangle")
            try expect(result.route == "pages/home/index", "real route")
            try expect(result.requests.count == 4 && result.sessionID == "session-1", "correlated startup evidence")
        }
        try test("route styles include global and recursive components while excluding another page cascade") {
            try withCopy { directory in
                try writeManifest(styleManifest(), to: directory)
                let selected = try WeappPortablePack(directory: directory)
                let home = ["style:app.wxss", "style:pages/home/index.wxss", "style:components/shared/index.wxss",
                    "style:components/counter/index.wxss", "style:components/label/index.wxss"]
                let settings = ["style:app.wxss", "style:features/settings.wxss", "style:components/shared/index.wxss",
                    "style:components/unrelated/index.wxss"]
                try expect(try selected.styleIDs(forRoute: "pages/home/index") == home, "normalized root targets and recursive cycle terminate")
                try expect(try selected.styleIDs(forRoute: "pages/settings/index") == settings, "explicit route config and app-wide components")
                for (route, expected) in [("pages/home/index", home), ("pages/settings/index", settings)] {
                    let runtime = RecordingRuntime()
                    _ = try selected.start(on: runtime, route: route)
                    let render = runtime.requests.last!["payload"] as! [String: Any]
                    try expect(render["styleIds"] as? [String] == expected, "startup uses the same selected style graph in manifest order")
                }
            }
        }
        try test("style graph rejects unnormalized reached targets before changing runtime") {
            for target in ["../other", "/components/counter/index", "", NSNull(), 12] as [Any] {
                try withCopy { directory in
                    var value = styleManifest()
                    var graph = value["components"] as! [[String: Any]]
                    graph[1]["usingComponents"] = ["invalid": target]
                    value["components"] = graph
                    try writeManifest(value, to: directory)
                    let selected = try WeappPortablePack(directory: directory)
                    let runtime = RecordingRuntime()
                    try requireError("ERR_INVALID_MANIFEST") { _ = try selected.start(on: runtime) }
                    try expect(!runtime.loaded && runtime.requests.isEmpty, "invalid graph cannot mutate native owner")
                }
            }
        }
        try test("style traversal uses the current declared route and permits absent component declarations") {
            try withCopy { directory in
                var value = styleManifest()
                value["components"] = [] as [[String: Any]]
                try writeManifest(value, to: directory)
                let selected = try WeappPortablePack(directory: directory)
                try expect(try selected.styleIDs(forRoute: "pages/home/index") == ["style:app.wxss", "style:pages/home/index.wxss"], "only app and current page without component graph")
                try requireError("ERR_INVALID_MANIFEST") { _ = try selected.styleIDs(forRoute: "pages/missing") }
            }
        }
        try test("explicit V8 and session selection reach runtime without fallback") {
            let runtime = RecordingRuntime()
            let result = try pack.start(on: runtime, engine: "v8", sessionID: "ios-unique-v8")
            try expect(runtime.engine == "v8" && result.engine == "v8", "requested engine retained")
            try expect(runtime.requests.allSatisfy { $0["sessionId"] as? String == "ios-unique-v8" }, "all requests use configured session")
        }
        try test("viewport reaches host configuration before AppService startup") {
            let runtime = RecordingRuntime()
            _ = try pack.start(on: runtime, width: 390, height: 844)
            try expect(runtime.viewport == [390, 844], "host must receive actual logical dimensions")
            let render = runtime.requests[3]["payload"] as! [String: Any]
            let viewport = render["viewport"] as! [String: Any]
            try expect(viewport["width"] as? Double == runtime.viewport[0]
                       && viewport["height"] as? Double == runtime.viewport[1], "host and renderer share geometry")
        }
        try test("root corruption rejected before touching runtime") {
            try withCopy { directory in
                let path = directory.appendingPathComponent("manifest.json")
                var data = try String(contentsOf: path, encoding: .utf8)
                data = data.replacingOccurrences(of: pack.integrityRoot, with: String(repeating: "0", count: 64))
                try data.write(to: path, atomically: true, encoding: .utf8)
                try requireError("ERR_INVALID_MANIFEST") { _ = try WeappPortablePack(directory: directory) }
            }
        }
        try test("floating metadata is explicitly outside this v1 loader's numeric domain") {
            try withCopy { directory in
                let path = directory.appendingPathComponent("manifest.json")
                var manifest = pack.manifest
                manifest["unsupportedNumber"] = 0.5
                try JSONSerialization.data(withJSONObject: manifest).write(to: path)
                do { _ = try WeappPortablePack(directory: directory); throw Failure.assertion("expected numeric-domain error") }
                catch let error as WeappPortablePackError {
                    try expect(error.code == "ERR_INVALID_MANIFEST" && error.message.contains("safe-integer"), "explicit unsupported numeric metadata")
                }
            }
        }
        try test("corrupt blob rejected") {
            try withCopy { directory in
                let digest = String(pack.blobs.keys.sorted().first!.dropFirst(7))
                try Data("corrupt".utf8).write(to: directory.appendingPathComponent("blobs/sha256/" + digest))
                try requireError("ERR_INVALID_MANIFEST") { _ = try WeappPortablePack(directory: directory) }
            }
        }
        try test("missing blob rejected") {
            try withCopy { directory in
                let digest = String(pack.blobs.keys.sorted().first!.dropFirst(7))
                try FileManager.default.removeItem(at: directory.appendingPathComponent("blobs/sha256/" + digest))
                try requireError("ERR_INVALID_MANIFEST") { _ = try WeappPortablePack(directory: directory) }
            }
        }
        try test("compiled source and executable closure is verified and sent in both startup batches") {
            try withCompilationCopy { directory, digests in
                let compiled = try WeappPortablePack(directory: directory)
                for digest in digests.values { try expect(compiled.blobs["sha256:" + digest] != nil, "compiled closure blob") }
                let runtime = RecordingRuntime()
                _ = try compiled.start(on: runtime)
                for request in runtime.requests where ["app.init", "render.commit"].contains(request["op"] as! String) {
                    let payload = request["payload"] as! [String: Any]
                    let blobs = payload["blobs"] as! [String: [Int]]
                    for digest in digests.values { try expect(blobs["sha256:" + digest] != nil, "compiled bytes before actual execution") }
                }
            }
        }
        try test("missing compiled module and source bytes rejected before touching runtime") {
            for name in ["source", "module"] {
                try withCompilationCopy { directory, digests in
                    try FileManager.default.removeItem(at: directory.appendingPathComponent("blobs/sha256/" + digests[name]!))
                    try requireError("ERR_INVALID_MANIFEST") { _ = try WeappPortablePack(directory: directory) }
                }
            }
        }
        try test("corrupt compiled expression bytes rejected") {
            try withCompilationCopy { directory, digests in
                try Data("corrupt expression".utf8).write(to: directory.appendingPathComponent("blobs/sha256/" + digests["expression"]!))
                try requireError("ERR_INVALID_MANIFEST") { _ = try WeappPortablePack(directory: directory) }
            }
        }
        try test("malformed compilation hashes and arrays rejected") {
            try withCompilationCopy { directory, _ in
                let bytes = try Data(contentsOf: directory.appendingPathComponent("manifest.json"))
                var manifest = try JSONSerialization.jsonObject(with: bytes) as! [String: Any]
                var compilation = manifest["viewCompilation"] as! [String: Any]
                var modules = compilation["modules"] as! [[String: Any]]
                let originalModules = modules
                modules[0]["executableSha256"] = "../unsafe"
                compilation["modules"] = modules; manifest["viewCompilation"] = compilation
                try writeManifest(manifest, to: directory)
                try requireError("ERR_INVALID_MANIFEST") { _ = try WeappPortablePack(directory: directory) }
                compilation["modules"] = originalModules
                compilation["documents"] = [:] as [String: Any]; manifest["viewCompilation"] = compilation
                try writeManifest(manifest, to: directory)
                try requireError("ERR_INVALID_MANIFEST") { _ = try WeappPortablePack(directory: directory) }
            }
        }
        try test("escaping symlink rejected") {
            try withCopy { directory in
                let digest = String(pack.blobs.keys.sorted().first!.dropFirst(7))
                let path = directory.appendingPathComponent("blobs/sha256/" + digest)
                try FileManager.default.removeItem(at: path)
                try FileManager.default.createSymbolicLink(at: path, withDestinationURL: source.appendingPathComponent("blobs/sha256/" + digest))
                try requireError("ERR_INVALID_MANIFEST") { _ = try WeappPortablePack(directory: directory) }
            }
        }
        try test("invalid viewport and route do not load manifest") {
            let runtime = RecordingRuntime()
            try requireError("ERR_RENDER") { _ = try pack.start(on: runtime, width: .infinity) }
            try requireError("ERR_INVALID_MANIFEST") { _ = try pack.start(on: runtime, route: "missing") }
            try expect(!runtime.loaded, "configuration validation before mutation")
        }
        try test("ABI and structured runtime errors propagate") {
            for (mode, code) in [("abi-error", "ERR_ENGINE"), ("error", "ERR_UNSUPPORTED_CAPABILITY"), ("unavailable", "ERR_ENGINE"), ("uncommitted", "ERR_RENDER"), ("explicit-frame", "ERR_RENDER"), ("wrong-frame", "ERR_RENDER"), ("wrong-kind", "ERR_ENGINE"), ("wrong-id", "ERR_ENGINE"), ("wrong-session", "ERR_ENGINE"), ("wrong-engine", "ERR_ENGINE"), ("wrong-count", "ERR_ENGINE"), ("wrong-root", "ERR_ENGINE"), ("duplicate", "ERR_ENGINE")] {
                let runtime = RecordingRuntime(); runtime.mode = mode
                try requireError(code) { _ = try pack.start(on: runtime) }
                try expect(runtime.requests.count < 4 || ["uncommitted", "explicit-frame", "wrong-frame"].contains(mode), "stop sequence on first rejected operation")
            }
        }
        try test("manifest ABI rejection stops startup") {
            let runtime = RecordingRuntime(); runtime.loadStatus = -1
            try requireError("ERR_INVALID_MANIFEST") { _ = try pack.start(on: runtime) }
            try expect(runtime.requests.isEmpty, "no app init after rejected manifest")
        }
        try test("post-publication errors retained with accepted frame") {
            let runtime = RecordingRuntime(); runtime.mode = "post-error"
            let result = try pack.start(on: runtime)
            try expect(result.operations["render.commit"] != nil && result.diagnostics.count == 1, "accepted frame retains diagnostic")
        }
        try test("successful render acknowledgement cannot mask a failed sibling without error details") {
            let runtime = RecordingRuntime(); runtime.mode = "sibling-failed"
            try requireError("ERR_ENGINE") { _ = try pack.start(on: runtime) }
            try expect(runtime.requests.count == 4, "reject the returned batch after render publication")
        }
        print("Weapp Container portable-pack Swift tests: \(passed) passed; device/GPU not run")
    }
}
