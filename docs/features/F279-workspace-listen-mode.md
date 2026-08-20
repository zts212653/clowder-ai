---
feature_ids: [F279]
related_features: [F063, F066, F091, F111, F112, F153, F284]
topics: [workspace, markdown, listen-mode, tts, audio, cache, accessibility]
doc_kind: spec
created: 2026-07-28
description: "让用户在 Workspace Markdown 中从任意句开始听读，并以可见、可复用、可清理的本地音频缓存持续续听。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-08-14T21:00:00-07:00
---

# F279: Workspace Listen Mode — 正文听读与可复用音频缓存

> **Status**: in-progress / Phase A passed; Phase B complete; Phase C implementation landed with full Workspace UAT pending; Phase D background full-document cache Design Gate draft pending operator signoff
> **Owner**: 小太阳·Maine Coon (@codex-sol, GPT-5.6 Sol)
> **Priority**: P1
> **Created**: 2026-07-28
> **operator source**:
> `0001785253452969-000151-f93c9786` — “我们这能力得做在我们的workspace里能点才行”；
> `0001785254502978-000008-67e5f9fd` — 确认可以采用 7 天清理，并询问是否应按完整 Feature 设计；
> `0001785313307088-000072-a543a12d` — “我觉得对于design gate 我感觉ok了”；
> `0001786603237557-000040-5b8645f4` — 反馈边听边缓存卡顿、暂停会让缓存停止，并提出一键缓存能力；
> `0001786765382711-000136-e263f5dc` — 再次反馈逐句听读“一卡一卡”。
> **Owner verdict**: 是；这是一条跨 Workspace、播放与缓存生命周期的独立用户旅程，正式立项为 F279。

Architecture cell: `hub-action-surface` + `transport`

Map delta: `none`

Why: 播放条仍属于既有 Workspace 用户动作面；TTS capability identity 扩展既有 sidecar 生命周期契约，不新增 Store、Queue、Router 或服务边界。

Why: Workspace 是用户入口；F066/F111 继续拥有 TTS 合成能力，F112 继续拥有共享播放队列。F279 只拥有“文档 → 可听句段 → 播放/续听/缓存状态”的编排与用户状态，不新建第二套播放器或平台级存储。

## Why

长篇正文在视觉阅读时容易让operator失去专注，听读反而更容易持续吸收。macOS 自带朗读虽然能临时工作，但声音、交互和 Workspace 上下文都不合格：不能在正文里自然点一句开播，也没有我们自己的续听、句子高亮和缓存管理。

家里已经分别拥有 Markdown 渲染、TTS 合成、流式分句和播放队列，却还没有把这些能力接成一个用户能直接使用的“听正文”旅程。F279 的目标不是再造 TTS，而是让operator在 Workspace 打开一篇 Markdown 后，**从任意句开始、按自己舒服的速度听下去；听过的内容可以立即重播，缓存何时清理一眼可见。**

## Current State（updated 2026-08-14）

- F063 已支持 Workspace Markdown 渲染、文本选择和媒体预览，但没有“听读”入口。
- F066 提供本地 TTS；F111 提供流式分句；F112 提供 pause/resume/skip/interrupt 的共享 PlaybackManager。
- `/api/tts` 已按文本、voice、model、speed 等指纹缓存 `.wav`；相同输入实测 cache hit 约 `3.7ms`。
- 旧链路会在每次请求重新加载模型，并在完整 WAV 生成后才返回；它只能证明整句 RTF，不能证明用户首音频延迟。
- 2026-08-10 在隔离 `mlx-audio 0.4.7`、Qwen3-TTS 1.7B Base、Maine Coon真实参考声线上完成原生流式 UAT：
  - 代表性长句在 `517ms` 返回首个独立可播 WAV chunk；
  - `1.594s` 时已累计 `1.92s` 音频，满足播放器 `1.5s` 起播水位；
  - 完整 `8.08s` 音频在 `6.276s` 生成完成，RTF `0.777`；1.5× 播放期间仍保有缓冲余量；
  - 共 17 个 chunk，每个 chunk 和最终资产都以 RIFF/WAV 魔数验证；不是把一个未完成 WAV 粗切字节的伪流式。
