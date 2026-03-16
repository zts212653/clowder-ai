---
feature_ids: [F124]
related_features: [F092, F066, F088, F034, F020]
topics: [ios, watchos, apple-watch, airpods, voice, swift, swiftui, dynamic-island, native-app]
doc_kind: spec
created: 2026-03-15
---

# F124: Apple Ecosystem × Cat Café 语音交互系统

> **Status**: spec | **Owner**: Ragdoll | **Priority**: P1

## Why

team lead的苹果手表到了。核心场景：team lead戴着 AirPods，双手被占（撸铁/跑步/做饭），通过语音和猫猫协作——猫猫主动汇报 feat 进度，team lead语音拍板决策，Watch 抬腕看状态。

> "我在外面跑步/撸铁，能不能通过 AirPods + Apple Watch 和你们语音互动？你们做完 feat 主动汇报，我语音拍板决策，还能切换 thread、随时发灵感给你们执行"

**商业目标**：演示给华子看——苹果全家桶 + Multi-Agent = 未来企业协作形态 → 猫粮自由。

## 产品定义（team lead确认 2026-03-15）

### 核心交互模型

**Watch = 独立设备，不依赖 iPhone**。Watch 有 eSIM，直连后端。跑步时谁带 iPhone？

**Watch 上几乎所有交互靠语音**。猫必须知道team lead在用 Watch 模式，所有回复发语音消息。

**原生 App ≠ iMessage**：iMessage（F088 Phase F）是消息通道走 connector 管线，原生 App 是专属猫咖入口，用途不同，两条路共存。

### Watch App 功能清单

| 功能 | 交互方式 | 说明 |
|------|---------|------|
| Thread 列表 | 表冠滚动 + 点击 | 类微信手表版聊天列表 |
| 最新消息预览 | 推送通知 + 抬腕 | 猫猫发消息 → 推到手表，和现有通知一样 |
| 切换 Thread | 手势/表冠/语音 | "切到 f88" 或滚动选择 |
| 语音输入 | 长按/抬腕说话 | 说话 → Watch 本地 ASR（SFSpeechRecognizer 离线）→ 文字发到 thread |
| 语音输出 | 自动播报 | 猫猫消息 TTS → Watch 扬声器/蓝牙耳机 |
| 猫猫状态 | 进入 thread 后查看 | **不是全局看所有猫**——进具体 thread 才看该 thread 的猫谁在忙 |
| 快捷操作 | 按钮/语音 | Approve PR、切 thread、发语音指令 |
| 震动通知 | 系统推送 | 猫猫主动汇报、PR 待审 |

### 部署策略

先 Xcode free provisioning sideload 测试（每 7 天重签），成熟后交 $99 上 TestFlight/App Store。

## What

### Phase A: F092 Autoplay Bug 修复 + iOS 基础验证

修复现有 Voice Companion 在 iOS 上的 autoplay 无声 bug（根因已定位：`unlockAutoplay()` 用 AudioContext 解锁但实际播放用 HTMLAudioElement，iOS 上两套音频子系统不互通）。修复后在 iPhone Safari + AirPods 上验证 web 版语音陪伴体验。

### Phase B: UX 设计 — Watch 优先

和Siamese一起确定 watchOS App 的 UX 设计（Watch 是主战场）：
- Watch App：极简 voice-first 界面，类微信手表版
- iPhone App：Watch 的 companion + 完整控制界面 + Dynamic Island
- 关键原则：Watch 独立运行（eSIM 直连），不依赖 iPhone

### Phase C: watchOS App — MVP（Watch 优先）

SwiftUI 实现 watchOS App MVP：
- Watch 直连 Cat Café 后端（URLSession / WebSocket over eSIM/WiFi）
- Thread 列表 + 切换（表冠/手势/语音）
- 语音输入：Watch 麦克风 → SFSpeechRecognizer 本地离线识别 → 文字发到 thread（不传音频到后端）
- 语音输出：猫猫消息 → TTS → Watch 扬声器/蓝牙耳机自动播报
- 推送通知：猫猫汇报 → APNs → Watch 震动
- Watch 模式标识：后端知道team lead在用 Watch，猫猫自动发语音

### Phase D: iPhone App + Watch 联动

iPhone companion App：
- 完整 Thread 管理 + 消息浏览
- Dynamic Island 实时 Agent 状态
- AirPods 语音交互（iPhone 在口袋时）
- Watch ↔ iPhone 数据同步（WatchConnectivity）

