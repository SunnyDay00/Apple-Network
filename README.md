# 苹果网络探针 · Apple Network Probe

在 iPhone 上测量 Apple 公开域名的实际 TCP 建连耗时，比较 Wi-Fi 和蜂窝网络的耗时、尾延迟、波动及连接失败率。前端可在 Windows 预览，iOS 真机应用由 GitHub Actions 的 macOS Runner 构建，无需本地 Mac 或 Xcode。

这是独立网络诊断应用，与 Apple 无关联。它不登录 Apple 账户、不查询库存、不访问订单接口、不自动购物，也不能预测抢购成功率。购买 iPhone 的官方应用叫 **Apple Store**；**App Store** 用于下载应用，App Store Server API 面向应用内购买，不能用来购买硬件。

## 已实现的功能

- Swift `NWConnection` / `NWParameters.tcp` 实际建连，每个采样新建连接，终止后清理连接及超时任务。
- 单次或 5 / 10 / 20 / 50 / 100 次串行测试，间隔 1 / 2 / 3 / 5 秒，超时 2 / 3 / 5 / 10 秒。
- `NWPathMonitor` 监听网络，采样保存实际连接路径；网络切换、应用退后台时取消测试，前台不自动续跑。
- 实时折线图、原始样本详情，平均 / 最低 / 最高 / P50 / P95 / P99 / 总体标准差 / 失败率。
- 每组自动依次测 TCP 与 HTTPS HEAD，无模式选择；`URLSessionTaskMetrics` 提供可用的 DNS / TCP / TLS / TTFB / 事务总耗时、协议、缓存、复用、重定向和状态码。两项独立统计，一项失败不覆盖另一项结果。
- 开始按钮位于网络状态下方。测试结束后自动弹出居中的命名窗口，**手动选择命名保存或不保存**，确认后才加入历史；每次采样仍会保存临时检查点，防止中断丢失数据。
- 历史卡片直接显示延迟指标；按平均、最低、最高、P95、波动、失败率、日期正序 / 倒序排列。缺失指标排在最后，自动标出当前筛选中平均耗时最低的记录。
- 开始时选择只测当前网络，或依次测量 Wi-Fi / 蜂窝两条线路；第一轮结束后提示用户手动切换，点击继续时校验原生路径，同一组参数的两轮合并命名保存，无独立“对比分析”页。测试页及历史直接展示两条线路的数据；少于每条线路 20 个成功样本时不下优劣结论。
- 自定义域名 / IPv4 / IPv6 / 端口管理，历史日期 / 域名 / 网络筛选、删除、清空、CSV / JSON 导出与 JSON 恢复。
- 浅色 / 深色 / 跟随系统，iPhone 安全区域适配、蓝色主题、悬浮玻璃导航、隐藏滚动条但保留滑动。
- GitHub Actions 生成 iOS SPM 工程、注册原生插件、测试、编译真机 .app、打包未签名 IPA，并支持证书签名导出。

## 目标与公开资料

默认目标：

| 名称 | 主机 | TCP 端口 | 用途 |
| --- | --- | --- | --- |
| Apple 中国官网 | www.apple.com.cn | 443 | 公开网站入口 |
| Apple 国际官网 | www.apple.com | 443 | 公开网站入口 |
| Apple 商店入口 | store.apple.com | 443 | 公开入口，可能重定向 |
| Apple 连通性参考 | captive.apple.com | 443 | 基础连通性参考，可选 HTTPS HEAD |
| Apple 连通性参考 | captive.apple.com | 80 | 基础 TCP 参考；此端口通常无 TLS，HTTPS 测量保留实际错误 |