- Qwen clone sidecar 现在启动时加载并常驻一个模型实例，冷请求走模型原生 `stream=True`；运行时 fail closed 要求 `mlx-audio >= 0.4.7`。完整 WAV 仍写入内容寻址 cache，热命中不再调用模型。
- 现有 cleaner 每 6 小时清理超过 7 天的文件，并在缓存超过 500MB 时按 LRU 压回 400MB。
- 音频 cache 已脱离 runtime cwd：显式 `TTS_CACHE_DIR` 优先，否则落到 `${CAT_CAFE_DATA_DIR}/assets/tts`，未配置用户数据根时使用 `~/.cat-cafe/assets/tts`；`~` 会展开为用户主目录。PR #3589 已把 API 写入、cleaner 与 connector media 回读统一到同一 resolver。文档 manifest、续听位置、缓存状态与用户可见清理入口仍由 F279 的独立状态链管理。
- F284 已把 Workspace 重构为 contextual shell；Files 和文件详情仍是持久 Workspace 内的正式层级，且访问后的 Workspace 在折叠/切换 sibling host 时保持挂载。F279 的入口继续属于 rendered Markdown 文件详情；2026-08-12 operator 实测后把完整 player 移入 Workspace 顶部的正常布局流，避免遮挡聊天输入框。播放会话仍由 AppShell 级 PlaybackManager 持有；Workspace 不可见时，AppShell 只呈现位于输入框上方的紧凑暂停/返回入口，返回正文继续调用 F284 的 canonical Files/detail store transition。
- 生产实现已接入 F284：rendered Markdown 工具栏/inline sentence span、Workspace 内嵌播放器、逐句预取、句内位置节流持久化、语音自动播放抑制、缓存状态/清理 UI 均已落代码。Python 原生模型流 → Node provider NDJSON → API SSE 继续提供合成进度和最终完整资产，但浏览器不再逐块播放独立 WAV。
- 2026-08-14 的真实运行时证据推翻了“原生 chunk 可直接连续播放”的假设：每个约 `0.5s` chunk 都触发一次 `HTMLAudioElement.src` 重载，Chromium 实测单次空档约 `55ms`；真实完整句资产另带 `302–594ms` 的模型启动静音。当前修复让播放器只入队完整句资产，并在听读专用、独立版本的 cache 写入前把句首静音裁到约 `14–25ms`。原生 chunk 仍可留在 SSE 作为进度信号，不再成为可听播放单元。
- TTS SSE 使用 raw Node response 时必须保留 Fastify hook 已批准的 CORS 与安全响应头；浏览器跨源失败显示真实 `session.error`，不能用当前句正文遮蔽。
- 当前客户端预取窗口只有 4 句，窗口只在播放 item 结束后向前推进；pause 不会直接 abort 正在生成的一句，但会阻断后续窗口推进。缓存和播放仍由同一个 `DocumentListenController` 编排，也没有开播前可达的“只缓存全文”动作。2026-08-12 operator 的真实使用反馈据此追加 Phase D：文档级后台缓存任务必须与播放器状态解耦。
- F289 的 one-shot production migration 已 NO-GO；F279 已从该 stack 脱离并直接重落 current main。可清理音频继续遵循现有 `TTS_CACHE_DIR`，续听位置、倍速、retention 与 manifest 由 F279 自己的窄 resolver 落在用户数据根，不能把 TTL=0 用户状态藏进可清理 cache 目录。

## Product Boundary

### v1 包含

