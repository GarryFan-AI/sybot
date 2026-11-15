# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

局域网 iPhone 照片/视频同步：Windows 电脑跑 Node 服务端（本目录），iPhone 三种客户端上传——**原生 App（`ios/`，SwiftUI，全量同步主力）/ iOS 快捷指令（`docs/shortcut-guide.md`）/ Safari 网页**。设计文档见 `README.md`；协议与验收标准见计划文件（CLAUDE plans: parallel-kindling-thunder）。

## 常用命令

```bash
npm start                        # 启动服务（端口 5284，控制台打印二维码）
npm run firewall                 # 放行防火墙（需管理员 PowerShell）
npm run stress -- --size 8MB     # 压测：--kill-at-chunk N / --bad-offset / --drop-after N / --resume / --count N
node scripts/test-browser.mjs    # 真实 Chrome E2E（需本机 Chrome + 服务已启动）
node scripts/test-engine.mjs     # Node 直接驱动真实客户端引擎
node scripts/test-exifdate.js    # 日期链验证（先: python scripts/make-exif-sample.py）
node scripts/test-archive.js     # 归档验收（需服务已启动）
node scripts/test-quick.js       # /api/quick 直传端点验收（需服务已启动）
node scripts/test-sha256.mjs     # 纯 JS SHA-256 对照
```

多数测试脚本要求服务端已在 5284 端口运行（从 `config.json` 读 `accessKey` 构造带密钥 URL）。

## iOS 原生 App（ios/）

- `ios/Sybot/`（约 800 行 Swift）：`Uploader.swift`（分块续传状态机，同一套 HTTP 协议）、`Server.swift`（URLSession + UserDefaults 存配置）、`Library.swift`（PHAsset 遍历/导出）、`SybotApp.swift`。PHAsset 原文件直传（HEIC 不转码），支持视频和 Live Photo 配对 .MOV，同步期间 `isIdleTimerDisabled` 防息屏。
- **本机无 macOS/Xcode**：`project.yml` 是 xcodegen 工程描述，Xcode 工程由 `.github/workflows/ios.yml` 在 `macos-14` 上 `xcodegen generate` + `xcodebuild`（未签名）生成，产物为未签名 IPA，用户用 Sideloadly 免费签名安装（7 天有效）。推送 `ios/**` 自动触发云构建。**不要尝试在 Windows 本地构建 iOS**。

## 架构速记

- 服务端 `server/`：CommonJS、零框架（node:http）。正确性核心 = `uploads.js`（DB `received` 是唯一可信 offset；写块前 `ftruncate` + `fsync` 后才提交）+ `hashworker.js`（complete 时 worker 重算 sha256）。
- 数据 `data/app.db`：node:sqlite（WAL）。`uploads` 只存"在途"，complete 后 DELETE 并迁入 `assets`（`sha256 UNIQUE` 是内容去重权威）。
- 前端 `web/`：ES modules 无构建。`engine.js` 状态机：任何中断先对账（GET upload/:id）再续传；明文 HTTP 下 `crypto.subtle` 不可用 → `vendor/sha256.js` 纯 JS 哈希。
- 三种客户端走同一服务端流水线（查重→哈希→EXIF/mvhd 日期→归档→入库）：网页/App 用分块协议（`/api/sync/check` → `/api/upload/init` → `PUT chunk` → `/api/upload/:id/complete`），快捷指令用单请求直传 `/api/quick`（大文件无断点，适合照片不适合视频）。
- 去重三级：quickKey(name+size+mtime) → 客户端 sha(≤64MB) → 服务端 sha UNIQUE。`(name,size)` 兜底仅在 mtime=0 时启用（宁漏传不误跳）。
- 落盘 `<相册>/<YYYY-MM>/<名>`；重名 `-<sha8>` 后缀；扩展名以魔数嗅探为准。

## 注意

- 本机源文件曾出现过"Write 写入的文本被混入字面 NUL 控制字节"的问题（CLAUDE.md 自身就中过招）：涉及转义序列时用 `String.fromCharCode(0)` 这类构造，写完用 grep/od 验证无 `\u0000`。
- 在 bash 里用 `node -e` 打补丁后，Edit 工具可能基于陈旧快照；改文件优先 Write 全量重写 + grep 验证。
- Git Bash 下 curl 传中文会乱码（控制台编码），测 UTF-8 链路用 node fetch。
- 服务端重启后分块 token 失效（HMAC 随机密钥）属预期：客户端 init 重试即可恢复。
- 配置在 `config.json`（首次运行自动生成），环境变量 `SYBOT_PORT`/`SYBOT_ACCESS_KEY`/`SYBOT_STORAGE_ROOT` 等可覆盖；`storageRoot` 默认 `data/storage`，可指向其他盘。
