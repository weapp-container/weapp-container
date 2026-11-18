// swift-tools-version: 5.9
import PackageDescription
import Foundation

let rustLinkerSettings: [LinkerSetting] = {
    guard let path = ProcessInfo.processInfo.environment["WEAPP_CONTAINER_IOS_RUST_LIB"] else {
        return []
    }
    let directory = URL(fileURLWithPath: path).deletingLastPathComponent().path
    return [
        .unsafeFlags(["-L", directory, "-lcontainer_host_ios"], .when(platforms: [.iOS])),
    ]
}()

let package = Package(
    name: "WeappContainerHost",
    platforms: [.iOS(.v16), .macOS(.v12)],
    products: [
        .library(name: "WeappContainerHost", targets: ["WeappContainerHost"]),
        .executable(name: "WeappContainerSmoke", targets: ["WeappContainerSmoke"]),
    ],
    targets: [
        .target(name: "WeappContainerFFI", path: "Sources/WeappContainerFFI", publicHeadersPath: "include"),
        .target(
            name: "WeappContainerHost",
            dependencies: ["WeappContainerFFI"],
            linkerSettings: [
                .linkedFramework("Metal"),
                .linkedFramework("QuartzCore"),
                .linkedFramework("CoreText"),
                .linkedLibrary("c++"),
            ],
        ),
        .executableTarget(
            name: "WeappContainerSmoke",
            dependencies: ["WeappContainerHost"],
            path: "Sources/WeappContainerSmoke",
            resources: [.copy("Resources/portable-pack")],
            linkerSettings: rustLinkerSettings + [
                .linkedFramework("Metal"),
                .linkedFramework("CoreText"),
                .linkedLibrary("c++"),
            ]
        ),
    ]
)