- Workspace 内已渲染的本地 Markdown。
- 从全文开头或任意正文句子开始听。
- 播放/暂停、上一句/下一句、`0.75× / 1× / 1.25× / 1.5× / 2×`。
- 当前句高亮、自动跟随与手动滚动后的温和恢复。
- 分句预取、内容寻址复用、重开文档续听。
- 开播前显式“缓存全文”；缓存任务独立于播放 pause/stop，并在文件工具栏与播放器中显示同一进度。
- 缓存状态、清理当前文档、7 天/30 天/永久保留选项。
- Workspace 顶部内嵌完整 player：不覆盖聊天输入；关闭 Workspace、切文件或切 thread 时播放会话继续，并保留位于输入框上方的紧凑暂停/返回入口（KD-10）。
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

**S4 — 先缓存后听**：operator在 rendered Markdown 工具栏点“缓存全文”，不必先开播；进度原地更新。随后暂停/关闭听读、切文件、切 thread 或折叠 Workspace 时缓存继续，只有显式“取消缓存”或确认清理才停止。再次开播直接复用已完成句段。

## Domain Contract

### 1. Markdown → 可听句段

- 输入是 Workspace 已解析的 Markdown 语义树，不从 DOM 文本或原始行号猜句子。
- 默认读取标题、正文段落、列表项和引用。
- YAML frontmatter、代码块、表格标记和裸 URL 默认跳过；用户显式选择时可作为一次性文本朗读。
- 每个句段持有文档内 occurrence/anchor；相同文本在同一文档出现多次时仍能分别定位和高亮。

### 2. 文档与音频身份

- 文档身份由 `project + relativePath` 确定，内容 digest 用于判断版本。
- 听读完整句资产由 `normalized text + provider/model/voice/language/speed/format + reference voice fingerprint + listen processing version` 内容寻址；处理版本变化必须作废旧的未处理缓存。
- 文档修改不整体作废缓存：未变化的句段继续复用，变化句段只重合成自己。
- API 返回受控 asset URL 和状态，不向前端暴露可拼接的任意文件系统路径。

### 3. 持久化与寿命

- 可清理音频资产使用稳定用户数据根：显式 `TTS_CACHE_DIR` 优先，否则使用 `${CAT_CAFE_DATA_DIR}/assets/tts`，未配置用户数据根时落到 `~/.cat-cafe/assets/tts`；home-relative override 会展开。F279 不复制已暂停的 F289 catalog 或迁移代码，也不自动删除/迁移旧 checkout-relative cache。
- 文档 manifest、播放位置、倍速与 retention 由 F279 的 `resolveDocumentListenStatePath` 独立解析：显式 `LISTEN_MODE_DB` 优先，否则使用 `${CAT_CAFE_DATA_DIR}/listen-mode.sqlite`，未配置用户数据根时落到 `~/.cat-cafe/listen-mode.sqlite`。它不与音频 cache 共寿命；该状态尚未发布，因此无 legacy migration source。
- 默认音频 retention 为 **7 天未使用**，而非“创建后 7 天”；可选 30 天或永久（TTL=0）。
- 文档 manifest、播放位置、倍速与 retention 选择属于用户可见状态，始终 TTL=0；音频过期不会抹掉它们。
- “清除此文档缓存”只解除文档引用并回收无引用资产；内容寻址资产仍被其他文档引用时不得误删。

### 4. 播放协调

- 必须复用 F112 PlaybackManager；Listen Mode、猫猫语音和播客不能并行争抢同一输出。
- pause/resume/skip/interrupt 的原有语义保持一致；F279 只增加 sentence seek 和 playback rate。
- 播放倍速只由浏览器 `playbackRate` 控制，不进入听读音频指纹、不触发重新合成；同一声线/正文的完整 WAV 可跨五档倍速复用。
- 一个句子只以处理后的完整 WAV 进入 PlaybackManager，作为一个逻辑 item；独立 WAV chunk 不得按多个 `HTMLAudioElement.src` 顺序播放。句子结束才推进位置，seek 使用句内时间。
- sidecar 的原生 chunk 只用于合成进度与最终资产生产；API 的 raw SSE 响应必须继承 Fastify 已批准的 CORS/安全头，完整资产到达前不得向播放器暴露不连续的可听片段。
- 切换文档或关闭 Workspace 时，不自动丢弃持久续听位置。

