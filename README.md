# sync-iphone-pic

局域网 iPhone 照片/视频同步到电脑。电脑跑一个 Node 服务端，iPhone 用 Safari 打开网页即可批量上传，支持**断点续传、增量去重、相册结构归档**。类 LocalSend 的定位，但专门解决"整库照片备份"这件事——LocalSend 本身无断点续传、无去重跳过、无目录结构（调研结论见下）。

## 功能

- **一次性全量同步**：iPhone 系统选择器单次最多可选 999 张（实测 Safari 一次几十张更稳），页面按"滚动批次"推进：每轮选一批 → 已传的**秒级跳过**（零文件读取）→ 只传新内容 → 一键继续下一批，直到某批全部"已存在"即完成全量。
- **断点续传**：单文件按 4/8MB 分块，服务端 `ftruncate + fsync` 后才确认 offset；页面刷新/锁屏/断网/服务端重启后，从服务端 offset 续传，**已传字节零重传**。
- **增量去重**（三级）：`quickKey(name+size+mtime)` 秒查重 → 客户端内容 SHA-256（≤64MB 文件）→ 服务端 complete 时重算 SHA-256（权威，`UNIQUE` 兜底）。同名不同内容以 `-<sha8>` 后缀共存，绝不覆盖。
- **相册结构**：网页拿不到 iOS 相册名（平台限制），用"批次标签"方式：每轮选一个相册的照片 + 填同一个相册名，服务端落盘 `<相册名>/<YYYY-MM>/<原文件名>`。
- **浏览页**：手机上直接浏览已同步内容（iPhone Safari 可直接渲染 HEIC/MOV），按相册/月份筛选。
- **安全**：仅私网段可访问 + 链接内 12 位随机密钥 + 分块级 HMAC token；明文 HTTP（局域网内）。

## 快速开始

```bash
npm install          # 安装 exifr（EXIF 解析）；qrcode 为开发依赖（终端二维码）
npm run firewall     # 放行防火墙端口（需管理员 PowerShell；或手动放行 TCP 5284）
npm start            # 启动，控制台打印候选地址 + 二维码
```

Wi-Fi 若被 Windows 识别为"公用网络"，需改为专用（或放行对应配置文件）：
`Set-NetConnectionProfile -InterfaceAlias WLAN -NetworkCategory Private`

## iPhone 端操作

**方式零：原生 App（全量同步最佳路径）** —— 真正遍历全库、原文件直传（HEIC 不转码）、视频+Live Photo 配对视频全支持、断点续传。Windows 上经 GitHub Actions 云构建 + Sideloadly 免费签名安装，见 **`docs/app-install.md`**。

**方式一：快捷指令（照片自动化备选）** —— 程序化遍历相册/全库逐个上传，免手动点选，能自动带相册名归档。搭建约 10 分钟，见 **`docs/shortcut-guide.md`**。注意串行速度（约 1-2 秒/张），全量分时段挂机跑；中断重跑即可（服务端去重保证安全）。

**方式二：网页批量（视频主力）** —— Safari 打开同步页：

1. 电脑与 iPhone 连同一 Wi-Fi，扫启动时打印的二维码（链接内含访问密钥）。
2. 首次选择照片时，权限选"选择照片… → 所有照片"。
3. 填相册名（可留空=未整理）→ 点"选择照片 / 视频"→ 在系统选择器里**拖动多选**（视频会触发系统"正在准备"导出）→ 页面自动查重+上传。
4. 队列排空后点"**继续下一批**"重复，直到某批全部显示"已存在"。
5. 可"添加到主屏幕"当 App 用（HTTP 下无 Service Worker，但独立窗口可用）。
6. 中断（锁屏/断网/刷新）后重新打开页面 → 重选同一相册 → 已传的秒跳、半成品从断点续传。

## 配置（config.json，首次运行自动生成）

| 字段 | 默认 | 说明 |
|---|---|---|
| `port` | 5284 | 服务端口 |
| `accessKey` | 自动生成 | 访问密钥（链接内） |
| `storageRoot` | `data/storage` | 照片落盘根目录（可指向其他盘） |
| `maxChunkBytes` | 12MB | 单块请求体上限 |
| `maxInFlight` | 200 | 在途上传上限 |
| `incomingTtlHours` | 72 | .incoming 半成品 TTL |
| `hashMaxBytes` | 64MB | 客户端做内容哈希的尺寸阈值 |
| `rateLimitQps` | 200 | 每 IP 限速 |

环境变量 `SIPP_PORT` / `SIPP_ACCESS_KEY` / `SIPP_STORAGE_ROOT` / `SIPP_INCOMING_TTL_HOURS` 可覆盖。

## 数据与运维

