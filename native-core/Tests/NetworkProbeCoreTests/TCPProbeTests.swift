import XCTest
import Network
@testable import NetworkProbeCore

private final class ControlledTransport: TCPTransport {
    var stateUpdate: ((NWConnection.State) -> Void)?
    var path: NWPath? { nil }
    var starts = 0
    var cancels = 0
    let initialState: NWConnection.State?
    init(_ state: NWConnection.State? = nil) { initialState = state }
    func start(queue: DispatchQueue) { starts += 1; if let initialState { stateUpdate?(initialState) } }
    func cancel() { cancels += 1 }
}

final class TCPProbeTests: XCTestCase {
    func testRealLoopbackTCPReadyHasMonotonicTiming() throws {
        let queue = DispatchQueue(label: "loopback")
        let listening = expectation(description: "listener ready")
        let done = expectation(description: "TCP ready")
        let listener = try NWListener(using: .tcp, on: .any)
        var accepted: NWConnection?
        listener.newConnectionHandler = { connection in accepted = connection; connection.start(queue: queue) }
        listener.stateUpdateHandler = { state in if case .ready = state { listening.fulfill() } }
        listener.start(queue: queue)
        wait(for: [listening], timeout: 3)
        let probe = TCPProbe(host: "127.0.0.1", port: try XCTUnwrap(listener.port).rawValue,
                             timeout: 2, queue: queue) { result in
            XCTAssertEqual(result["status"] as? String, "success")
            XCTAssertGreaterThanOrEqual(result["durationMs"] as? Double ?? -1, 0)
            XCTAssertLessThan(result["durationMs"] as? Double ?? 3000, 2000)
            done.fulfill()
        }
        probe.start()
        wait(for: [done], timeout: 3)
        queue.sync { accepted?.cancel(); listener.cancel() }
    }

    func testTimeoutClosesTransportExactlyOnce() {
        let queue = DispatchQueue(label: "timeout")
        let transport = ControlledTransport()
        let done = expectation(description: "timeout")
        let probe = TCPProbe(host: "example.com", port: 443, timeout: 0.03, queue: queue, transport: transport) { result in
            XCTAssertEqual(result["status"] as? String, "timeout")
            XCTAssertNil(result["durationMs"])
            XCTAssertEqual(transport.cancels, 1)
            done.fulfill()
        }
        probe.start(); wait(for: [done], timeout: 1)
        probe.cancel(); queue.sync {}
        XCTAssertEqual(transport.cancels, 1)
    }

    func testCancelReleasesHandlerAndPreventsRestart() {
        let queue = DispatchQueue(label: "cancel")
        let transport = ControlledTransport()
        let done = expectation(description: "cancelled")
        let probe = TCPProbe(host: "example.com", port: 443, timeout: 2, queue: queue, transport: transport) { result in
            XCTAssertEqual(result["status"] as? String, "cancelled")
            XCTAssertNil(transport.stateUpdate)
            done.fulfill()
        }
        probe.start(); probe.cancel(); wait(for: [done], timeout: 1)
        probe.start(); queue.sync {}
        XCTAssertEqual(transport.starts, 1); XCTAssertEqual(transport.cancels, 1)
    }

    func testDNSFailureIncludesReason() {
        let queue = DispatchQueue(label: "dns")
        let transport = ControlledTransport(.failed(.dns(-65538)))
        let done = expectation(description: "DNS failure")
        let probe = TCPProbe(host: "does-not-exist.invalid", port: 443, timeout: 2, queue: queue, transport: transport) { result in
            XCTAssertEqual(result["status"] as? String, "failed")
            XCTAssertFalse((result["error"] as? String ?? "").isEmpty)
            XCTAssertNil(result["durationMs"]); done.fulfill()
        }
        probe.start(); wait(for: [done], timeout: 1)
    }

    func testNetworkSwitchCancelAndLateReadyCompleteOnlyOnce() {
        let queue = DispatchQueue(label: "switch")
        let transport = ControlledTransport()
        let done = expectation(description: "once")
        done.assertForOverFulfill = true
        let probe = TCPProbe(host: "example.com", port: 443, timeout: 2, queue: queue, transport: transport) { result in
            XCTAssertEqual(result["status"] as? String, "cancelled"); done.fulfill()
        }
        probe.start(); queue.sync {}
        let lateHandler = transport.stateUpdate
        probe.cancel(reason: "网络切换")
        queue.async { lateHandler?(.ready) }
        wait(for: [done], timeout: 1)
        queue.sync {}; queue.sync {}
        XCTAssertEqual(transport.cancels, 1)
    }
}