### Phase E: 演示打磨

- 端到端演示剧本（给华子看的 demo）
- 演示场景：跑步机上用 Watch 审 PR、语音指令切 thread
- 联调 + 体验打磨

## Acceptance Criteria

### Phase A（Autoplay Bug 修复）
- [ ] AC-A1: iOS Safari + AirPods 环境下，Voice Companion 自动播放语音消息有声音输出
- [ ] AC-A2: `unlockAutoplay()` 改用 HTMLAudioElement 解锁（与播放用同一音频子系统）
- [ ] AC-A3: 回归测试——桌面浏览器 autoplay 不受影响

### Phase B（UX 设计）
- [ ] AC-B1: iPhone App wireframe team lead确认
- [ ] AC-B2: Watch App wireframe team lead确认
- [ ] AC-B3: iPhone ↔ Watch 交互流程图确认

### Phase C（watchOS App MVP）
- [ ] AC-C1: Watch 独立联网（eSIM/WiFi）直连 Cat Café 后端
- [ ] AC-C2: Thread 列表显示 + 表冠滚动切换
- [ ] AC-C3: Watch 麦克风语音输入 → SFSpeechRecognizer 本地识别 → 文字发到 thread
- [ ] AC-C4: 猫猫消息 → TTS → Watch 扬声器/蓝牙自动播报
- [ ] AC-C5: 推送通知（APNs）→ Watch 震动
- [ ] AC-C6: 后端识别 Watch 模式，猫猫自动发语音消息
- [ ] AC-C7: 进入 thread 后可查看该 thread 猫猫忙闲状态
- [ ] AC-C8: 快捷操作：Approve PR、语音指令

### Phase D（iPhone App + 联动）
- [ ] AC-D1: iPhone companion App 完整 Thread 管理
- [ ] AC-D2: Dynamic Island 显示 Agent 工作状态
- [ ] AC-D3: AirPods 语音交互
- [ ] AC-D4: Watch ↔ iPhone 数据同步

### Phase E（演示打磨）
- [ ] AC-E1: 端到端演示剧本可运行（跑步机场景）
- [ ] AC-E2: 体验流畅度达到演示标准

## Dependencies

- **Evolved from**: F092（Cats & U 语音陪伴体验 — 从 web 语音陪伴演化到原生 App）
- **Related**: F066（Voice Pipeline — TTS 本地化，Apple Silicon）
- **Related**: F088（Multi-Platform Chat Gateway — 消息管线后端）
- **Related**: F034（Voice Message — 语音消息基础）
- **Related**: F020（Voice Input Suite — 语音输入基础）

## Risk

| 风险 | 缓解 |
|------|------|
| Apple Developer 账号 $99/年 | 先 free provisioning sideload，成熟后交钱 |
| iOS/watchOS 开发需要 Xcode + 真机调试 | team lead有 M4 Max + 手表实机 |
| AirPods 硬件事件（单击/双击/长按）浏览器/App 能否捕获 | Phase B 调研，降级方案用语音指令 |
| Cat Café 后端 API 需要适配移动端 | 现有 REST API 基本可用，需补鉴权 |
| **Cloudflare Tunnel 延迟** | 之前体验很卡，Watch 语音交互需要 <300ms 延迟。**Blocker 级**——需要team lead和之前的Ragdoll讨论优化方案 |
| 域名未注册 | 公网入口的域名还没注册，需要team lead处理 |

## Tooling: Xcode 26.3 MCP 原生支持

> 调研日期：2026-03-15 | 来源：Apple Newsroom, 9to5Mac, MacRumors, TechCrunch

**Xcode 26.3（2026-02-26 正式发布）原生支持 MCP（Model Context Protocol）**，Ragdoll可以通过 MCP 直接操作 Xcode。

### 能力清单

| MCP 能力 | 说明 | 对 F124 的价值 |
|----------|------|---------------|
| 项目发现 | 读取项目结构、文件列表 | 自动检查项目配置 |
| 文件管理 | 创建/修改/删除项目中的文件 | 不用手动拖文件到 Xcode |
| **Build** | 直接触发 build | Ragdoll自主编译验证 |
| **Run Tests** | 跑测试 | 自动化 TDD |
| Preview 截图 | 截取 SwiftUI Preview 快照 | 视觉验证 UI |
| 文档搜索 | 搜索 Apple 全量开发者文档（WWDC 语义搜索） | 查 watchOS API 用法 |