### 5. 文档级后台缓存任务

- job ownership 从认证 principal 取得 `userId`，不接受客户端自报 owner；start/status/cancel/attach 都按 `userId + projectPath + relativePath` 隔离。
- logical job identity 为 `userId + document identity + content digest + synthesis fingerprint`；每次 start/continue/retry 都持有单调递增的 `runEpoch`。同一 logical identity 同时最多一个 active run，重复启动幂等并跳过 cache hit。
- cache job 不把音频 chunk 注入 PlaybackManager；播放 pause/resume/stop 与 cache job 生命周期正交。切文件、切 thread、Workspace 折叠或页面重开后仍可重新附着进度。
- 正在听的 cache miss 在句子边界优先于 background remaining；同一 asset 的进行中请求合并，不建立第二套全局合成 queue。
- durable status 明确区分 `queued/running/completed/cancelled/interrupted/failed`：显式取消为不自动恢复的 cancelled；服务重启把遗留 active run 变为可继续的 interrupted；failed 持久化失败 anchors 与去正文 error summary，让“重试剩余”有精确目标。
- 取消原子撤销 current epoch，只停止剩余工作并保留已缓存资产；active job 下“清除此文档音频”必须在同一事务中先撤销 epoch，再按既有引用语义回收。
- worker link asset 必须是条件写：仅当 `userId/document/runEpoch/status=running/expected digest/fingerprint/anchor membership` 全部仍匹配才提交。clear、cancel、内容 digest 或 voice fingerprint 改变后的晚到结果必须被忽略，不得复活 link/progress；无引用 asset 交给既有 cleaner。
- current job state 与 `runEpoch` 进入既有 listen-mode SQLite，TTL=0，不跟随音频资产过期；只保留 current run projection，不要求另建无限增长的 job history。terminal state 不原地复活，continue/retry 一律创建新 epoch。

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

### Phase D — Background Full-Document Cache

- rendered Markdown 工具栏提供开播前可达的“缓存全文”；播放器 cache chip 复用同一 job 状态；
- cache job 从 PlaybackManager 状态机中拆出，拥有 user-scoped、run-epoch fenced 的幂等 start/status/cancel 与恢复语义；
- 单模型调度在句子边界优先服务播放 miss，再继续 background remaining；
- 真实 Workspace 原型先取得 operator Design Gate signoff，再进入生产实现。

## Acceptance Criteria

### Phase A — UX

- [x] **AC-A1**: 渲染 Markdown 顶部存在可发现但不喧宾夺主的“听读”入口。
- [x] **AC-A2**: 用户能对正文中的任意句触发“从这里听”，当前句清晰高亮。
- [x] **AC-A3**: 桌面与窄屏均能完成播放/暂停、跳句、倍速、返回正文。
- [x] **AC-A4**: 首句合成、预取不足、错误、空正文和缓存命中都有不撒谎的界面状态。
- [x] **AC-A5**: 缓存大小、保留期限和“清除此文档”可见且能理解后果。
- [x] **AC-A6**: operator 在实际 Workspace 原型上完成 Design Gate signoff。
- [x] **AC-A7**: 原型使用**真实 fixture 正文**（长段落 + 表格 + 引用块 + 加粗），不使用「一句一块」的简化假正文；段落内第 N 句可起播且高亮不破坏阅读排版。
- [x] **AC-A8**: 切文件 / 切 thread 后播放不中断；Workspace 打开时，其顶部完整 player 显示当前文档与句位置；Workspace 不可见时仍有紧凑暂停/返回入口，切回该文档时正文高亮重新接上，且两种控制条都不覆盖聊天输入（KD-10）。
- [x] **AC-A9**: 听读进行中收到猫猫语音时，界面呈现被抑制的语音并提供可点播入口，用户不会误以为猫没回应（KD-9 / OQ-4）。

