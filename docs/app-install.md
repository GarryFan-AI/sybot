# iPhone 原生 App（Sipp）安装指南

Windows 上没有 macOS/Xcode，无法直接编译 iOS 应用。流程：

```
GitHub Actions（云端 macOS）自动编译 → 产出未签名 IPA（Actions 产物下载）
    ↓ 拷到 Windows
Sideloadly（免费 Apple ID 现场签名）→ USB 安装到 iPhone
```

App 用完你的免费 Apple ID 签名，**有效期 7 天**，到期重新装一次即可（数据/进度无损，服务端去重保证不重传）。

## 一、首次准备（约 15 分钟）

1. **GitHub 账号**：注册 github.com，新建一个**私有**仓库（如 `sync-iphone-pic`）。
2. 把本项目推上去（在项目目录执行，按提示登录）：

   ```bash
   git remote add origin https://github.com/<你的用户名>/sync-iphone-pic.git
   git push -u origin main
   ```

3. **触发云构建**：GitHub 网页 → 仓库 → Actions → `ios-build` → Run workflow；或直接 push `ios/` 下的改动自动触发。约 3–5 分钟后，构建页底部 **Artifacts** 下载 `Sipp-unsigned-ipa`（是个 zip，解压出 `Sipp.ipa`）。
4. **Windows 装 USB 驱动**：Microsoft Store 装「Apple Devices」（或装 iTunes），手机插 USB 点「信任」。
5. **iPhone 开发者模式**：设置 → 隐私与安全性 → 开发者模式 → 开启（会要求重启）。
6. **装 Sideloadly**：sideloadly.io 下载 Windows 版并安装。

## 二、安装到手机（每次 2 分钟）

1. 手机插电脑，打开 Sideloadly。
2. 拖入 `Sipp.ipa`，填你的 Apple ID，点 **Start**。
3. 完成后手机桌面出现「照片同步」。
4. 首次打开：允许照片访问（选**所有照片**）、允许本地网络。

## 三、App 里怎么用

1. 填电脑地址（如 `http://172.22.1.188:5284`）+ 访问密钥 → **测试连接**。
2. 相册列表里点一个相册（或「整库」）→ 开始同步，亮屏挂机即可（App 会自动保持屏幕常亮）。
3. 中断了/关了 App：重新点同一相册，已传的秒跳、半截文件从断点续传。
4. 视频、Live Photo（含配对的小视频）、HEIC 原始格式**全部原样直传**，不转码。

## 四、7 天签名过期

- App 打不开/提示不受信任时：重新跑一遍「二、安装到手机」覆盖安装即可。
- 想免手动：改用 **AltStore/SideStore**（同 Wi-Fi 下自动续签），首次配置稍多。

## 五、免费 Apple ID 的限制

- 同一设备最多 3 个自签 App、每周 10 个 App ID（本项目只用 1 个，够用）。
- 与付费开发者账号的区别只是有效期（7 天 vs 90 天），功能无差别。

## 故障排查

| 现象 | 处理 |
|---|---|
| Actions 构建失败 | 看 Actions 日志第一个红叉步骤；把日志发给 Claude 修 |
| Sideloadly 报找不到设备 | 装了「Apple Devices」后重启电脑；换数据线；手机解锁状态再试 |
| 装完 App 打不开 | 开发者模式没开（设置 → 隐私与安全性 → 开发者模式）；或签名过期，重装 |
| App 测试连接失败 | 电脑服务没启动/防火墙；手机与电脑需同一 Wi-Fi（USB 只用于安装，上传走 Wi-Fi） |
| 上传中卡住 | 手机切到蜂窝就会失败，确认 Wi-Fi；电脑端 `data/logs` 可看请求是否到达 |