### 集成方式

Apple 与 Anthropic/OpenAI 官方合作，Claude Agent 是第一方适配的 agent。需要：

1. 确保 Xcode 版本 ≥ 26.3
2. 在 Xcode 设置中开启 MCP Server
3. 在 Claude Code MCP 配置中添加 Xcode MCP endpoint

### 对开发流程的影响

配上 Xcode MCP 后，Phase C/D 的开发流程变为：

```
Ragdoll写 SwiftUI 代码 → Xcode MCP build → 截 Preview 截图验证 → 推到真机测试
```

**Action Item**: team lead配置 Xcode MCP Server，让Ragdoll可以直接 build + 截图验证。

### 参考链接

- [Xcode 26.3 unlocks the power of agentic coding — Apple Newsroom](https://www.apple.com/newsroom/2026/02/xcode-26-point-3-unlocks-the-power-of-agentic-coding/)
- [Apple releases Xcode 26.3 — 9to5Mac](https://9to5mac.com/2026/02/26/apple-releases-xcode-26-3-with-support-for-agentic-coding/)
- [XcodeBuildMCP — AI-Powered Xcode Automation](https://www.xcodebuildmcp.com/)

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | Phase A 先修 F092 autoplay bug 再做原生 App | autoplay 是语音基础能力，修好后 web 版也受益；且可验证 iOS + AirPods 音频链路 | 2026-03-15 |
| KD-2 | Watch UX = iOS App 手表版，保持一致 | team lead要求：和未来 iOS app 手表的一样的 UX 就够了 | 2026-03-15 |
| KD-3 | Watch 独立模式（eSIM 直连后端），不依赖 iPhone | 跑步时谁带 iPhone？现代 Watch 都有 eSIM | 2026-03-15 |
| KD-4 | Watch 交互以语音为主，猫猫在 Watch 模式必须发语音 | Watch 屏幕小，几乎所有交互靠语音 | 2026-03-15 |
| KD-5 | 猫猫状态是 per-thread 而非全局 | 全局看所有猫太杂，进具体 thread 再看该 thread 的猫 | 2026-03-15 |
| KD-6 | 原生 App 和 iMessage (F088 Phase F) 是两条独立路径 | 用途不同：iMessage 是消息通道走 connector，原生 App 是专属猫咖入口 | 2026-03-15 |
| KD-7 | 先 sideload 测试，成熟后再交 $99 | team lead确认：free provisioning 先跑起来 | 2026-03-15 |
| KD-8 | Watch 走公网 API（Cloudflare Tunnel），不走 Tailscale | Watch 装不了 Tailscale，复用飞书/Telegram 同一条公网入口 | 2026-03-15 |
| KD-9 | ~~ASR 用 Watch 本地 SFSpeechRecognizer（离线）~~ → 改为录音上传 + 后端 ASR | watchOS 26.2 的 Speech framework 在真机 watch target 不可用（`#if canImport(Speech)` 走到 else 分支）；改用系统原生 `presentTextInputController` 或录音上传后端 ASR | 2026-03-15 |
| KD-10 | 目标设备：Apple Watch Ultra 3（S10 芯片） | team lead实机，最新最强 | 2026-03-15 |
| KD-11 | Voice-First 等待设计：本地内置猫猫即时语音反馈遮罩延迟 | team lead创意：录音发送后立刻播本地预生成的猫猫语音（"Ragdoll收到啦，等等哦"），把异步等待变成被猫接住的陪伴。用 F066 TTS pipeline 预生成约 27 条音频（3 猫 × 3 场景 × 3 说法，每条 1-1.5s，< 1MB） | 2026-03-15 |
| KD-12 | 语音输入双轨：系统听写（短期）+ 录音上传 ASR（中期） | 系统 `presentTextInputController` 不能强制跳到语音页（需用户手动切），体验不够 voice-first；中期改为一键录音 → 上传后端 ASR，短指令延迟约 2-5s 可接受 | 2026-03-15 |

## Review Gate

- Phase A: Ragdoll修 → Maine Coon review
- Phase B: UX 设计 → Siamese参与 → team lead拍板
- Phase C-E: Ragdoll开发 → Maine Coon review