### Phase B — Domain

- [x] **AC-B1**: 标题/段落/列表/引用被稳定分段；leading frontmatter 不出现在阅读画布也不进入听读句段，代码块/表格标记/裸 URL 默认跳过。
- [x] **AC-B2**: 文档修改后，只对变化句段 cache miss；未变化句段继续命中。
- [x] **AC-B3**: 重复句子不会导致高亮、跳转或续听位置串位。
- [x] **AC-B4a**: 文档 manifest、续听位置、倍速与 retention 写入稳定的用户数据根；runtime checkout 切换后仍能恢复。
- [ ] **AC-B4b**: 音频资产写入稳定 data root；runtime checkout 切换后仍能命中。稳定 cache-root 契约与统一 resolver 已由 PR #3589 合入；仍待本次 runtime restart 后跨 checkout 实测 cache hit，验证前保持未勾。
- [x] **AC-B5**: 默认按 last-used 7 天清理；30 天和永久保留按用户选择生效。
- [x] **AC-B6**: 清理当前文档不会删除仍被其他 manifest 引用的共享资产。
- [x] **AC-B7**: 清理音频后，播放位置、倍速和 retention 选择仍可恢复。
- [x] **AC-B8**: asset API 无目录穿越，用户不能用相对路径读取缓存根之外文件。

### Phase C — Playback and Performance

- [x] **AC-C1**: 用户可从全文开头或任意句开始，播放/暂停、上一句/下一句和五档倍速均工作。
- [x] **AC-C2**: Listen Mode 复用 F112 PlaybackManager；与猫猫语音/播客切换时只有一个音源活动。
- [ ] **AC-C3**: cache hit 到首个可听音频的用户可见延迟 ≤1s；服务端热缓存证据已具备，仍待真实 Workspace 浏览器音频起播验证。
- [ ] **AC-C4**: 参考 M 系列 Mac 的冷启动首句延迟目标为 p50 ≤6s、p95 ≤8s；若未达标，界面仍即时进入真实 loading 状态。
- [ ] **AC-C5**: 1×/1.5× 在代表性长文中连续播放无可感知句间断裂；2× 不足时显式 buffering、不乱序、不重复。
- [x] **AC-C6**: 重新打开同一文档能恢复上次句段、句内位置（若可用）和倍速。
- [ ] **AC-C7**: 指定研究文档的冷/热缓存、续听、文档编辑、清理和 2× 旅程均通过真实 Workspace UAT。

### Phase D — Background Full-Document Cache

- [ ] **AC-D1**: 未开始听读时，rendered Markdown 工具栏可一键启动全文缓存。
- [ ] **AC-D2**: 播放 pause/stop、切文件、切 thread、Workspace 折叠都不会停止 active cache job；服务持续运行期间只有显式取消/清理会停止。
- [ ] **AC-D3**: 文件工具栏与播放器显示同一份 `cached/total` 与 `queued/running/completed/cancelled/interrupted/failed` 状态；cancel → reload 保持 cancelled，服务重启 → reload 显示 interrupted 且可继续；failed anchors/error summary 可恢复并精确驱动“重试剩余”。
- [ ] **AC-D4**: start/status/cancel/attach 均从认证 principal 绑定 `userId`；同一 logical job 重复启动幂等，新的 continue/retry 使用新 `runEpoch`；cache hit 跳过，同一 asset 不重复并发合成。
- [ ] **AC-D5**: 边缓存边听时，播放 miss 在句子边界优先，后台任务不会破坏顺序、重复播放或误报播放器失败。
- [ ] **AC-D6**: 取消保留已完成资产；active job 下清理在同一事务中撤销 current epoch 再按引用语义回收。集成竞态测试 hold synthesis → clear/cancel → release result，证明晚到结果不能复活 link/progress；cancel → reload 不得自动恢复。
- [ ] **AC-D7**: 文档编辑/voice fingerprint 变化不会把旧 job 结果误连到新 manifest；集成竞态测试 hold synthesis → 更新 digest → release result，证明旧结果被 fence；两个 user 使用相同 path/digest 时 job/status/link 完全隔离。未变化资产仍可内容寻址复用。
- [ ] **AC-D8**: operator 在真实 Workspace 原型确认入口、文案、状态与窄屏退化后，才进入生产实现。

