import Foundation

// 服务端 API 客户端。契约见 server/api.js：
//   错误信封 {"error":{code,message,expected?,retryAfterMs?}}；成功为平铺 JSON。
//   init → {status:'new'|'resume'|'exists', uploadId, token, offset, chunkSize}
//   chunk(PUT, X-Offset/X-Token) → {received}；409 OFFSET_MISMATCH+expected
//   complete(X-Token 头或 json body) → {status:'completed'|'exists', ...}
final class Server: ObservableObject {
    @Published var host: String
    @Published var key: String

    static let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 300      // 大块传输
        c.timeoutIntervalForResource = 3600
        return URLSession(configuration: c)
    }()

    init() {
        let d = UserDefaults.standard
        host = d.string(forKey: "sybot.host") ?? "http://172.22.1.188:5284"
        key = d.string(forKey: "sybot.key") ?? ""
    }

    func save() {
        let d = UserDefaults.standard
        d.set(host, forKey: "sybot.host")
        d.set(key, forKey: "sybot.key")
    }

    var base: URL? {
        var h = host.trimmingCharacters(in: .whitespacesAndNewlines)
        while h.hasSuffix("/") { h.removeLast() }
        let k = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !k.isEmpty, let u = URL(string: h + "/k/" + k) else { return nil }
        return u
    }

    private func decode(_ data: Data, _ resp: URLResponse) throws -> [String: Any] {
        let http = resp as? HTTPURLResponse
        let code = http?.statusCode ?? 0
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        if let e = obj["error"] as? [String: Any] {
            throw ApiErr(
                code: (e["code"] as? String) ?? "HTTP_\(code)",
                message: (e["message"] as? String) ?? "HTTP \(code)",
                expected: e["expected"] as? Int,
                have: e["have"] as? Int,
                retryAfterMs: e["retryAfterMs"] as? Int,
                status: code
            )
        }
        guard (200...299).contains(code) else {
            throw ApiErr(code: "HTTP_\(code)", message: "HTTP \(code)", expected: nil, have: nil,
                         retryAfterMs: nil, status: code)
        }
        return obj
    }

    private func request(_ method: String, _ path: String, body: Data?, headers: [String: String]) async throws -> [String: Any] {
        guard let b = base else {
            throw ApiErr(code: "NO_SERVER", message: "未填写服务器地址或密钥", expected: nil, have: nil,
                         retryAfterMs: nil, status: 0)
        }
        guard let u = URL(string: b.absoluteString + "/" + path) else {
            throw ApiErr(code: "BAD_URL", message: "地址非法：\(b.absoluteString)/\(path)",
                         expected: nil, have: nil, retryAfterMs: nil, status: 0)
        }
        var r = URLRequest(url: u)
        r.httpMethod = method
        r.httpBody = body
        for (k, v) in headers { r.setValue(v, forHTTPHeaderField: k) }
        let (data, resp) = try await Self.session.data(for: r)
        return try decode(data, resp)
    }

    func getJSON(_ path: String) async throws -> [String: Any] {
        try await request("GET", path, body: nil, headers: [:])
    }

    func postJSON(_ path: String, _ body: [String: Any]) async throws -> [String: Any] {
        let data = try JSONSerialization.data(withJSONObject: body)
        return try await request("POST", path, body: data, headers: ["Content-Type": "application/json"])
    }

    func putChunk(_ path: String, offset: Int, token: String, data: Data) async throws -> [String: Any] {
        try await request("PUT", path, body: data, headers: [
            "Content-Type": "application/octet-stream",
            "X-Offset": String(offset),
            "X-Token": token,
        ])
    }

    func health() async throws -> [String: Any] { try await getJSON("api/health") }
}

struct ApiErr: Error {
    let code: String
    let message: String
    let expected: Int?
    let have: Int?
    let retryAfterMs: Int?
    let status: Int
}