- 落盘：`<storageRoot>/<相册>/<YYYY-MM>/<原文件名>`，重名追加 `-<sha8前8位>`；HEIC/原始格式原样保留不转码。
- 数据库：`data/app.db`（node:sqlite, WAL）；`uploads` 表只在途（complete 后迁入 `assets`）。
- 备份：`POST /api/admin/backup`（VACUUM INTO 到 `data/backups/`）。
- 日志：`data/logs/server-YYYY-MM-DD.log`（JSON 行，保留 14 天）。
- 清理：sweeper 每 10 分钟跑：canceled 即删；receiving 超 72h → abandoned；abandoned 再超 72h → 删；孤儿 .part 删。手动触发：`POST /api/admin/cleanup`。
- Windows Defender 实时扫描会拖慢写盘，建议把 `storageRoot` 加入排除项。

## 协议要点（与 LocalSend 的差异）

LocalSend v2：UDP 组播发现（224.0.0.167:53317）+ HTTPS/mTLS + `prepare-upload`/`upload` 两段式；无 Range 续传、无跳过已存在、无目录结构。本项目为"电脑做服务端的备份管道"重设计：

| 端点 | 说明 |
|---|---|
| `POST /api/sync/check` | 批量指纹查重（≤2000 条/次），返回 done/partial/new |
| `POST /api/upload/init` | `{name,size,mtime,albumTag,clientUploadId,sha256?}` → new/resume(offset)/exists；clientUploadId 幂等 |
| `PUT /api/upload/:id/chunk` | 原始字节体 + `X-Offset`/`X-Token`；offset≠received → 409+`expected` |
| `GET /api/upload/:id` | 对账（刷新/断网恢复入口） |
| `POST /api/upload/:id/complete` | 大小校验 → worker 重算 sha256 → EXIF/mvhd 日期 → rename 归档 → 事务入库 |
| `POST /api/quick` | **快捷指令直传**：整文件单请求（原始体流式落盘 / multipart 均可），服务端走同一查重/哈希/归档流水线。搭建步骤见 `docs/shortcut-guide.md` |
| `GET /api/albums` `/api/assets` `/api/media/:id` `/api/stats` | 浏览与统计 |

错误码：409 `OFFSET_MISMATCH`(+expected)、422 `SIZE_MISMATCH`（.part 保留可续）/`HASH_MISMATCH`（重来）、404 `UNKNOWN_UPLOAD`（客户端重新 init）、503 `INSUFFICIENT_SPACE`（客户端停整批）。5xx/网络错误指数退避（1s→60s ±30% 抖动）无限重试；不可恢复 4xx 标 failed 跳过不打断整批。

## 已知限制（平台硬约束）

- **明文 HTTP**：iPhone 经 `http://IP` 访问 → `crypto.subtle`/Wake Lock/Service Worker 不可用（非安全上下文）；同网段可被嗅探，私密内容慎传。要升级 HTTPS 需自建 CA + iPhone 装描述文件，未做。
- **无后台备份**：iOS 无 Background Sync/Fetch；页面切后台 JS 即挂起。上传必须前台亮屏进行。
- **Live Photo**：网页选择器只返回静态图，配对 .MOV 拿不到；服务端只做 `live_base` 疑似配对标记。
- **拍摄日期**：来自 EXIF `DateTimeOriginal`(+`OffsetTimeOriginal`) → MOV `mvhd` → 文件 mtime → 上传当天（`date_source` 字段落库）。exifr 按服务器本地时区解释无偏移墙钟。
- **7 天不访问**网页：Safari ITP 清站点数据（本地缓存），不影响服务端续传状态。
- **锁定模式**（Lockdown Mode）会禁用 File API，无法上传。

## 测试

```bash
node scripts/test-sha256.mjs        # 前端哈希 vs node crypto（17 尺寸+分片）
node scripts/test-exifdate.js       # EXIF/mvhd/mtime 日期链（先 python scripts/make-exif-sample.py）
node scripts/stress-upload.js       # 分块续传压测（--kill-at-chunk/--bad-offset/--drop-after/--resume/--count）
node scripts/test-archive.js        # 相册清洗/重名后缀/魔数/Live 基名
node scripts/test-engine.mjs        # 真实客户端引擎集成（Node 驱动真实代码打真实服务端）
node scripts/test-browser.mjs       # 真实 Chrome E2E（UI + 引擎 + 刷新恢复场景）
```

关键验收已覆盖：kill -9 服务端后续传 sha 一致、错 offset 409+expected、不完整 complete 422 且 .part 可续、同 offset 重复写幂等、重复批次零传输、刷新重选秒跳+半成品续传、中文/emoji/非法相册名、同名不同内容 `-<sha8>` 共存、内容相同异名去重。

## 吞吐与人工成本预期

10 万张 ≈ 300GB：机器侧约 4h（千兆 Wi-Fi）；**人工侧是瓶颈**——每轮选 120–300 张 ≈ 300–800 轮。UI 提供一键"继续下一批"（重开选择器 + 相册名回填）。若单轮实测低于 100 张（iPhone Safari 内存限制），可考虑后续补一个 iOS 快捷指令路径（按相册遍历上传，能拿相册名），本项目当前未实现。