## Mechanism Selection

- **确定契约**：Markdown 分段、cache/job identity、retention、引用回收、续听位置、路径安全、播放/缓存生命周期正交和单播放器互斥由单元/集成/E2E 测试与守卫证明。
- **运行健康**：首句延迟、合成 real-time factor、cache hit/miss、buffer depth、underrun、cache-job queue wait/throughput/failure 进入 logs/metrics；以 benchmark script 和真实长文 UAT 验证，不挂 Eval Hub。

## Observability

每次 listen session 至少记录：

- `first_segment_ready_ms`、`first_audio_play_ms`；
- `tts_synthesis_rtf`；
- `cache_hit` / `cache_miss` 及 miss reason；
- `prefetch_buffer_segments`、`buffer_underrun_count`；
- cache job 的 `queued/running/completed/cancelled/interrupted/failed`、已完成/总句数、queue wait、失败句 anchor 与去正文 error summary（不记录正文）；
- document identity 只记录稳定 digest/受控 ID，不记录正文内容。

## Requirements Traceability

| ID | 用户需求 / 约束 | Feature contract | 验证 |
|---|---|---|---|
| R1 | “喜欢听，不喜欢看” | Workspace 原生 Listen Mode | AC-A1, AC-C7 |
| R2 | “选择从哪一句开始” | 句子 action + stable anchor | AC-A2, AC-B3, AC-C1 |
| R3 | “选择倍数，暂停” | 五档倍速 + F112 播放控制 | AC-A3, AC-C1/C2 |
| R4 | “在我们的 workspace 里能点” | F063 渲染面内的第一方动作 | AC-A1/A2/A6 |
| R5 | “合成过一遍缓存起来” | 内容寻址 chunk + manifest | AC-B2/B4a/B4b, AC-C3 |
| R6 | “知道音频放在哪里” | 稳定 data root + UI 可见状态 | AC-A5, AC-B4b |
| R7 | “自己清理 / 几天清理” | 7d/30d/永久 + 单文档清理 | AC-A5, AC-B5/B6 |
| R8 | 2× 是否跟得上 | 预取、buffer 指标、显式缓冲 | AC-A4, AC-C4/C5 |
| R9 | 用户状态默认持久化 | manifest/position/settings TTL=0 | AC-B7, AC-C6 |
| R10 | “暂停又暂停缓存；需要一键缓存” | 播放/缓存生命周期解耦 + 显式全文 cache job | AC-D1..D8 |

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
| KD-10 | **听读是全局播放会话，完整控制条属于 Workspace 正常布局流；播放中必须始终有可达的暂停入口**：切文件、切 thread 或暂时关闭 Workspace 时继续播放；Workspace 打开时顶部显示完整控制条，不可见时显示输入框上方的紧凑暂停/返回入口 | 2026-07-29 operator 选择全局续播；2026-08-12 首次真实界面实测发现 AppShell fixed 横条遮挡聊天输入，operator 明确把完整控制移入 Workspace。生命周期与完整 UI 所有权拆开，同时保留不遮挡输入的全局安全控制，避免播放会话变成不可控后台状态。 |
| KD-11 | 当前句高亮走 inline sentence span，不切块 | 真实正文（AC-C7 指定 fixture）是每段 3–5 句的长段落 + 表格 + 引用块；块级高亮只在「一段=一句」时成立。家里已有 inline 先例：`content-overflow/readerSearch.tsx:32` 的 `<mark>` 经 `MarkdownContent` 的 `textProcessor` 注入，且天然跳过 code/pre |
| KD-12 | 冷请求仍走 Qwen 原生模型流，但浏览器只播放裁除启动静音后的完整句资产；听读 cache 指纹包含处理版本 | 真实 UAT 证明独立 WAV chunk 每 `0.5s` 触发约 `55ms` 切源空档，直接抵消了首块优势；当前真实句子 RTF 为 `0.330–0.379`，完整句能在前句播放完前预取。独立版本避免复用旧的长静音资产，并为后续处理变更提供显式失效边界 |

