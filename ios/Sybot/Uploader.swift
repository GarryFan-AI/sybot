import Foundation
import Photos
import UIKit

struct UploaderStop: Error {}
struct DiskFull: Error {}

// 上传引擎：批量查重 → 逐个 原文件导出 → init → 分块(PUT, 409 对账) → complete。
// 与网页引擎同一套服务端语义：服务端 offset 是唯一可信进度，409/断网/重 init 均安全。
@MainActor
final class Uploader: ObservableObject {
    @Published var running = false
    @Published var total = 0
    @Published var okCount = 0
    @Published var skipCount = 0
    @Published var failCount = 0
    @Published var uploadedBytes: Int64 = 0
    @Published var speedMBps = 0.0
    @Published var currentName = ""
    @Published var finishedMessage = ""
    @Published var lines: [String] = []

    private var server: Server!
    private var stopFlag = false
    private var t0: Date?

    var processed: Int { okCount + skipCount + failCount }

    // MARK: - 对外

    func stop() {
        stopFlag = true
        log("收到停止请求，等当前块完成…")
    }

    func run(server srv: Server, albumTag: String, assets: [PHAsset]) async {
        guard !running else { return }
        server = srv
        stopFlag = false
        running = true
        okCount = 0; skipCount = 0; failCount = 0
        uploadedBytes = 0; speedMBps = 0
        currentName = ""; finishedMessage = ""
        UIApplication.shared.isIdleTimerDisabled = true   // 同步期间不息屏
        t0 = Date()
        log("开始同步「\(albumTag.isEmpty ? "全部" : albumTag)」：\(assets.count) 张")

        do {
            var metas: [AssetMeta] = []
            for a in assets { metas.append(contentsOf: Lib.metas(of: a)) }
            total = metas.count
            if total == 0 {
                finishedMessage = "该相册没有可上传的照片/视频"
                log(finishedMessage)
                UIApplication.shared.isIdleTimerDisabled = false
                running = false
                return
            }
            log("展开为 \(total) 个上传项（Live Photo 含配对视频）")

            // 批量查重（≤500/次，零读取）
            var todo: [AssetMeta] = []
            var seen = 0
            for batch in metas.chunked(500) {
                if stopFlag { throw UploaderStop() }
                let items: [[String: Any]] = batch.map {
                    ["name": $0.name, "size": $0.size, "mtime": $0.mtimeMs]
                }
                let res = try await retrying {
                    try await server.postJSON("api/sync/check", [
                        "batchId": Int(Date().timeIntervalSince1970), "items": items,
                    ])
                }
                guard let results = res["results"] as? [[String: Any]] else {
                    throw ApiErr(code: "BAD_SHAPE", message: "check 响应缺少 results",
                                 expected: nil, have: nil, retryAfterMs: nil, status: 0)
                }
                for (i, r) in results.enumerated() where i < batch.count {
                    if (r["state"] as? String) == "done" { skipCount += 1 } else { todo.append(batch[i]) }
                }
                seen += batch.count
                log("查重 \(seen)/\(total)：已存在 \(skipCount)，待传 \(todo.count)")
            }

            for m in todo {
                if stopFlag { throw UploaderStop() }
                do {
                    try await uploadOne(m, albumTag: albumTag)
                } catch is UploaderStop {
                    throw UploaderStop()
                } catch is DiskFull {
                    throw DiskFull()
                } catch let e as ApiErr {
                    failCount += 1
                    log("\(m.name) 失败：\(e.code) \(e.message)")
                } catch {
                    failCount += 1
                    log("\(m.name) 失败：\(error.localizedDescription)")
                }
            }
            finishedMessage = "完成：上传 \(okCount)，已存在 \(skipCount)，失败 \(failCount)"
            log(finishedMessage)
        } catch is UploaderStop {
            finishedMessage = "已停止。重跑同一相册会自动续传/跳过，不重复上传"
            log(finishedMessage)
        } catch is DiskFull {
            finishedMessage = "电脑磁盘空间不足，已中止"
            log(finishedMessage)
        } catch let e as ApiErr {
            finishedMessage = "出错：\(e.code) \(e.message)"
            log(finishedMessage)
        } catch {
            finishedMessage = "出错：\(error.localizedDescription)"
            log(finishedMessage)
        }
        UIApplication.shared.isIdleTimerDisabled = false
        running = false
    }

    // MARK: - 单个资产

