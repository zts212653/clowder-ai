---
feature_ids: [F279]
related_features: [F063, F066, F091, F111, F112]
topics: [workspace, markdown, listen-mode, tts, audio, cache, accessibility]
doc_kind: spec
created: 2026-07-28
description: "让用户在 Workspace Markdown 中从任意句开始听读，并以可见、可复用、可清理的本地音频缓存持续续听。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-07-28T16:04:04Z
---

# F279: Workspace Listen Mode — 正文听读与可复用音频缓存

> **Status**: in-progress / Phase A UX Design Gate passed; Phase B pending
> **Owner**: 小太阳·Maine Coon (@codex-sol, GPT-5.6 Sol)
> **Priority**: P1
> **Created**: 2026-07-28
> **operator source**:
> `0001785253452969-000151-f93c9786` — “我们这能力得做在我们的workspace里能点才行”；
> `0001785254502978-000008-67e5f9fd` — 确认可以采用 7 天清理，并询问是否应按完整 Feature 设计；
> `0001785313307088-000072-a543a12d` — “我觉得对于design gate 我感觉ok了”。
> **Owner verdict**: 是；这是一条跨 Workspace、播放与缓存生命周期的独立用户旅程，正式立项为 F279。

Architecture cell: `hub-action-surface`

Map delta: `none`

Why: Workspace 是用户入口；F066/F111 继续拥有 TTS 合成能力，F112 继续拥有共享播放队列。F279 只拥有“文档 → 可听句段 → 播放/续听/缓存状态”的编排与用户状态，不新建第二套播放器或平台级存储。

## Why

长篇正文在视觉阅读时容易让operator失去专注，听读反而更容易持续吸收。macOS 自带朗读虽然能临时工作，但声音、交互和 Workspace 上下文都不合格：不能在正文里自然点一句开播，也没有我们自己的续听、句子高亮和缓存管理。

家里已经分别拥有 Markdown 渲染、TTS 合成、流式分句和播放队列，却还没有把这些能力接成一个用户能直接使用的“听正文”旅程。F279 的目标不是再造 TTS，而是让operator在 Workspace 打开一篇 Markdown 后，**从任意句开始、按自己舒服的速度听下去；听过的内容可以立即重播，缓存何时清理一眼可见。**

## Current State（2026-07-28）

- F063 已支持 Workspace Markdown 渲染、文本选择和媒体预览，但没有“听读”入口。
- F066 提供本地 TTS；F111 提供流式分句；F112 提供 pause/resume/skip/interrupt 的共享 PlaybackManager。
- `/api/tts` 已按文本、voice、model、speed 等指纹缓存 `.wav`；相同输入实测 cache hit 约 `3.7ms`。
- 当前本机实测：
  - 53 字：合成 `5.38s`，音频 `10.96s`；
  - 138 字：合成 `9.17s`，音频 `20.56s`。
  - 结论：1×/1.5× 有充足边播边合成余量；2× 需要更积极预取，不能假装永不缓冲。
- 现有 cleaner 每 6 小时清理超过 7 天的文件，并在缓存超过 500MB 时按 LRU 压回 400MB。
- 当前默认目录是 runtime cwd 下的 `./data/tts-cache`：缓存能命中，但位置随运行 checkout 漂移；没有文档 manifest、续听位置、缓存状态或用户可见清理入口。

## Product Boundary

### v1 包含

- Workspace 内已渲染的本地 Markdown。
- 从全文开头或任意正文句子开始听。
- 播放/暂停、上一句/下一句、`0.75× / 1× / 1.25× / 1.5× / 2×`。
- 当前句高亮、自动跟随与手动滚动后的温和恢复。
- 分句预取、内容寻址复用、重开文档续听。
- 缓存状态、清理当前文档、7 天/30 天/永久保留选项。
- AppShell 级常驻 mini player：切文件、切 thread 后听读继续（KD-10）。
- 听读进行中抑制猫猫实时语音自动朗读，并保留手动播入口（KD-9）。

