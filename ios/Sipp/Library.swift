import Foundation
import Photos

// 照片库访问：真实相册枚举 + 资产元数据（原文件名/大小/拍摄时间）。
// 原文件经 PHAssetResource 取出（HEIC/原始格式不转码）。
struct AlbumEntry: Identifiable {
    let id: String
    let title: String
    let count: Int
    let isWholeLibrary: Bool
    let fetch: PHFetchResult<PHAsset>
}

struct AssetMeta {
    enum Kind { case photo, video, liveVideo }
    let asset: PHAsset
    let resource: PHAssetResource
    let name: String        // 原始文件名，如 IMG_1234.HEIC / IMG_1234.mov
    let size: Int           // resource.fileSize（无需读文件）
    let mtimeMs: Int64      // 拍摄时间 epoch 毫秒（quickKey 用）
    let kind: Kind

    var mime: String {
        switch kind {
        case .photo:
            return name.lowercased().contains("heic") || name.lowercased().contains("heif")
                ? "image/heic" : "image/jpeg"
        case .video, .liveVideo:
            return name.lowercased().hasSuffix(".mp4") ? "video/mp4" : "video/quicktime"
        }
    }

    var clientUploadId: String {
        var id = asset.localIdentifier.replacingOccurrences(
            of: "[^A-Za-z0-9_-]", with: "_", options: .regularExpression)
        if id.count > 110 { id = String(id.prefix(110)) }
        switch kind {
        case .photo: return id + "-p"
        case .video: return id + "-v"
        case .liveVideo: return id + "-l"
        }
    }
}

enum Lib {
    static var status: PHAuthorizationStatus { PHPhotoLibrary.authorizationStatus(for: .readWrite) }

    static func requestAccess() async -> PHAuthorizationStatus {
        await withCheckedContinuation { cont in
            PHPhotoLibrary.requestAuthorization(for: .readWrite) { s in cont.resume(returning: s) }
        }
    }

    /// 用户相册 + 整库伪相册，按数量降序
    static func albums() -> [AlbumEntry] {
        let opts = PHFetchOptions()
        opts.includeHiddenAssets = false
        opts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: true)]
        opts.predicate = NSPredicate(
            format: "mediaType == %d OR mediaType == %d",
            PHAssetMediaType.image.rawValue, PHAssetMediaType.video.rawValue)

        var out: [AlbumEntry] = []
        let colls = PHAssetCollection.fetchAssetCollections(with: .album, subtype: .any, options: nil)
        colls.enumerateObjects { c, _, _ in
            let f = PHAsset.fetchAssets(in: c, options: opts)
            guard f.count > 0 else { return }
            out.append(AlbumEntry(id: c.localIdentifier, title: c.localizedTitle ?? "未命名相册",
                                  count: f.count, isWholeLibrary: false, fetch: f))
        }
        let all = PHAsset.fetchAssets(with: opts)
        out.insert(AlbumEntry(id: "__whole__", title: "整库（全部照片+视频）",
                              count: all.count, isWholeLibrary: true, fetch: all), at: 0)
        return out.sorted { $0.count > $1.count }
    }

    static func assets(of e: AlbumEntry) -> [PHAsset] {
        var a: [PHAsset] = []
        a.reserveCapacity(e.fetch.count)
        e.fetch.enumerateObjects { x, _, _ in a.append(x) }
        return a
    }

    /// 一个 PHAsset 拆成 1~2 个上传项：本体 + Live Photo 配对视频
    static func metas(of a: PHAsset) -> [AssetMeta] {
        var out: [AssetMeta] = []
        let rs = PHAssetResource.assetResources(for: a)
        let mtime = Int64((a.creationDate?.timeIntervalSince1970 ?? 0) * 1000)

        let isVideo = a.mediaType == .video
        let primary = rs.first { $0.type == .video }
            ?? rs.first { $0.type == .photo }
            ?? rs.first { $0.type == .fullSizeVideo }
            ?? rs.first { $0.type == .fullSizePhoto }
        if let r = primary {
            out.append(AssetMeta(asset: a, resource: r, name: r.originalFilename,
                                 size: r.fileSize, mtimeMs: mtime,
                                 kind: isVideo ? .video : .photo))
        }
        if a.mediaSubtypes.contains(.photoLive), let pv = rs.first(where: { $0.type == .pairedVideo }) {
            out.append(AssetMeta(asset: a, resource: pv, name: pv.originalFilename,
                                 size: pv.fileSize, mtimeMs: mtime, kind: .liveVideo))
        }
        return out
    }
}

extension Array {
    func chunked(_ n: Int) -> [[Element]] {
        guard n > 0 else { return [self] }
        return stride(from: 0, to: count, by: n).map { Array(self[$0..<Swift.min($0 + n, count)]) }
    }
}