    private func uploadOne(_ m: AssetMeta, albumTag: String) async throws {
        currentName = m.name
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("sybot-\(UUID().uuidString)")
        try await Self.writeOriginal(m, to: tmp)
        defer { try? FileManager.default.removeItem(at: tmp) }

        let attrs = try FileManager.default.attributesOfItem(atPath: tmp.path)
        let size = (attrs[.size] as? NSNumber)?.intValue ?? m.size
        if size <= 0 {
            skipCount += 1
            log("\(m.name) 空文件，跳过")
            return
        }

        var inited = try await doInit(m, size: size, albumTag: albumTag)
        if inited.status == "exists" {
            skipCount += 1
            log("\(m.name) 已存在，跳过")
            return
        }

        var uploadId = inited.uploadId
        var token = inited.token
        var offset = inited.offset
        var chunkSize = inited.chunkSize
        var hashRetried = false

        progress: while true {
            // 补齐所有缺失块
            let fh = try FileHandle(forReadingFrom: tmp)
            defer { try? fh.close() }
            while offset < size {
                if stopFlag { throw UploaderStop() }
                try fh.seek(toOffset: UInt64(offset))
                let data = try fh.read(upToCount: chunkSize) ?? Data()
                if data.isEmpty { break }
                var backoff: UInt64 = 1_000_000_000
                chunkRetry: while true {
                    do {
                        let r = try await server.putChunk(
                            "api/upload/\(uploadId)/chunk", offset: offset, token: token, data: data)
                        let recv = (r["received"] as? NSNumber)?.intValue ?? (offset + data.count)
                        if recv > offset { uploadedBytes += Int64(recv - offset) }
                        offset = recv
                        updateSpeed()
                        break chunkRetry
                    } catch let e as ApiErr {
                        switch e.code {
                        case "OFFSET_MISMATCH":
                            offset = e.expected ?? offset
                            break chunkRetry
                        case "UNKNOWN_UPLOAD", "BAD_TOKEN", "SIZE_OVERFLOW":
                            let again = try await doInit(m, size: size, albumTag: albumTag)
                            if again.status == "exists" {
                                skipCount += 1
                                log("\(m.name) 已存在，跳过")
                                return
                            }
                            uploadId = again.uploadId
                            token = again.token
                            offset = again.offset
                            chunkSize = again.chunkSize
                            continue progress
                        case "INSUFFICIENT_SPACE":
                            throw DiskFull()
                        case "RATE_LIMITED":
                            try await Task.sleep(nanoseconds: UInt64(e.retryAfterMs ?? 5000) * 1_000_000)
                        default:
                            if e.status >= 500 {
                                try await Task.sleep(nanoseconds: backoff)
                                backoff = min(backoff * 2, 60_000_000_000)
                            } else {
                                throw e
                            }
                        }
                    } catch is UploaderStop {
                        throw UploaderStop()
                    } catch {
                        try await Task.sleep(nanoseconds: backoff)
                        backoff = min(backoff * 2, 60_000_000_000)
                    }
                }
            }

            // 完成（哈希校验→归档→入库）
            var cbackoff: UInt64 = 1_000_000_000
            compRetry: while true {
                do {
                    let r = try await server.postJSON("api/upload/\(uploadId)/complete", ["token": token])
                    if (r["status"] as? String) == "completed" {
                        okCount += 1
                        log("\(m.name) ✓ \(Self.fmtBytes(Int64(size)))")
                    } else {
                        skipCount += 1
                        log("\(m.name) 内容重复，跳过")
                    }
                    return
                } catch let e as ApiErr {
                    switch e.code {
                    case "SIZE_MISMATCH":
                        offset = e.expected ?? offset
                        continue progress
                    case "HASH_MISMATCH":
                        if hashRetried {
                            failCount += 1
                            log("\(m.name) 哈希校验不符，跳过")
                            return
                        }
                        hashRetried = true
                        let again = try await doInit(m, size: size, albumTag: albumTag)
                        uploadId = again.uploadId
                        token = again.token
                        offset = again.offset
                        chunkSize = again.chunkSize
                        continue progress
                    case "UNKNOWN_UPLOAD", "BAD_TOKEN":
                        let again = try await doInit(m, size: size, albumTag: albumTag)
                        if again.status == "exists" {
                            skipCount += 1
                            log("\(m.name) 已存在，跳过")
                            return
                        }
                        uploadId = again.uploadId
                        token = again.token
                        offset = again.offset
                        chunkSize = again.chunkSize
                        continue progress
                    case "INSUFFICIENT_SPACE":
                        throw DiskFull()
                    case "RATE_LIMITED":
                        try await Task.sleep(nanoseconds: UInt64(e.retryAfterMs ?? 5000) * 1_000_000)
                        continue compRetry
                    default:
                        if e.status >= 500 {
                            try await Task.sleep(nanoseconds: cbackoff)
                            cbackoff = min(cbackoff * 2, 60_000_000_000)
                            continue compRetry
                        }
                        failCount += 1
                        log("\(m.name) 失败：\(e.code) \(e.message)")
                        return
                    }
                } catch is UploaderStop {
                    throw UploaderStop()
                } catch {
                    try await Task.sleep(nanoseconds: cbackoff)
                    cbackoff = min(cbackoff * 2, 60_000_000_000)
                }
            }
        }
    }

