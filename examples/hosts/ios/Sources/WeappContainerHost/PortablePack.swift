import Foundation
import CryptoKit
import CoreFoundation

/// A host must return the complete bridge batch. A non-empty JSON error is
/// never treated as a successful dispatch.
public protocol WeappPortablePackRuntime: AnyObject {
    var manifestLoadFailure: WeappPortablePackError? { get }
    @discardableResult func loadManifest(_ manifest: Data) -> Int32
    @discardableResult func loadManifest(_ manifest: Data, engine: String, sessionID: String) -> Int32
    @discardableResult func loadManifest(_ manifest: Data, engine: String, sessionID: String,
                                        width: Double, height: Double) -> Int32
    func dispatch(_ envelope: Data) -> (status: Int32, response: Data)
}

public extension WeappPortablePackRuntime {
    var manifestLoadFailure: WeappPortablePackError? { nil }
    /// Keep existing embedders source-compatible while rejecting configurations
    /// that their legacy loader cannot honor.
    func loadManifest(_ manifest: Data, engine: String, sessionID: String) -> Int32 {
        guard engine == "quickjs", sessionID == "session-1" else { return -2 }
        return loadManifest(manifest)
    }

    /// Existing custom runtimes keep their configured loader. Native hosts
    /// override this to expose the viewport before AppService executes.
    func loadManifest(_ manifest: Data, engine: String, sessionID: String,
                      width: Double, height: Double) -> Int32 {
        loadManifest(manifest, engine: engine, sessionID: sessionID)
    }
}

public struct WeappPortablePackError: Error, CustomStringConvertible {
    public let phase: String
    public let code: String
    public let message: String
    public var description: String { "\(code) [\(phase)]: \(message)" }
    public var jsonObject: [String: Any] { ["phase": phase, "code": code, "message": message] }

    init(_ phase: String, _ code: String, _ message: String) {
        self.phase = phase
        self.code = code
        self.message = message
    }
}

public struct WeappPortablePackStartup {
    public let route: String
    public let integrityRoot: String
    public let engine: String
    public let sessionID: String
    public let requests: [String: Data]
    public let operations: [String: Data]
    /// Includes post-publication errors; a committed frame does not erase them.
    public let diagnostics: [[String: Any]]
}

/// Immutable, eagerly verified portable pack. Validate every referenced blob
/// before touching the host session, including separate View/WXS resources.
/// The Rust runtime remains authoritative for schema and supported semantics.
public struct WeappPortablePack {
    public let manifestData: Data
    public let manifest: [String: Any]
    public let blobs: [String: Data]
    public let integrityRoot: String