### v1 不包含

- PDF、网页、任意二进制文档或全局“有声书库”。
- 语音市场、逐文档换音色、音频导出/分享。
- 新外部依赖或第二套音频播放队列。
- 为所有 Markdown 语法生成戏剧化朗读；代码块、表格源码和裸 URL 默认跳过。

## User Journey

1. operator在 Workspace 打开一篇渲染后的 Markdown。
2. 点击顶部“听读”从正文开头播放；或选中/点击一句，选择“从这里听”。
3. 首句开始合成并播放，当前句在正文中高亮；后续句段在后台预取。
4. operator可暂停、跳句、调整倍速；切到别的语音/播客时沿用 F112 的互斥与打断语义。
5. 关闭后再次打开同一文档，界面恢复上次位置；已经缓存且指纹未变的句段立即可播。
6. 缓存面板显示“已缓存 x/y · n MB · 最近使用/预计清理时间”，可清除此文档或调整保留期限。

### Supporting Journeys

**S1 — 正文修改后重听**：未变化句子的音频继续复用；变化句子重新合成；续听位置能落在仍存在的稳定句段附近，不因行号变化跳错句。

**S2 — 2× 跟不上**：播放器明确显示“正在缓冲”，先积累足够句段再继续，不静默卡住、不重复播放。

**S3 — 清理与永久保留**：默认 7 天未使用后清理；可切 30 天或主动选择“永久保留”。清理音频不删除文档身份、播放位置和用户设置。

## Domain Contract

### 1. Markdown → 可听句段

- 输入是 Workspace 已解析的 Markdown 语义树，不从 DOM 文本或原始行号猜句子。
- 默认读取标题、正文段落、列表项和引用。
- YAML frontmatter、代码块、表格标记和裸 URL 默认跳过；用户显式选择时可作为一次性文本朗读。
- 每个句段持有文档内 occurrence/anchor；相同文本在同一文档出现多次时仍能分别定位和高亮。

### 2. 文档与音频身份

- 文档身份由 `project + relativePath` 确定，内容 digest 用于判断版本。
- 音频 chunk 由 `normalized text + provider/model/voice/language/speed/format + reference voice fingerprint` 内容寻址。
- 文档修改不整体作废缓存：未变化的句段继续复用，变化句段只重合成自己。
- API 返回受控 asset URL 和状态，不向前端暴露可拼接的任意文件系统路径。

### 3. 持久化与寿命

- 音频资产根目录使用 `${CAT_CAFE_DATA_DIR}/assets/tts`；保留 `TTS_CACHE_DIR` 显式 override 的兼容入口。
- 默认音频 retention 为 **7 天未使用**，而非“创建后 7 天”；可选 30 天或永久（TTL=0）。
- 文档 manifest、播放位置、倍速与 retention 选择属于用户可见状态，始终 TTL=0；音频过期不会抹掉它们。
- “清除此文档缓存”只解除文档引用并回收无引用资产；内容寻址资产仍被其他文档引用时不得误删。

### 4. 播放协调

- 必须复用 F112 PlaybackManager；Listen Mode、猫猫语音和播客不能并行争抢同一输出。
- pause/resume/skip/interrupt 的原有语义保持一致；F279 只增加 sentence seek 和 playback rate。
- 切换文档或关闭 Workspace 时，不自动丢弃持久续听位置。

## Phases

### Phase A — Workspace UX Design Gate

在真实 Workspace shell 中完成并评审：

- 全文“听读”入口与句子级“从这里听”动作；
- 桌面/窄屏播放器的停靠、最小化和返回正文；
- 当前句高亮、自动跟随、用户手动滚动后的交互；
- loading/buffering/error/空正文/缓存命中状态；
- 缓存详情、retention 选择与清理确认。

**Gate result（2026-07-29）**：**PASSED**。operator 已对 dev-only Workspace
交互原型完成 Design Gate signoff；签字范围是交互形态与视觉方向，不代表真实
TTS、缓存或生产 Workspace 集成已经实现。