## Dependencies

- **F063**: Workspace Markdown surface 与文档 action。
- **F066**: TTS provider、voice/model 配置。
- **F111**: 分句/流式合成能力。
- **F112**: 共享 PlaybackManager 与互斥播放语义。
- **F091**: 可参考其 podcast/audio asset 经验，但不复用 Signal 专属 Study 域。
- **F153**: 指标进入既有 observability substrate；F279 不要求先完成 F153 全部范围。
- **F284**: Contextual Workspace shell、Files/detail 层级、keep-mounted host 与返回正文的 canonical navigation contract。

## Risks

| Risk | Consequence | Mitigation |
|---|---|---|
| 句段 anchor 随编辑漂移 | 从错句续听/高亮 | semantic anchor + occurrence + digest，编辑旅程测试 |
| 生产默认 Qwen clone 的持续合成慢于实时 | 冷听时 1× 也可能耗尽预取缓冲；1.5×/2× 更频繁断音 | 热缓存即时复用；冷听保留真实 loading/buffering 与 underrun 指标；在 AC-C5 关闭前不得宣称连续播放达标，后续吞吐改进必须落在 provider/chunking 坐标而非只增大句数预取 |
| 独立 WAV chunk 或句首启动静音进入可听链路 | 每个 chunk 都重载浏览器音频源，句内/句间产生规律性卡顿 | 播放器只消费完整句资产；听读 cache 写入前以保守阈值裁除启动静音并保留 `20ms` preroll；前端与 API 回归测试共同守住该契约 |
| 共享 chunk 被误删 | 其他文档突然 cache miss | manifest 引用/可达性回收，非按文件夹粗删 |
| 稳定缓存无限增长 | 磁盘膨胀 | 默认 7d last-used 到期回收 + 可见的单文档清理；30d/永久属于用户保留承诺，不受 size-pressure 驱逐；全局 size cap 只治理无 manifest 引用的 legacy cache |
| 新播放器绕过 F112 | 多音源竞争、状态割裂 | 架构契约 + integration test |
| Markdown 提取读出噪声 | 听感不可用 | 语义树白名单、默认跳过非正文、选择覆盖 |
| **PlaybackManager 生命周期绑在 ChatContainer + voiceMode** | 切 thread 卸载 ChatContainer、或用户开关一次 Voice Mode，都会触发 `destroy()` + 置 null，**听读会被静默销毁**，与 KD-10 全局会话直接冲突 | Phase B 前置：把单例提升到 AppShell，effect 依赖与 cleanup 不再绑 `session?.voiceMode`；加 integration test 覆盖「切 thread / 切 voiceMode 后听读仍在播」 |
| KD-9 抑制语音后用户不知情 | 猫说了话但没出声，用户以为猫没回应 | 被抑制的语音消息必须留可见的「点这里听」入口，不能静默丢弃 |
| F279 继续依赖旧 Workspace 坐标 | 新壳中入口、返回正文或折叠续播失效 | 入口挂 F284 Files/detail 的 `WorkspaceFileViewer`；完整 player 挂 `WorkspacePanel` 的非覆盖布局；AppShell 持有全局播放寿命与紧凑 away control；返回正文只走 `setWorkspaceOpenFile` canonical transition |
| 把 TTL=0 文档状态放进音频 cache | 用户清缓存时丢失续听位置/倍速/retention | F279 用独立 SQLite + 窄路径 resolver 持久化用户状态；`TTS_CACHE_DIR` 只放可替换音频，清音频只解除 asset link |
| 每句重新加载 Qwen 或等待整句 WAV | 首句慢、预取吞吐不足，UI 虽有 loading 但不可日用 | sidecar 启动时加载并复用模型；`mlx-audio >=0.4.7` 原生模型流；API 逐块转发且最终完整资产落 cache；版本不满足时 fail closed |
| 后台全文缓存与前台听读争抢单模型 | 冷听更卡，新增按钮反而放大 underrun | 不并发重复合成；播放 miss 在句子边界优先，后台任务继续剩余 miss；产品明确“一键缓存”主要支持先缓存后听，不承诺提升单模型吞吐 |
| clear/编辑后旧 worker 晚到 | 已清理音频或新 manifest 被旧 run 重新写回；跨用户同路径串状态 | user-scoped logical identity + 单调 run epoch；clear/cancel 原子撤销，asset link 只接受仍匹配 user/document/epoch/digest/fingerprint/anchor 的条件写；竞态与双用户隔离测试阻塞 Design Gate |