    private func doInit(_ m: AssetMeta, size: Int, albumTag: String) async throws -> InitOut {
        var backoff: UInt64 = 1_000_000_000
        while true {
            if stopFlag { throw UploaderStop() }
            do {
                let r = try await server.postJSON("api/upload/init", [
                    "name": m.name,
                    "size": size,
                    "mtime": m.mtimeMs,
                    "type": m.mime,
                    "albumTag": albumTag,
                    "clientUploadId": m.clientUploadId,
                ])
                let out = InitOut(r)
                if out.status != "new" && out.status != "resume" && out.status != "exists" {
                    throw ApiErr(code: "BAD_SHAPE", message: "init status=\(out.status)",
                                 expected: nil, have: nil, retryAfterMs: nil, status: 0)
                }
                return out
            } catch let e as ApiErr {
                switch e.code {
                case "RATE_LIMITED":
                    try await Task.sleep(nanoseconds: UInt64(e.retryAfterMs ?? 5000) * 1_000_000)
                case "INSUFFICIENT_SPACE":
                    throw DiskFull()
                case "INVALID_ARGUMENT":
                    throw e
                default:
                    if e.status >= 500 || e.status == 429 {
                        try await Task.sleep(nanoseconds: backoff)
                        backoff = min(backoff * 2, 60_000_000_000)
                    } else {
                        throw e
                    }
                }
            } catch is UploaderStop {
                throw UploaderStop()
            } catch {
                try await Task.sleep(nanoseconds: backoff)
                backoff = min(backoff * 2, 60_000_000_000)
            }
        }
    }

    private func retrying<T>(_ op: () async throws -> T) async throws -> T {
        var backoff: UInt64 = 1_000_000_000
        while true {
            do {
                return try await op()
            } catch let e as ApiErr {
                if e.code == "INSUFFICIENT_SPACE" { throw DiskFull() }
                if e.code == "RATE_LIMITED" {
                    try await Task.sleep(nanoseconds: UInt64(e.retryAfterMs ?? 5000) * 1_000_000)
                    continue
                }
                if e.status >= 500 || e.status == 429 {
                    try await Task.sleep(nanoseconds: backoff)
                    backoff = min(backoff * 2, 60_000_000_000)
                    continue
                }
                throw e
            } catch is UploaderStop {
                throw UploaderStop()
            } catch {
                try await Task.sleep(nanoseconds: backoff)
                backoff = min(backoff * 2, 60_000_000_000)
            }
        }
    }

    // MARK: - 工具

    private func updateSpeed() {
        guard let t0, t0.timeIntervalSinceNow < -0.5 else { return }
        let el = -t0.timeIntervalSinceNow
        speedMBps = Double(uploadedBytes) / 1_048_576.0 / el
    }

    private static func writeOriginal(_ m: AssetMeta, to url: URL) async throws {
        let opts = PHAssetResourceRequestOptions()
        opts.isNetworkAccessAllowed = true   // iCloud 未下载的原件会临时从云端拉取
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            PHAssetResourceManager.default().writeData(
                for: m.resource, toFile: url, options: opts
            ) { err in
                if let err { cont.resume(throwing: err) } else { cont.resume() }
            }
        }
    }

    static func fmtBytes(_ b: Int64) -> String {
        let f = ByteCountFormatter()
        f.countStyle = .file
        return f.string(fromByteCount: b)
    }

    private static func ts() -> String {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        return f.string(from: Date())
    }

    func log(_ s: String) {
        let line = "\(Self.ts())  \(s)"
        lines.append(line)
        if lines.count > 300 { lines.removeFirst(lines.count - 300) }
    }
}

private struct InitOut {
    let status: String
    let uploadId: String
    let token: String
    let offset: Int
    let chunkSize: Int

    init(_ r: [String: Any]) {
        status = r["status"] as? String ?? ""
        uploadId = (r["uploadId"] as? String) ?? String(describing: r["uploadId"] ?? "")
        token = r["token"] as? String ?? ""
        offset = (r["offset"] as? NSNumber)?.intValue ?? 0
        chunkSize = (r["chunkSize"] as? NSNumber)?.intValue ?? (4 * 1024 * 1024)
    }
}
