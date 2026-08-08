// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "KSPlayerMetalRuntime",
    platforms: [.macOS(.v13)],
    products: [
        .library(
            name: "KSPlayerMetalRuntime",
            type: .dynamic,
            targets: ["KSPlayerMetalRuntime"]
        ),
    ],
    dependencies: [
        // Keep both source packages on audited immutable revisions. The checked-in
        // Package.resolved is the second reproducibility gate for the complete
        // SwiftPM graph.
        .package(
            url: "https://github.com/kingslay/KSPlayer.git",
            revision: "5634297a5d762bc32e4fbd538fb8620331fb7a35"
        ),
        .package(
            url: "https://github.com/kingslay/FFmpegKit.git",
            revision: "c32be9bfb628042737ad3ef622e930c5c7b15954"
        ),
    ],
    targets: [
        .target(
            name: "KSPlayerMetalRuntime",
            dependencies: [
                .product(name: "KSPlayer", package: "ksplayer"),
                // Declare this direct dependency so KSPlayer's floating upstream
                // requirement cannot silently choose a different FFmpegKit tree.
                .product(name: "FFmpegKit", package: "ffmpegkit"),
            ],
            path: "Sources/KSPlayerMetalRuntime"
        ),
    ]
)