## Tips Contribution（F244）

- Surface: Workspace rendered Markdown
- Trigger: 用户首次打开长 Markdown，或选中正文句子
- Tip: “点「听读」从头播放；选中一句可从这里开始，进度和缓存会自动保留。”
- Sunset: 用户完成一次句子级开播后不再主动提示。

## Review Gate

- Phase A 已以真实 Workspace 原型取得 operator Design Gate signoff；证据锁定
  `007ebe3de33eaea853cda27da77dc314e75eff42`。
- Phase B/C 生产实现修复后 exact HEAD 为
  `fe15c18dd1464e9d758d2adff3d08aa6b05f1a02`；Web 修复聚焦 22/22、API 修复聚焦 15/15 与完整 gate 均通过。非作者 reviewer `@opus5` 在
  `0001786350373337-000090-38a5b65d` 对该 exact HEAD 给出 terminal
  `APPROVE`；其浏览器实测与 focused test 复核覆盖全部六项 review delta。
- 分支后续 observability delta `81052ff94` 只增加 WAV 时长推导与回归测试；RED 为 `durationSec === undefined`，GREEN 为 provider 27/27，真实 sidecar response 返回 `durationSec: 4.24` / `synthesisMs: 8576`。它不冒充吞吐修复，也不继承前一 exact HEAD 的 review verdict。
- F279 于 2026-08-11 从 paused F289 stack 脱离并 clean rebase 到 current main；PR #3577 exact HEAD `9451a680f` 的完整门禁通过，非作者 reviewer 的 terminal APPROVE 由 patch-equivalent rebase continuity 桥接。operator 在 `0001786493877050-000271-e3f08035` 授权合入后，GitHub squash merge 为 `e0119fd88`；按同一指令未启动 runtime。真实 TTS UAT 已证明热缓存/恢复/清理链路，但冷合成 p50/p95 与连续播放仍未达到 AC-C4/C5，AC-C3 的“首个可听”也还缺浏览器音频起播证据。
- 稳定音频根目录 PR #3589 由非作者 reviewer `@opus5` 在 source `0001786500824471-000357-e2ffee7e` 对 exact HEAD `8a89a0419` 给出 terminal APPROVE；最终 rebase HEAD `89a280998` 的两笔 patch-id 与已审版本相同，且在 `origin/main@3ce86ca19` 上重新通过完整 `pnpm gate` 与 GitHub CI。GitHub squash merge 为 `162111510`；runtime 仍未启动，AC-B4b 保持等待跨 checkout cache-hit UAT。
- 行为改动需非作者独立验证，并覆盖最终 HEAD。
- 路径安全、共享资产回收、持久状态和 PlaybackManager 互斥是阻塞项。
- 完成只在 AC 有测试、指标或真实 Workspace UAT 证据后声明。