    public init(directory: URL) throws {
        let root = directory.standardizedFileURL.resolvingSymlinksInPath()
        func read(_ relative: String) throws -> Data {
            let url = root.appendingPathComponent(relative).resolvingSymlinksInPath()
            guard url.path.hasPrefix(root.path + "/"),
                  (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else {
                throw WeappPortablePackError("pack", "ERR_INVALID_MANIFEST", "missing or unsafe pack file: \(relative)")
            }
            do { return try Data(contentsOf: url) }
            catch { throw WeappPortablePackError("pack", "ERR_INVALID_MANIFEST", "cannot read \(relative): \(error)") }
        }
        let bytes = try read("manifest.json")
        guard String(data: bytes, encoding: .utf8) != nil,
              let object = try? JSONSerialization.jsonObject(with: bytes),
              let value = object as? [String: Any],
              let schema = value["schemaVersion"] as? NSNumber,
               CFGetTypeID(schema) != CFBooleanGetTypeID(), (schema == 1 || schema == 2 || schema == 3),
               !(schema == 1 && value["modernView"] != nil), !(schema == 2 && value["modernView"] == nil),
               (schema == 3) == (value["rendering"] != nil),
              let integrity = value["integrity"] as? [String: Any],
              integrity["algorithm"] as? String == "sha256",
              let expectedRoot = integrity["root"] as? String, Self.isDigest(expectedRoot) else {
            throw WeappPortablePackError("manifest", "ERR_INVALID_MANIFEST", "expected UTF-8 schema v1/v2/v3 SHA-256 manifest")
        }
        var unsigned = value
        var unsignedIntegrity = integrity
        unsignedIntegrity["root"] = ""
        unsigned["integrity"] = unsignedIntegrity
        guard Self.sha256(try Self.canonicalJSON(unsigned)) == expectedRoot else {
            throw WeappPortablePackError("manifest", "ERR_INVALID_MANIFEST", "manifest integrity root mismatch")
        }
        if let version = value["protocolVersion"] as? String {
            let parts = version.split(separator: ".", omittingEmptySubsequences: false)
            guard parts.count == 2, parts[0] == "1", UInt32(parts[1]) != nil else {
                throw WeappPortablePackError("manifest", "ERR_PROTOCOL_VERSION", "unsupported protocol: \(version)")
            }
        }
        let routes = try Self.records(value, "routes")
        if let declaration = value["rendering"] {
            let profiles = Set(["skia", "webview", "skyline-compat"])
            guard let rendering = declaration as? [String: Any],
                  Set(rendering.keys) == Set(["version", "default", "pages"]),
                  rendering["version"] as? String == "1.0",
                  let profile = rendering["default"] as? String, profiles.contains(profile),
                  let pages = rendering["pages"] as? [String: String] else {
                throw WeappPortablePackError("manifest", "ERR_INVALID_MANIFEST", "unsupported rendering profile declaration")
            }
            let paths = Set(routes.compactMap { $0["path"] as? String })
            for (page, profile) in pages {
                guard paths.contains(page), !page.isEmpty,
                      !page.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }),
                      page.rangeOfCharacter(from: CharacterSet.controlCharacters.union(CharacterSet(charactersIn: "\\#?:"))) == nil,
                      !page.hasSuffix(".wxml"), !page.hasSuffix(".json"), profiles.contains(profile) else {
                    throw WeappPortablePackError("manifest", "ERR_INVALID_MANIFEST", "invalid rendering page profile")
                }
            }
        }
        guard !routes.isEmpty else {
            throw WeappPortablePackError("manifest", "ERR_INVALID_MANIFEST", "pack has no routes")
        }
        let modules = try Self.records(value, "modules")
        guard !modules.isEmpty else {
            throw WeappPortablePackError("manifest", "ERR_INVALID_MANIFEST", "pack has no modules")
        }
        var digests = Set<String>()
        func addDigest(_ item: [String: Any], _ field: String, _ label: String, pointer: Bool = false) throws {
            guard let reference = item[field] as? String,
                  !pointer || reference.hasPrefix("sha256:") else {
                throw WeappPortablePackError("manifest", "ERR_INVALID_MANIFEST", "invalid \(label).\(field) blob reference")
            }
            let digest = reference.hasPrefix("sha256:") ? String(reference.dropFirst(7)) : reference
            guard Self.isDigest(digest) else {
                throw WeappPortablePackError("manifest", "ERR_INVALID_MANIFEST", "invalid blob digest: \(reference)")
            }
            digests.insert(digest)
        }
        for (key, field, pointer) in [("modules", "sha256", false), ("viewScripts", "sha256", false),
                                     ("templates", "wxmlAst", true), ("styles", "wxssIr", true),
                                     ("assets", "sha256", false)] {
            for item in try Self.records(value, key) {
                try addDigest(item, field, key, pointer: pointer)
            }
        }
        if let rawCompilation = value["viewCompilation"] {
            guard let compilation = rawCompilation as? [String: Any],
                  compilation["modules"] != nil, compilation["documents"] != nil else {
                throw WeappPortablePackError("manifest", "ERR_INVALID_MANIFEST", "viewCompilation must declare modules and documents arrays")
            }
            for module in try Self.records(compilation, "modules") {
                try addDigest(module, "sourceSha256", "viewCompilation.modules")
                try addDigest(module, "executableSha256", "viewCompilation.modules")
            }
            for document in try Self.records(compilation, "documents") {
                try addDigest(document, "wxmlAst", "viewCompilation.documents", pointer: true)
                guard document["expressions"] != nil else {
                    throw WeappPortablePackError("manifest", "ERR_INVALID_MANIFEST", "viewCompilation document must declare expressions array")
                }
                for expression in try Self.records(document, "expressions") {
                    try addDigest(expression, "executableSha256", "viewCompilation.documents.expressions")
                }
            }
        }
        if let rawModern = value["modernView"] {
            guard let modern = rawModern as? [String: Any],
                  modern["compiler"] as? String == "weapp-container-modern-view",
                  modern["version"] as? String == "1.0.0", modern["abi"] as? String == "1.0",
                  modern["target"] as? String == "es2022", modern["units"] != nil else {
                throw WeappPortablePackError("manifest", "ERR_INVALID_MANIFEST", "unsupported modernView compiler")
            }
            let units = try Self.records(modern, "units")
            guard !units.isEmpty else { throw WeappPortablePackError("manifest", "ERR_INVALID_MANIFEST", "modernView needs units") }
            for unit in units {
                try addDigest(unit, "executableSha256", "modernView.units")
                try addDigest(unit, "sourceMapSha256", "modernView.units")
                guard unit["sources"] != nil else { throw WeappPortablePackError("manifest", "ERR_INVALID_MANIFEST", "modernView unit needs sources") }
                for source in try Self.records(unit, "sources") { try addDigest(source, "sha256", "modernView.sources") }
            }
        }
        var loaded: [String: Data] = [:]
        for digest in digests.sorted() {
            let data = try read("blobs/sha256/" + digest)
            guard Self.sha256(data) == digest else {
                throw WeappPortablePackError("blob", "ERR_INVALID_MANIFEST", "blob SHA-256 mismatch: \(digest)")
            }
            loaded["sha256:" + digest] = data
        }
        for asset in try Self.records(value, "assets") {
            if let size = asset["size"] as? NSNumber, let digest = asset["sha256"] as? String {
                let pointer = digest.hasPrefix("sha256:") ? digest : "sha256:" + digest
                guard CFGetTypeID(size) != CFBooleanGetTypeID(), size.int64Value >= 0,
                      size == NSNumber(value: size.int64Value), loaded[pointer].map({ Int64($0.count) }) == size.int64Value else {
                    throw WeappPortablePackError("blob", "ERR_INVALID_MANIFEST", "asset size mismatch: \(asset["path"] ?? digest)")
                }
            }
        }
        manifestData = bytes
        manifest = value
        blobs = loaded
        integrityRoot = expectedRoot
    }

    /// Select WXSS through the portable pack's normalized component graph.
    /// Targets already refer to the package root; resolving them relative to
    /// their owner again would select the wrong component. Component style
    /// isolation remains the runtime's responsibility, while unrelated pages
    /// must never enter this frame's cascade. Manifest order is preserved.
    public func styleIDs(forRoute path: String) throws -> [String] {
        guard let route = try Self.records(manifest, "routes").first(where: { $0["path"] as? String == path }),
              let app = manifest["app"] as? [String: Any], let appJSON = app["appJson"] as? String,
              !appJSON.isEmpty else {
            throw WeappPortablePackError("render.styles", "ERR_INVALID_MANIFEST", "route or app style owner is missing")
        }
        var graph: [String: [String: Any]] = [:]
        for declaration in try Self.records(manifest, "components") {
            guard let owner = declaration["owner"] as? String, !owner.isEmpty, graph[owner] == nil else {
                throw WeappPortablePackError("render.styles", "ERR_INVALID_MANIFEST", "component style graph has a missing or duplicate owner")
            }
            graph[owner] = declaration
        }
        var pending = [appJSON, route["config"] as? String ?? path + ".json"]
        var owners = Set<String>()
        while let owner = pending.popLast() {
            guard owners.insert(owner).inserted else { continue }
            guard let declaration = graph[owner], let usingComponents = declaration["usingComponents"] else { continue }
            guard let targets = usingComponents as? [String: Any] else {
                throw WeappPortablePackError("render.styles", "ERR_INVALID_MANIFEST", "usingComponents must be an object")
            }
            for value in targets.values {
                guard let target = value as? String, !target.isEmpty, !target.hasPrefix("/"),
                      !target.split(separator: "/", omittingEmptySubsequences: false).contains("..") else {
                    throw WeappPortablePackError("render.styles", "ERR_INVALID_MANIFEST", "component style graph requires normalized relative paths")
                }
                pending.append(target + ".json")
            }
        }
        let reachable = Set(owners.map { owner in
            "style:" + (owner.hasSuffix(".json") ? String(owner.dropLast(5)) + ".wxss" : owner)
        })
        return try Self.records(manifest, "styles").compactMap { style in
            guard let id = style["id"] as? String else { return nil }
            return style["scope"] as? String == "app" || reachable.contains(id) ? id : nil
        }
    }

    /// Load modules and view resources in one AppService initialization batch,
    /// then run the same startup sequence as container-simulator. Page data is
    /// deliberately omitted from render.commit so onLoad/setData remain live.
    public func start(on runtime: WeappPortablePackRuntime, route requestedRoute: String? = nil,
                      engine: String = "quickjs", sessionID: String = "session-1",
                      width: Double = 375, height: Double = 667) throws -> WeappPortablePackStartup {
        guard ["quickjs", "v8"].contains(engine), !sessionID.isEmpty else {
            throw WeappPortablePackError("startup", "ERR_ENGINE", "invalid engine or empty session identity")
        }
        guard width.isFinite, height.isFinite, width > 0, height > 0,
              width <= Double(UInt32.max), height <= Double(UInt32.max) else {
            throw WeappPortablePackError("startup", "ERR_RENDER", "viewport must be finite and positive")
        }
        let routes = try Self.records(manifest, "routes")
        guard let route = requestedRoute ?? routes.first?["path"] as? String,
              routes.contains(where: { $0["path"] as? String == route }) else {
            throw WeappPortablePackError("startup", "ERR_INVALID_MANIFEST", "requested route does not exist")
        }
        let templateID = "template:" + route + ".wxml"
        guard try Self.records(manifest, "templates").contains(where: { $0["id"] as? String == templateID }) else {
            throw WeappPortablePackError("startup", "ERR_INVALID_MANIFEST", "route template missing: \(templateID)")
        }
        let modules: [[String: Any]] = try Self.records(manifest, "modules").map { declaration in
            guard let id = declaration["id"] as? String, let digest = declaration["sha256"] as? String,
                  let data = blobs[digest.hasPrefix("sha256:") ? digest : "sha256:" + digest] else {
                throw WeappPortablePackError("startup", "ERR_MODULE_LOAD", "module declaration has no verified bytes")
            }
            if let source = String(data: data, encoding: .utf8) { return ["id": id, "source": source] }
            return ["id": id, "bytes": data.map { Int($0) }]
        }
        let blobValues = blobs.mapValues { $0.map { Int($0) } }
        let styleIDs = try self.styleIDs(forRoute: route)
        let status = runtime.loadManifest(manifestData, engine: engine, sessionID: sessionID,
                                          width: width, height: height)
        guard status == 0 else {
            if let failure = runtime.manifestLoadFailure { throw failure }
            throw WeappPortablePackError("manifest.load", status == -2 ? "ERR_ENGINE" : "ERR_INVALID_MANIFEST", "Rust rejected manifest/configuration (ABI status \(status)); explicit engine selection never falls back")
        }
        var operations: [String: Data] = [:]
        var requests: [String: Data] = [:]
        var diagnostics: [[String: Any]] = []
        let startup: [(String, [String: Any])] = [
            ("app.init", ["manifest": manifest, "modules": modules, "blobs": blobValues, "launchOptions": ["path": route]]),
            ("app.lifecycle", ["event": "launch", "options": ["path": route]]),
            ("page.push", ["path": route]),
            ("render.commit", ["frameId": 1, "templateId": templateID, "styleIds": styleIDs,
                               "blobs": blobValues, "viewport": ["x": 0, "y": 0, "width": width, "height": height]])
        ]
        for (index, item) in startup.enumerated() {
            let (operation, payload) = item
            let requestID = "ios-pack-\(index + 1)"
            let envelope: [String: Any] = ["protocolVersion": "1.0", "sessionId": sessionID,
                                          "requestId": requestID, "kind": "request", "op": operation, "payload": payload]
            let request = try JSONSerialization.data(withJSONObject: envelope, options: [.sortedKeys])
            requests[operation] = request
            let result = runtime.dispatch(request)
            operations[operation] = result.response
            guard result.status == 0 else {
                throw WeappPortablePackError(operation, "ERR_ENGINE", "ABI status \(result.status): \(String(data: result.response, encoding: .utf8) ?? "non-UTF8 response")")
            }
            guard let batch = try? JSONSerialization.jsonObject(with: result.response) as? [String: Any],
                  let messages = batch["messages"] as? [[String: Any]] else {
                throw WeappPortablePackError(operation, "ERR_ENGINE", "missing bridge batch")
            }
            let responses = messages.filter { $0["kind"] as? String == "response" && $0["requestId"] as? String == requestID && $0["op"] as? String == operation }
            guard responses.count == 1, let response = responses.first,
                  response["sessionId"] as? String == sessionID,
                  let responsePayload = response["payload"] as? [String: Any] else {
                throw WeappPortablePackError(operation, "ERR_ENGINE", "missing or ambiguous correlated bridge acknowledgement")
            }
            if let failed = messages.first(where: { $0["kind"] as? String == "response" && ($0["payload"] as? [String: Any])?["ok"] as? Bool == false }),
               let failure = failed["payload"] as? [String: Any] {
                let error = failure["error"] as? [String: Any] ?? [:]
                throw WeappPortablePackError(operation, error["code"] as? String ?? "ERR_ENGINE", error["message"] as? String ?? "bridge batch contained a failed response")
            }
            if responsePayload["ok"] as? Bool != true {
                let error = responsePayload["error"] as? [String: Any] ?? [:]
                throw WeappPortablePackError(operation, error["code"] as? String ?? "ERR_ENGINE", error["message"] as? String ?? "bridge operation failed")
            }
            if operation == "app.init", responsePayload["engineProviderAvailable"] as? Bool != true {
                throw WeappPortablePackError(operation, "ERR_ENGINE", "native JS engine unavailable; refusing protocol-only startup")
            }
            if operation == "app.init" {
                let declared = try Self.records(manifest, "modules").count
                let root = (responsePayload["manifest"] as? [String: Any])?["integrity"] as? String
                guard responsePayload["engine"] as? String == engine,
                      responsePayload["loadedModules"] as? Int == declared,
                      root == integrityRoot else {
                    throw WeappPortablePackError(operation, "ERR_ENGINE", "engine, module count or manifest acknowledgement mismatch")
                }
            }
            if operation == "render.commit" {
                guard responsePayload["committed"] as? Bool == true,
                      responsePayload["source"] as? String == "manifest",
                      responsePayload["templateId"] as? String == templateID,
                      responsePayload["frameId"] as? Int == 1 else {
                    throw WeappPortablePackError(operation, "ERR_RENDER", "runtime did not acknowledge the manifest template/frame publication")
                }
            }
            diagnostics += messages.filter { $0["op"] as? String == "diagnostic" || $0["op"] as? String == "error" }
        }
        return WeappPortablePackStartup(route: route, integrityRoot: integrityRoot, engine: engine,
                                        sessionID: sessionID, requests: requests, operations: operations, diagnostics: diagnostics)
    }

    private static func records(_ object: [String: Any], _ key: String) throws -> [[String: Any]] {
        guard let value = object[key] else { return [] }
        guard let records = value as? [[String: Any]] else {
            throw WeappPortablePackError("manifest", "ERR_INVALID_MANIFEST", "\(key) must be an array of objects")
        }
        return records
    }

    private static func isDigest(_ value: String) -> Bool {
        value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    private static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    // JSONSerialization's string escaping matches the packer's UTF-8 JSON
    // with slash escaping disabled. The portable packer sorts property names
    // by UTF-8 bytes, including the order of astral and BMP Unicode keys.
    private static func canonicalJSON(_ value: Any) throws -> Data {
        func encode(_ value: Any) throws -> String {
            if let object = value as? [String: Any] {
                return "{" + (try object.keys.sorted { $0.utf8.lexicographicallyPrecedes($1.utf8) }.map {
                    try encode($0) + ":" + encode(object[$0]!)
                }).joined(separator: ",") + "}"
            }
            if let array = value as? [Any] { return "[" + (try array.map(encode)).joined(separator: ",") + "]" }
            if let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() {
                // Current v1 metadata contains only schemaVersion/asset size
                // integers. Do not pretend Foundation float spelling is the
                // packer's ECMAScript number canonicalization.
                guard number.doubleValue.isFinite, number.doubleValue >= 0,
                      number.compare(NSNumber(value: UInt64(9_007_199_254_740_991))) != .orderedDescending,
                      number == NSNumber(value: number.int64Value) else {
                    throw WeappPortablePackError("manifest", "ERR_INVALID_MANIFEST", "Swift v1 loader supports non-negative safe-integer metadata only")
                }
                return String(number.int64Value)
            }
            let data = try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .withoutEscapingSlashes])
            return String(decoding: data, as: UTF8.self)
        }
        return Data(try encode(value).utf8)
    }
}