**Evidence**：

- Prototype exact HEAD:
  `007ebe3de33eaea853cda27da77dc314e75eff42`
  (`feat/f279-listen-mode-design-gate`)。
- 非作者 reviewer `@opus5` 在
  `0001785312458649-000070-0ea5ef9e` 对该 exact HEAD 给出 terminal
  `APPROVE`；浏览器实测覆盖真实长段落、跨行句高亮、窄屏、跨 thread
  续播、被抑制语音的手动点播、缓存浮层与可访问性。
- operator 在 `0001785313307088-000072-a543a12d` 签字：
  “我觉得对于design gate 我感觉ok了”。

### Phase B — Document Audio Domain

- Markdown 语义分段与稳定 anchor；
- manifest、内容寻址、引用计数/回收、续听状态；
- 稳定资产根目录与既有 cache migration/compat；
- retention/last-used cleaner 与受控 asset API；
- 运行指标埋点。

### Phase C — Workspace Player Integration + UAT

- Workspace 动作、正文高亮、PlaybackManager rate/seek 集成；
- 逐句预取、缓存命中与显式 buffering；
- 以 `docs/study/2026-06-19-how-to-be-good-at-research.md` 完成冷启动、续听、编辑后复用、清理和 2× UAT。

## Acceptance Criteria

### Phase A — UX

- [x] **AC-A1**: 渲染 Markdown 顶部存在可发现但不喧宾夺主的“听读”入口。
- [x] **AC-A2**: 用户能对正文中的任意句触发“从这里听”，当前句清晰高亮。
- [x] **AC-A3**: 桌面与窄屏均能完成播放/暂停、跳句、倍速、返回正文。
- [x] **AC-A4**: 首句合成、预取不足、错误、空正文和缓存命中都有不撒谎的界面状态。
- [x] **AC-A5**: 缓存大小、保留期限和“清除此文档”可见且能理解后果。
- [x] **AC-A6**: operator 在实际 Workspace 原型上完成 Design Gate signoff。
- [x] **AC-A7**: 原型使用**真实 fixture 正文**（长段落 + 表格 + 引用块 + 加粗），不使用「一句一块」的简化假正文；段落内第 N 句可起播且高亮不破坏阅读排版。
- [x] **AC-A8**: 切文件 / 切 thread 后，mini player 仍可见并显示当前文档与句位置；切回该文档时正文高亮重新接上（KD-10）。
- [x] **AC-A9**: 听读进行中收到猫猫语音时，界面呈现被抑制的语音并提供可点播入口，用户不会误以为猫没回应（KD-9 / OQ-4）。

### Phase B — Domain

- [ ] **AC-B1**: 标题/段落/列表/引用被稳定分段；frontmatter/代码块/表格标记/裸 URL 默认跳过。
- [ ] **AC-B2**: 文档修改后，只对变化句段 cache miss；未变化句段继续命中。
- [ ] **AC-B3**: 重复句子不会导致高亮、跳转或续听位置串位。
- [ ] **AC-B4**: 音频写入稳定 data root；runtime checkout 切换后仍能命中。
- [ ] **AC-B5**: 默认按 last-used 7 天清理；30 天和永久保留按用户选择生效。
- [ ] **AC-B6**: 清理当前文档不会删除仍被其他 manifest 引用的共享资产。
- [ ] **AC-B7**: 清理音频后，播放位置、倍速和 retention 选择仍可恢复。
- [ ] **AC-B8**: asset API 无目录穿越，用户不能用相对路径读取缓存根之外文件。

### Phase C — Playback and Performance