`captive.apple.com` 的主机、端口及连通性用途来自 [Apple 官方网络文档](https://support.apple.com/zh-cn/101555)。没有找到供第三方公开调用的 iPhone 库存、订单或抢购测速 API。上述公开网站和连通性主机**不代表** Apple Store App 的实际订单服务器。无需尝试凭据、抓包或未公开接口。

## 如何理解测量

### TCP

从调用 `NWConnection.start` 前的单调时钟，到连接进入 `.ready`。耗时可能包含 DNS、IP 选择、握手与系统调度，**不是 ICMP Ping RTT**。系统 DNS 缓存和 Happy Eyeballs 可能影响后续采样，TCP 模式无法独立拆分 DNS 时间。

成功样本才参与耗时统计，失败和超时计入连接失败率，取消不计入其分母。失败标记显示在图表基线，**不表示 0 ms 延迟**。P50 / P95 / P99 使用最近秩方法；标准差为总体标准差。

### HTTPS

每次使用独立的 ephemeral URLSession 发出只读 `HEAD https://主机:端口/`，不发送登录凭据或 Cookie，也不下载整页内容。保持系统证书验证，不绕过 TLS 错误。最多跟随 5 次 HTTPS 重定向，拒绝 HTTP 降级或带账号的重定向地址。

每次采样先进行全新的 TCP 连接，再发起 HTTPS HEAD；完成两项后再等待配置的间隔。超时分别应用于每一项，两项都使用选定端口。任何取消、退后台或网络切换均阻止下一项或下一组启动，不通过并发制造测试压力。旧版 TCP / HTTPS 单项历史仍可读取；新记录模式为 `combined`，TCP 原始值保留在采样主字段，HTTPS 原始值存于 `https`，汇总分别为 `summary` / `httpsSummary`。

- 顶部数值为整个请求的单调时钟总耗时，包含重定向；详情保留每个事务。
- TTFB 定义为 `requestStartDate → responseStartDate`。
- HTTPS 的 `connectEndDate` 可包含 TLS，TCP 分项优先截止到 `secureConnectionStartDate`；TLS 单独显示。
- HTTP/3 使用 QUIC，TCP 分项显示“不可用”；连接复用、缓存、代理、DNS 缓存等都可能使分项缺失。
- HTTP 403 / 405 / 500 等仍可能表示 HTTP 事务成功完成，不表示页面业务正常，状态码会单独保留。服务不支持 HEAD 时应查看状态码，不自动改用高频 GET。
- 非蜂窝 HTTPS 路径不强行认定为 Wi-Fi：显示事务信息并保存路径监视器的辅助观察。

### Wi-Fi 与 5G

关闭 Wi-Fi 后，系统路径可识别“蜂窝网络”，不能通过 `NWPathMonitor` 确认 5G 无线制式。“5G”仅是用户查看状态栏后的手动标记，标签不会覆盖原生证据。VPN、代理和 CDN 节点变化也会影响结果。单轮测量中出现网络变化、取消或中断时，不据此下线路优劣结论。双线路流程在两轮之间等待用户手动切换，保留各轮原始值与统计，切换时临时退后台不会丢失第一轮。

历史“平均耗时最低”只是在当前筛选记录中的数学排序；不同域名、模式或时间的结果不能据此断言哪条线路更好。

## Windows 开发与网页预览

安装 Node.js **22.23.2** 和 Git，无需 Xcode：

```text
npm ci
npm run dev -- --port 5173
```

打开 `http://localhost:5173/`。手机与电脑同一局域网时可使用 Vite 输出的局域网地址。浏览器只用于预览、管理目标、查看或导入历史；原生 TCP、HTTPS、路径识别按钮禁用，**没有模拟结果，也不会用 fetch 代替 TCP**。

```text
npm run typecheck
npm test
npm run build
```

前端依赖使用精确版本及 `package-lock.json` 锁定。技术栈：React 19.3、TypeScript 7.0、Vite 8.3、Tailwind 4.3、Capacitor 8.5.3、Recharts 3.10。iOS 最低版本 **15.0**；构建固定 macOS 15 runner / Xcode 26.2。平台源码 `ios/` 不提交，由脚本在 CI 重复生成。

## GitHub Actions 构建

工作流：[`.github/workflows/build-ios.yml`](.github/workflows/build-ios.yml)。推送 `main` 自动生成未签名产物，也可在 **Actions → Build iOS → Run workflow** 手动触发。

流程：`npm ci` → 前端测试 / 类型检查 / 构建 → `swift test` 原生核心测试 → Capacitor `add / sync ios` → SPM 插件引用与注册校验 → `xcodebuild` 真机 arm64 Release → .app 与 IPA → 上传 Artifacts。

Swift 插件是本地 Capacitor npm 包，`Package.swift` 引用独立 `native-core`。Capacitor 自动写入 `CapApp-SPM` 和 `packageClassList`。脚本在生成后和最终 App 中检查注册，并检查编译二进制内的插件类；缺失则失败，不能删掉插件让 CI 表面成功。App 图标、Info.plist、隐私声明及 Xcode 资源引用都由脚本配置，完全无需 Mac 图形界面。

成功后，Actions 运行页的 Artifacts 中包含：

- `AppleNetworkProbe-unsigned.ipa`：可用于后续个人签名，**未签名，不能直接安装**。
- `AppleNetworkProbe.app.zip`：压缩的真机 .app，便于审查或重新签名，保留包结构。
- `BUILD-INFO.txt`：版本、提交及签名状态。
- 可选 `AppleNetworkProbe-signed.ipa`：配置正确的证书并手动选择签名构建后产生。

日志单独上传 `iOS-build-logs-*`。下载的 artifact ZIP 需要先解压，再使用里面的 `.ipa`；不要把外层 ZIP 当作 IPA。

## 方案 A：免费账户，Windows 个人签名与侧载

1. 从 GitHub Actions 下载并解压，找到 `AppleNetworkProbe-unsigned.ipa`。
2. 按 [AltStore Classic 官方 Windows 安装指南](https://faq.altstore.io/altstore-classic/how-to-install-altstore-windows) 安装 AltServer。使用官方要求的 iTunes / iCloud 版本，启用手机信任及相应同步设置。
3. USB 连接 iPhone，通过 AltServer 安装 AltStore Classic；只在你信任的本地签名工具中输入自己的 Apple 账户，不把账户密码交给仓库或 CI。
4. 把 IPA 传到 iPhone 的“文件”，或选择其他官方支持的导入方式，在 AltStore Classic 中选择该 IPA 完成个人签名和侧载。无需越狱。
5. 按系统提示信任开发者；iOS 16 及以上进行开发签名应用安装时通常需要开启 **设置 → 隐私与安全性 → 开发者模式**，重启并确认。具体以 iOS 和工具当前提示为准。

免费 Apple 账户的个人签名通常有效 **7 天**，需要通过 AltStore / AltServer 定期刷新，受活动 App 数和 App ID 数量等限制；到期可能无法打开，需重新签名。切勿在备份前删除 App，否则本地记录可能丢失。使用官方工具文档核对 Windows、iOS 与 Apple 账户的支持情况，GitHub 编译成功不保证每一种侧载工具都能直接处理产物。

## 方案 B：Apple Developer Program 签名

在仓库 **Settings → Secrets and variables → Actions → New repository secret** 配置：

| Secret | 内容 |
| --- | --- |
| `IOS_CERTIFICATE_BASE64` | 包含私钥的合法 Apple 签名 `.p12` 的 Base64 |
| `IOS_CERTIFICATE_PASSWORD` | `.p12` 密码，可为空字符串 |
| `IOS_PROFILE_BASE64` | 与证书及 Bundle ID 匹配的 `.mobileprovision` 的 Base64 |

Bundle ID：`cn.goodbye.applenetworkprobe`。可在 Apple 开发者网站建立 App ID、注册设备并生成 Profile。证书必须包含对应私钥；可用 OpenSSL 在 Windows 创建密钥及 CSR、从 Apple 门户取得证书，再导出 P12；已有含私钥 P12 也可直接使用。不要提交证书、私钥、描述文件或 Apple ID 密码。

在 Windows 中用 Python 输出 Base64，然后复制到 Secret（不要将输出写入仓库）：

```text
python -c "import base64; from pathlib import Path; print(base64.b64encode(Path(r'C:\安全目录\certificate.p12').read_bytes()).decode('ascii'))"
```

Profile 同样处理。手动运行工作流，勾选 `signed`，选择：

- `release-testing`：Ad Hoc 分发，必须使用对应 Distribution 证书及 Ad Hoc Profile，包含目标 iPhone 的 UDID。产物可通过合适的设备安装工具安装到已注册设备。
- `debugging`：Development 证书及 Development Profile，设备已注册，按 iOS 要求开启开发者模式。
- `app-store-connect`：App Store 分发 Profile，供上传 App Store Connect / TestFlight，**不是直接侧载包**；此工作流不自动上传商店。

脚本创建临时钥匙串，检查有效期、Bundle ID 及证书匹配，执行 archive / export 并验证签名；结束后清理证书、Profile 和临时钥匙串。无需 Apple ID 密码、自动下载 Profile 或 Mac GUI。

**编译成功、签名成功、实体 iPhone 安装成功是三个不同结果。** 没有证书时只能确认未签名构建；没有在你的手机安装并测试之前，不能声称安装或网络功能已验证。

## 数据与备份

iOS 使用 Capacitor Preferences / UserDefaults 持久化，浏览器使用其 Web 存储。每个采样保留时间、状态、错误、实际路径、原始指标；历史保存参数和统计值。测试期间写入单独检查点，测试结束等待用户命名确认。重启后未保存的记录出现在待保存区，**不会自动进入历史**。

JSON 格式版本为 1，导入校验结构、端口、时间、状态和数值，重新计算统计及实际网络，重复 ID 跳过，最多 2000 条记录、单次导入 10 MB。CSV 包含逐次采样及最后一个 HTTPS 事务的分项；完整重定向链请使用 JSON。CSV 防止公式注入。删除和清空无法撤销，删除 App 会丢失记录，请定期导出 JSON。

## 验证边界

2026-10-11 的 [GitHub Actions 真机构建](https://github.com/SunnyDay00/Apple-Network/actions/runs/38136230546)已成功：23 项前端测试、原生核心测试、Swift 插件编译及最终注册检查通过，已生成未签名 IPA 与 .app 包。此结果不包含证书签名、实体 iPhone 安装或 Apple 目标的真机网络验收。

前端包含统计、比较、排序、导入校验、CSV 和调度取消的自动化单元测试。原生核心包含真实本机 TCP 连接及确定性的状态注入测试；注入只存在于 XCTest，不用于 App。

实体 iPhone 验收步骤见 [`docs/device-tests.md`](docs/device-tests.md)。在实体 iPhone 上仍需验证：安装与签名、插件 Bridge 实际调用、Apple 目标连接、DNS 失败与拒绝连接、超时、取消、Wi-Fi / 蜂窝切换、退后台、HTTPS 各项指标、导出分享与重启数据恢复。CI 本机回环测试和编译通过**不能替代**这些真机测试。
