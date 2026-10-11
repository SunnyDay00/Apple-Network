import Foundation
import Network

public final class HTTPSProbe: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate {
    private let queue: DispatchQueue
    private let host: String
    private let port: Int
    private let timeout: Double
    private let completion: ([String: Any]) -> Void
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var timer: DispatchWorkItem?
    private var started: UInt64 = 0
    private var finished = false
    private var statusCode: Int?
    private var transactions: [[String: Any]] = []
    private var redirectCount = 0
    private var rejection: String?
    private var cancelReason: String?

    public init(host: String, port: Int, timeout: Double, queue: DispatchQueue,
                completion: @escaping ([String: Any]) -> Void) {
        self.host = host; self.port = port; self.timeout = timeout
        self.queue = queue; self.completion = completion
        super.init()
    }

    public func start() {
        queue.async { [self] in
            guard !finished, session == nil else { return }
            var components = URLComponents()
            components.scheme = "https"
            components.host = host.contains(":") ? "[\(host)]" : host
            components.port = port
            components.path = "/"
            guard let url = components.url else { finish(error: "无效的 HTTPS 地址", status: "failed"); return }
            let config = URLSessionConfiguration.ephemeral
            config.urlCache = nil
            config.httpCookieStorage = nil
            config.urlCredentialStorage = nil
            config.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
            config.timeoutIntervalForRequest = timeout
            config.timeoutIntervalForResource = timeout
            config.waitsForConnectivity = false
            let delegateQueue = OperationQueue()
            delegateQueue.maxConcurrentOperationCount = 1
            delegateQueue.underlyingQueue = queue
            session = URLSession(configuration: config, delegate: self, delegateQueue: delegateQueue)
            var request = URLRequest(url: url)
            request.httpMethod = "HEAD"
            request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
            started = DispatchTime.now().uptimeNanoseconds
            task = session?.dataTask(with: request)
            let item = DispatchWorkItem { [weak self] in
                guard let self else { return }
                if let reason = self.cancelReason { self.finish(error: reason, status: "cancelled") }
                else { self.finish(error: "HTTPS 请求超时", status: "timeout") }
            }
            timer = item
            queue.asyncAfter(deadline: .now() + timeout, execute: item)
            task?.resume()
        }
    }

    public func cancel(reason: String = "用户取消") {
        queue.async { [self] in
            cancelReason = reason
            // URLSession delivers task metrics before didCompleteWithError.
            // A deadline fallback covers a delegate that fails to complete promptly.
            task?.cancel()
            if task == nil { finish(error: reason, status: "cancelled") }
        }
    }

    private func ms(_ start: Date?, _ end: Date?) -> Any {
        guard let start, let end, end >= start else { return NSNull() }
        return end.timeIntervalSince(start) * 1000
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask,
                           didFinishCollecting metrics: URLSessionTaskMetrics) {
        guard !finished else { return }
        transactions = metrics.transactionMetrics.map { m in
            let proto = m.networkProtocolName ?? "unknown"
            let isQUIC = proto.lowercased().hasPrefix("h3") || proto.lowercased().contains("quic")
            return [
                "url": m.request.url?.absoluteString ?? "",
                "dnsMs": ms(m.domainLookupStartDate, m.domainLookupEndDate),
                // connectEnd includes TLS for HTTPS. Subtract TLS by ending at secureConnectionStart.
                "tcpMs": isQUIC ? NSNull() : ms(m.connectStartDate, m.secureConnectionStartDate ?? m.connectEndDate),
                "tlsMs": ms(m.secureConnectionStartDate, m.secureConnectionEndDate),
                "ttfbMs": ms(m.requestStartDate, m.responseStartDate),
                "totalMs": ms(m.fetchStartDate, m.responseEndDate),
                "protocol": proto, "reused": m.isReusedConnection,
                "cached": m.resourceFetchType == .localCache,
                "interface": m.isCellular ? "cellular" : "other",
                "localAddress": m.localAddress ?? "", "remoteAddress": m.remoteAddress ?? "",
                "statusCode": (m.response as? HTTPURLResponse)?.statusCode as Any? ?? NSNull()
            ]
        }
    }

    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                           didReceive response: URLResponse,
                           completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        statusCode = (response as? HTTPURLResponse)?.statusCode
        completionHandler(.allow)
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask,
                           willPerformHTTPRedirection response: HTTPURLResponse,
                           newRequest request: URLRequest,
                           completionHandler: @escaping (URLRequest?) -> Void) {
        redirectCount += 1
        guard redirectCount <= 5, request.url?.scheme == "https",
              request.url?.user == nil, request.url?.password == nil else {
            rejection = "重定向超过 5 次或重定向地址不符合 HTTPS 安全限制"
            completionHandler(nil); return
        }
        var next = request
        next.httpMethod = "HEAD"
        completionHandler(next)
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let cancelReason { finish(error: cancelReason, status: "cancelled") }
        else if let rejection { finish(error: rejection, status: "failed") }
        else if let error {
            let timedOut = (error as NSError).code == NSURLErrorTimedOut
            finish(error: error.localizedDescription, status: timedOut ? "timeout" : "failed")
        } else { finish(error: nil, status: "success") }
    }

    private func finish(error: String?, status: String) {
        guard !finished else { return }
        finished = true
        let elapsed = started == 0 ? 0 : Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000
        var result: [String: Any] = [
            "status": status, "elapsedMs": elapsed, "dnsIncluded": false,
            "interface": transactions.last?["interface"] ?? "other",
            "metrics": transactions, "redirects": redirectCount
        ]
        if status == "success" { result["durationMs"] = elapsed }
        if let error { result["error"] = error }
        if let statusCode { result["statusCode"] = statusCode }
        timer?.cancel(); timer = nil
        task?.cancel(); task = nil
        session?.invalidateAndCancel(); session = nil
        completion(result)
    }
}
