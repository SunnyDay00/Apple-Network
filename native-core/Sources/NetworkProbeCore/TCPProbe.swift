import Foundation
import Network

public enum ProbeInterface {
    public static func name(_ path: NWPath?) -> String {
        guard let path, path.status == .satisfied else { return "none" }
        if path.usesInterfaceType(.wifi) { return "wifi" }
        if path.usesInterfaceType(.cellular) { return "cellular" }
        if path.usesInterfaceType(.wiredEthernet) { return "wired" }
        return "other"
    }
}

/// The transport seam exists for lifecycle tests. Production always uses NWConnection.
public protocol TCPTransport: AnyObject {
    var stateUpdate: ((NWConnection.State) -> Void)? { get set }
    var path: NWPath? { get }
    func start(queue: DispatchQueue)
    func cancel()
}

private final class SystemTCPTransport: TCPTransport {
    let connection: NWConnection
    init(host: String, port: UInt16) {
        // No TLS: this measures a real, fresh TCP handshake to the selected port.
        connection = NWConnection(host: .init(host), port: .init(rawValue: port)!, using: .tcp)
    }
    var stateUpdate: ((NWConnection.State) -> Void)? {
        get { connection.stateUpdateHandler }
        set { connection.stateUpdateHandler = newValue }
    }
    var path: NWPath? { connection.currentPath }
    func start(queue: DispatchQueue) { connection.start(queue: queue) }
    func cancel() { connection.cancel() }
}

public final class TCPProbe {
    private let queue: DispatchQueue
    private let transport: TCPTransport
    private let timeout: Double
    private let completion: ([String: Any]) -> Void
    private var started: UInt64 = 0
    private var finished = false
    private var hasStarted = false
    private var timer: DispatchWorkItem?
    private var lastError: String?

    public init(host: String, port: UInt16, timeout: Double,
                queue: DispatchQueue, transport: TCPTransport? = nil,
                completion: @escaping ([String: Any]) -> Void) {
        self.queue = queue
        self.transport = transport ?? SystemTCPTransport(host: host, port: port)
        self.timeout = timeout
        self.completion = completion
    }

    public func start() {
        queue.async { [self] in
            guard !finished, !hasStarted else { return }
            hasStarted = true
            started = DispatchTime.now().uptimeNanoseconds
            transport.stateUpdate = { [weak self] state in
                guard let self else { return }
                self.queue.async { self.handle(state) }
            }
            let item = DispatchWorkItem { [weak self] in
                self?.finish(status: "timeout", error: self?.lastError ?? "TCP 连接超时")
            }
            timer = item
            queue.asyncAfter(deadline: .now() + timeout, execute: item)
            transport.start(queue: queue)
        }
    }

    private func handle(_ state: NWConnection.State) {
        guard !finished else { return }
        switch state {
        case .ready: finish(status: "success", error: nil)
        case .failed(let error): finish(status: "failed", error: error.localizedDescription)
        case .waiting(let error): lastError = error.localizedDescription
        case .cancelled: finish(status: "cancelled", error: "连接已取消")
        default: break
        }
    }

    public func cancel(reason: String = "用户取消") {
        queue.async { [self] in finish(status: "cancelled", error: reason) }
    }

    private func finish(status: String, error: String?) {
        guard !finished else { return }
        finished = true
        let elapsed = started == 0 ? 0 : Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000
        var result: [String: Any] = [
            "status": status, "elapsedMs": elapsed,
            "interface": ProbeInterface.name(transport.path),
            "dnsIncluded": true
        ]
        if status == "success" { result["durationMs"] = elapsed }
        if let error { result["error"] = error }
        timer?.cancel()
        timer = nil
        transport.stateUpdate = nil
        transport.cancel()
        completion(result)
    }
}
