import Foundation
import Capacitor
import Network
import UIKit
import NetworkProbeCore

@objc(NetworkProbePlugin)
public final class NetworkProbePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NetworkProbePlugin"
    public let jsName = "NetworkProbe"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getNetworkStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "tcp", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "https", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise)
    ]
    private let queue = DispatchQueue(label: "cn.goodbye.networkprobe")
    private let monitor = NWPathMonitor()
    private var network: [String: Any] = ["available": false, "interface": "none"]
    private var pathIdentity: String?
    private var cancelActive: ((String) -> Void)?
    private var tcpProbe: TCPProbe?
    private var httpsProbe: HTTPSProbe?
    private var background = false
    private var observers: [NSObjectProtocol] = []

    public override func load() {
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            let kind = ProbeInterface.name(path)
            let identity = "\(path.status)-\(kind)-\(path.availableInterfaces.map { $0.name }.sorted())"
            if let previous = self.pathIdentity, previous != identity {
                self.cancelActive?("网络路径发生变化，本次连接已取消")
                self.notifyListeners("interrupted", data: ["reason": "网络已切换，请重新开始测试"])
            }
            self.pathIdentity = identity
            self.network = ["available": path.status == .satisfied, "interface": kind,
                            "expensive": path.isExpensive, "constrained": path.isConstrained]
            self.notifyListeners("networkChanged", data: self.network)
        }
        monitor.start(queue: queue)
        observers.append(NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil
        ) { [weak self] _ in
            self?.queue.async { [weak self] in
                guard let self else { return }
                self.background = true
                self.cancelActive?("应用进入后台，测试已取消")
                self.notifyListeners("interrupted", data: ["reason": "应用进入后台，测试已暂停"])
            }
        })
        observers.append(NotificationCenter.default.addObserver(
            forName: UIApplication.willEnterForegroundNotification, object: nil, queue: nil
        ) { [weak self] _ in self?.queue.async { [weak self] in self?.background = false } })
    }

    deinit {
        monitor.cancel()
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        cancelActive?("插件已释放")
    }

    @objc public func getNetworkStatus(_ call: CAPPluginCall) {
        queue.async { call.resolve(self.network) }
    }
    @objc public func tcp(_ call: CAPPluginCall) { run(call, https: false) }
    @objc public func https(_ call: CAPPluginCall) { run(call, https: true) }

    private func run(_ call: CAPPluginCall, https: Bool) {
        queue.async { [self] in
            guard !background else { call.reject("应用在后台，不能开始测试"); return }
            guard cancelActive == nil else { call.reject("已有连接正在测试"); return }
            guard let host = call.getString("host"), !host.isEmpty, host.count <= 253,
                  host.range(of: "^[a-zA-Z0-9.:%_-]+$", options: .regularExpression) != nil,
                  let port = call.getInt("port"), (1...65535).contains(port),
                  let timeout = call.getDouble("timeout"), [2.0, 3.0, 5.0, 10.0].contains(timeout) else {
                call.reject("目标、端口或超时参数无效"); return
            }
            let complete: ([String: Any]) -> Void = { [weak self] result in
                guard let self else { return }
                self.tcpProbe = nil; self.httpsProbe = nil; self.cancelActive = nil
                var enriched = result
                enriched["observedInterface"] = self.network["interface"] ?? "none"
                call.resolve(enriched)
            }
            if https {
                let probe = HTTPSProbe(host: host, port: port, timeout: timeout, queue: queue, completion: complete)
                httpsProbe = probe
                cancelActive = { [weak probe] in probe?.cancel(reason: $0) }
                probe.start()
            } else {
                let probe = TCPProbe(host: host, port: UInt16(port), timeout: timeout, queue: queue, completion: complete)
                tcpProbe = probe
                cancelActive = { [weak probe] in probe?.cancel(reason: $0) }
                probe.start()
            }
        }
    }

    @objc public func cancel(_ call: CAPPluginCall) {
        queue.async {
            self.cancelActive?(call.getString("reason") ?? "用户取消")
            call.resolve()
        }
    }
}
