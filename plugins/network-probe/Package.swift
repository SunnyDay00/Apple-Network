// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "AppleNetworkNetworkProbe",
    platforms: [.iOS(.v15)],
    products: [.library(name: "AppleNetworkNetworkProbe", targets: ["NetworkProbePlugin"])],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.3"),
        .package(path: "../../native-core")
    ],
    targets: [.target(name: "NetworkProbePlugin", dependencies: [
        .product(name: "Capacitor", package: "capacitor-swift-pm"),
        .product(name: "NetworkProbeCore", package: "native-core")
    ], path: "ios/Sources/NetworkProbePlugin")]
)
