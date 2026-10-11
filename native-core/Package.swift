// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "NetworkProbeCore",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [.library(name: "NetworkProbeCore", targets: ["NetworkProbeCore"])],
    targets: [
        .target(name: "NetworkProbeCore"),
        .testTarget(name: "NetworkProbeCoreTests", dependencies: ["NetworkProbeCore"])
    ]
)