- [ ] **AC-C1**: 用户可从全文开头或任意句开始，播放/暂停、上一句/下一句和五档倍速均工作。
- [ ] **AC-C2**: Listen Mode 复用 F112 PlaybackManager；与猫猫语音/播客切换时只有一个音源活动。
- [ ] **AC-C3**: cache hit 到首个可听音频的用户可见延迟 ≤1s。
- [ ] **AC-C4**: 参考 M 系列 Mac 的冷启动首句延迟目标为 p50 ≤6s、p95 ≤8s；若未达标，界面仍即时进入真实 loading 状态。
- [ ] **AC-C5**: 1×/1.5× 在代表性长文中连续播放无可感知句间断裂；2× 不足时显式 buffering、不乱序、不重复。
- [ ] **AC-C6**: 重新打开同一文档能恢复上次句段、句内位置（若可用）和倍速。
- [ ] **AC-C7**: 指定研究文档的冷/热缓存、续听、文档编辑、清理和 2× 旅程均通过真实 Workspace UAT。

## Mechanism Selection

- **确定契约**：Markdown 分段、cache identity、retention、引用回收、续听位置、路径安全和单播放器互斥由单元/集成/E2E 测试与守卫证明。
- **运行健康**：首句延迟、合成 real-time factor、cache hit/miss、buffer depth 和 underrun 进入 logs/metrics；以 benchmark script 和真实长文 UAT 验证，不挂 Eval Hub。

## Observability

每次 listen session 至少记录：

- `first_segment_ready_ms`、`first_audio_play_ms`；
- `tts_synthesis_rtf`；
- `cache_hit` / `cache_miss` 及 miss reason；
- `prefetch_buffer_segments`、`buffer_underrun_count`；
- document identity 只记录稳定 digest/受控 ID，不记录正文内容。

## Requirements Traceability

| ID | 用户需求 / 约束 | Feature contract | 验证 |
|---|---|---|---|
| R1 | “喜欢听，不喜欢看” | Workspace 原生 Listen Mode | AC-A1, AC-C7 |
| R2 | “选择从哪一句开始” | 句子 action + stable anchor | AC-A2, AC-B3, AC-C1 |
| R3 | “选择倍数，暂停” | 五档倍速 + F112 播放控制 | AC-A3, AC-C1/C2 |
| R4 | “在我们的 workspace 里能点” | F063 渲染面内的第一方动作 | AC-A1/A2/A6 |
| R5 | “合成过一遍缓存起来” | 内容寻址 chunk + manifest | AC-B2/B4, AC-C3 |
| R6 | “知道音频放在哪里” | 稳定 data root + UI 可见状态 | AC-A5, AC-B4 |
| R7 | “自己清理 / 几天清理” | 7d/30d/永久 + 单文档清理 | AC-A5, AC-B5/B6 |
| R8 | 2× 是否跟得上 | 预取、buffer 指标、显式缓冲 | AC-A4, AC-C4/C5 |
| R9 | 用户状态默认持久化 | manifest/position/settings TTL=0 | AC-B7, AC-C6 |

## Key Decisions

| ID | Decision | Why |
|---|---|---|
| KD-1 | 独立立项 F279，不 reopen F063/F111/F112 | 它跨越文档语义、播放、缓存与用户旅程，有自己的成败判据 |
| KD-2 | v1 只做 rendered Markdown | 先把高价值正文旅程做完整，避免被格式兼容面稀释 |
| KD-3 | 默认 retention 7 天未使用；可选 30 天/永久 | operator 明确接受 7 天，同时需要主动控制 |
| KD-4 | 文档状态永久、音频资产可过期 | 清空间不能让用户丢失续听与偏好 |
| KD-5 | 句段内容寻址，manifest 负责顺序/位置 | 文档小改时最大化复用，并能处理重复句 |
| KD-6 | 复用 PlaybackManager，但**先把其生命周期提升为 AppShell 级单例** | 现状实例创建/销毁绑在 `ChatContainer.tsx:719` 的 `useVoiceStream()` 上，cleanup 直接 `destroy()` + 置 null，依赖 `[session?.voiceMode]`；不提升则 KD-10 无法成立（见 Risks） |
| KD-7 | 默认使用当前全局 voice 配置 | v1 不引入逐文档 voice picker |
| KD-8 | 性能走运行可观测，不新建 eval | 要回答的是延迟/稳定性，不是不确定效用 |
| KD-9 | **听读进行中，猫猫实时语音默认不自动朗读**，只呈现文字，用户主动点才播 | operator 2026-07-29 决策（选项 C）。听读是 operator 的专注模式，长文期间被语音打断且不自动恢复 = 体验失效。落点在 `useVoiceStream.ts:39-45` 的 `matchesActiveSession`，不在 F279 的 Workspace UI 层 |
| KD-10 | **听读是全局播放会话**：切文件、切 thread 继续播放，由 AppShell 级常驻 mini player 承载 | operator 2026-07-29 决策（选项 B）。原始需求「听比看更容易专注」意味着按下听读后大概率离开当前屏幕；绑死在文件视图 = 功能对主用例无效。落点为 `app/layout.tsx:64` 的 `AppShell`（同层已有 BrakeModal / GuideOverlay / ToastContainer 常驻先例） |
| KD-11 | 当前句高亮走 inline sentence span，不切块 | 真实正文（AC-C7 指定 fixture）是每段 3–5 句的长段落 + 表格 + 引用块；块级高亮只在「一段=一句」时成立。家里已有 inline 先例：`content-overflow/readerSearch.tsx:32` 的 `<mark>` 经 `MarkdownContent` 的 `textProcessor` 注入，且天然跳过 code/pre |

