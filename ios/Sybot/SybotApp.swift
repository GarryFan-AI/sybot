import SwiftUI
import Photos

@main
struct SybotApp: App {
    var body: some Scene {
        WindowGroup { RootView() }
    }
}

struct RootView: View {
    @StateObject private var server = Server()
    @StateObject private var uploader = Uploader()
    @State private var albums: [AlbumEntry] = []
    @State private var perm: PHAuthorizationStatus = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    @State private var healthMsg = ""

    var body: some View {
        if uploader.running {
            RunView(uploader: uploader)
        } else {
            home
        }
    }

    private var home: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("电脑地址，如 http://172.22.1.188:5284", text: $server.host)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("访问密钥", text: $server.key)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                    Button("测试连接") {
                        Task {
                            do {
                                let h = try await server.health()
                                let free = Uploader.fmtBytes((h["freeBytes"] as? NSNumber)?.int64Value ?? 0)
                                healthMsg = "✓ 连接正常 v\(h["version"] as? String ?? "?")，磁盘剩余 \(free)"
                                server.save()
                            } catch {
                                healthMsg = "✗ \(Self.errText(error))"
                            }
                        }
                    }
                    Text(healthMsg).font(.footnote).foregroundStyle(.secondary)
                } header: {
                    Text("电脑服务")
                }

                Section {
                    if perm == .authorized || perm == .limited {
                        if albums.isEmpty {
                            Text("没有可同步的相册").foregroundStyle(.secondary)
                        }
                        ForEach(albums) { a in
                            Button {
                                start(a)
                            } label: {
                                HStack {
                                    Text(a.title).foregroundStyle(.primary)
                                    Spacer()
                                    Text("\(a.count) 项").foregroundStyle(.secondary).font(.footnote)
                                }
                            }
                        }
                    } else {
                        Button("授权照片访问") {
                            Task {
                                perm = await Lib.requestAccess()
                                if perm == .authorized || perm == .limited { albums = Lib.albums() }
                            }
                        }
                    }
                } header: {
                    Text("相册（点按开始同步）")
                } footer: {
                    Text("随时可中断重跑：已传的自动跳过，半截视频从断点续传。重名不同内容的照片都会保留。")
                }

                if !uploader.finishedMessage.isEmpty {
                    Section("上次结果") {
                        Text(uploader.finishedMessage).font(.footnote)
                    }
                }
            }
            .navigationTitle("照片同步")
            .task {
                perm = Lib.status
                if perm == .authorized || perm == .limited { albums = Lib.albums() }
            }
        }
    }

    private func start(_ a: AlbumEntry) {
        server.save()
        let assets = Lib.assets(of: a)
        let tag = a.isWholeLibrary ? "全部" : a.title
        Task { await uploader.run(server: server, albumTag: tag, assets: assets) }
    }

    static func errText(_ e: Error) -> String {
        if let ae = e as? ApiErr { return "\(ae.code) \(ae.message)" }
        return e.localizedDescription
    }
}

struct RunView: View {
    @ObservedObject var uploader: Uploader

    private var progress: Double {
        uploader.total == 0 ? 0 : Double(uploader.processed) / Double(uploader.total)
    }

    var body: some View {
        VStack(spacing: 14) {
            ProgressView(value: progress)
                .padding(.horizontal)
            Text("总 \(uploader.total)｜已传 \(uploader.okCount)｜跳过 \(uploader.skipCount)｜失败 \(uploader.failCount)")
                .font(.callout)
            Text("速度 \(String(format: "%.1f", uploader.speedMBps)) MB/s，已传 \(Uploader.fmtBytes(uploader.uploadedBytes))")
                .font(.footnote).foregroundStyle(.secondary)
            Text(uploader.currentName.isEmpty ? "…" : uploader.currentName)
                .font(.caption).lineLimit(1)
                .foregroundStyle(.secondary)
                .padding(.horizontal)
            Button("停止", role: .destructive) { uploader.stop() }
                .buttonStyle(.borderedProminent)
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(Array(uploader.lines.enumerated()), id: \.offset) { i, line in
                            Text(line)
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .id(i)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal)
                }
                .onChange(of: uploader.lines.count) { _ in
                    if !uploader.lines.isEmpty {
                        proxy.scrollTo(uploader.lines.count - 1, anchor: .bottom)
                    }
                }
            }
        }
        .padding(.vertical)
    }
}