## Dependencies

- **F063**: Workspace Markdown surface 与文档 action。
- **F066**: TTS provider、voice/model 配置。
- **F111**: 分句/流式合成能力。
- **F112**: 共享 PlaybackManager 与互斥播放语义。
- **F091**: 可参考其 podcast/audio asset 经验，但不复用 Signal 专属 Study 域。
- **F153**: 指标进入既有 observability substrate；F279 不要求先完成 F153 全部范围。

## Risks

| Risk | Consequence | Mitigation |
|---|---|---|
| 句段 anchor 随编辑漂移 | 从错句续听/高亮 | semantic anchor + occurrence + digest，编辑旅程测试 |
| 2× 消耗快于合成 | 频繁断音 | 前瞻预取、buffer watermark、显式 buffering |
| 共享 chunk 被误删 | 其他文档突然 cache miss | manifest 引用/可达性回收，非按文件夹粗删 |
| 稳定缓存无限增长 | 磁盘膨胀 | 默认 7d last-used + size cap + 可见清理 |
| 新播放器绕过 F112 | 多音源竞争、状态割裂 | 架构契约 + integration test |
| Markdown 提取读出噪声 | 听感不可用 | 语义树白名单、默认跳过非正文、选择覆盖 |
| **PlaybackManager 生命周期绑在 ChatContainer + voiceMode** | 切 thread 卸载 ChatContainer、或用户开关一次 Voice Mode，都会触发 `destroy()` + 置 null，**听读会被静默销毁**，与 KD-10 全局会话直接冲突 | Phase B 前置：把单例提升到 AppShell，effect 依赖与 cleanup 不再绑 `session?.voiceMode`；加 integration test 覆盖「切 thread / 切 voiceMode 后听读仍在播」 |
| KD-9 抑制语音后用户不知情 | 猫说了话但没出声，用户以为猫没回应 | 被抑制的语音消息必须留可见的「点这里听」入口，不能静默丢弃 |

## Tips Contribution（F244）

- Surface: Workspace rendered Markdown
- Trigger: 用户首次打开长 Markdown，或选中正文句子
- Tip: “点「听读」从头播放；选中一句可从这里开始，进度和缓存会自动保留。”
- Sunset: 用户完成一次句子级开播后不再主动提示。

## Review Gate

- Phase A 已以真实 Workspace 原型取得 operator Design Gate signoff；证据锁定
  `007ebe3de33eaea853cda27da77dc314e75eff42`。
- 行为改动需非作者独立验证，并覆盖最终 HEAD。
- 路径安全、共享资产回收、持久状态和 PlaybackManager 互斥是阻塞项。
- 完成只在 AC 有测试、指标或真实 Workspace UAT 证据后声明。
