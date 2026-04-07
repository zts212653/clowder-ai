---
feature_ids: [F138]
related_features: [F054, F093, F144]
topics: [video, remotion, waoowaoo, bilibili, tutorial, content-pipeline, schema, tts-alignment, multimodal]
doc_kind: spec
created: 2026-03-24
updated: 2026-04-05
---

# F138: Cat Café Video Studio — AI 视频制作管线

> **Status**: in-progress (Phase 1 基建中：spec 驱动 composition + FA 集成 + showcase 素材录制) | **Owner**: Ragdoll + 金渐层 | **Priority**: P1

## Why

> "来吧猫猫 立项吧！link waoowaoo 和 Remotion，我们的第一个目标就是把我们的做出我们的 bilibili 的视频？比如先把我们的教程做成视频？"
> — team lead，2026-03-24

Cat Café 需要**系统化的视频制作能力**，不再是一次性手搓 Remotion 代码。目标：

1. **把教程做成 B 站视频**——Cat Café 的 setup guide、bootcamp 流程、功能演示都应该有视频版
2. **重构现有介绍视频**——V4.8 是手动分镜 + 手写代码，学习 waoowaoo 后应该能更自动化
3. **建立可复用的视频制作管线**——team lead给素材+脚本，猫猫自动排版渲染

### 核心原则（GPT Pro 设计审阅 2026-03-25）

> **先把"视频 spec"做成中枢神经，再让 AI、Remotion、队列、发布系统都围着它转。不要反过来让 prompt 当王。**

### 两条生产路径（2026-04-05 三猫讨论收敛）

F138 需要同时支持两条视频生产路径，对应不同场景和复杂度：

**路径 B：先脚本后素材**（Phase 1 主攻）
```
分镜脚本（人写） → 素材录制 → voice-script → TTS + timestamps
→ Remotion 自动对齐 → 预览 → 审片 → 成片
```
- 适合：教程、showcase、宣传片——内容结构预先设计好
- 人的输入：分镜脚本 + 素材粗录 + 关键时间点粗标
- 猫的工作：节奏控制（trim/加速/跳剪）、TTS 配音、字幕、渲染
- **对齐机制**：TTS 输出 word-level timestamps → 自动生成 Remotion Sequence timing

**路径 A：先素材后配音**（Phase 3 引入）
```
原始视频 → 场景分段（镜头变化检测） → 多模态模型逐段理解画面
→ LLM 按段生成第一人称独白（字数≈段时长） → TTS + timestamps
→ 配音自动铺放到对应时间段 → 成片
```
- 适合：日常记录、快速出片、"丢视频自动配音"场景
- 人的输入：原始视频 + 风格/调性关键词
- 猫的工作：画面理解 + 文案生成 + 配音 + 自动对齐
- **核心依赖**：多模态视觉小模型（如 Qwen-VL-2B）逐帧/逐段理解
- 这就是短视频平台（剪映/CapCut「图文成片」）的核心能力

> **类比**：路径 B 像写论文（先大纲后填内容），路径 A 像写日记（先经历后记录）。两条路共享 video-spec + voice-script + Remotion 渲染层，只是 spec 的生成方式不同。

### 锻造策略：用实战磨管线（对标 F144 PPT Forge）

> "ppt 那个 feat 也是我们一起做了 ppt 然后不断打磨我们的管线" — team lead，2026-04-05

不从 schema 纸上设计开始，而是 **边做真实视频边沉淀工具链**：

1. 用 `showcase-features.md` 的 60s 精华版视频作为第一个训练场（路径 B）
2. 做的过程中记录痛点 → 沉淀为 `video-forge` Skill
3. 冻结在实战中验证过的 schema（不是空想的 schema）
4. 用第二支视频（攻防战 or 教程）验证管线复用性
5. 管线稳定后再补 queue/AI/发布

这和 ppt-forge 的成长路径完全一致：先手搓 HTML slide → 沉淀 Skill → 沉淀 schema → gate 化。

### 现状

- **已有**：`/home/user/` — 2,182 行 Remotion 代码，15+ 轮迭代经验
- **已有**：`docs/videos/cat-cafe-intro/` — 分镜脚本 + 素材索引 + 制作复盘
- **已有**：猫猫 TTS 声线（Ragdoll/Maine Coon/Siamese，F066/F103）
- **缺失**：没有 canonical video spec（事实散在聊天/代码/旁白/字幕里）
- **缺失**：没有自动化流水线，每次做视频都是从零手写场景组件
- **缺失**：没有 AI 辅助分镜/图片生成/角色一致性
- **缺失**：没有 BGM 管理、没有 B 站发布能力

### 参考项目

**[waoowaoo](https://github.com/saturndec/waoowaoo)**（10.2k stars）— AI 影视全流程生产平台：
- 技术栈：Next.js 15 + Remotion v4 + BullMQ + Prisma + fal.ai
- 可学习的：Prompt catalog + variable contract、BullMQ 任务编排、timeline 数据模型、provider-agnostic AI 接口
- ⚠️ 无 License，只能作为参考架构，不能直接复制代码
- ⚠️ editor 导出闭环缺失（只有前端壳子，不是完整生产系统）

## What

> Phase 重排基于 GPT Pro 设计审阅（KD-3），从原来的 A/B/C 三阶段调整为 0→1→2→3→4 五阶段。
> 核心变化：spec 先于队列先于 AI。

### Phase 0: 先冻住合同，不先堆功能

**做**：
1. **冻结最小 schema 合同集**
   - `asset-manifest.v1` — 素材清单（含 checksum、productVersion、recordedAt、license）
   - `video-spec.v1` — 视频规格中枢（从 storyboard 升级，含 purpose/mustShow/mustSay/locks）
   - `voice-script.v1` — 配音脚本（教程视频的中枢神经，比 subtitle-track 更早冻结）
   - `render-job.v1` — 渲染任务（做薄，只引用 snapshot）
   - `publish-manifest.v1` — 发布元数据（B 站封面/分区/标签从第一版就占位）
2. **版本快照机制** — `project@vN` snapshot，render-job 只消费冻结的 spec
3. **素材管理规范** — 压缩标准（CRF 23、AAC 128k、1080p max）、大文件存储方案

**不做**：
- 自定义 timeline/editor（Remotion Studio 已够用）
- provider-agnostic AI 接口
- 自动发布

### Phase 1: 做"可复用的教程视频生产环"（路径 B 主攻）

用 **2 支真实视频** 跑通同一条管线（第一支已确定为 showcase）：

```
brief → asset ingest → video-spec → voice-script → TTS(+timestamps) → Remotion 自动对齐 → preview → review patch → final render
```

1. **第一支视频：Feature Showcase 60s 精华版**（✅ team lead已拍板 2026-04-05）
   - 8 段画面（多猫协作/飞书同步/语音声线/Browser Preview/记忆搜索/Rich Block/训练营/学习伴侣）
   - team lead录素材 + 粗标关键时间点，猫猫并行建管线
2. **第二支视频：待定**（攻防战 or 安装教程 or 训练营演示）— 验证管线复用性
3. **Remotion 模板库重构** — 从一次性 demo 重构为 schema 驱动的模板库
4. **TTS + forced alignment → Remotion 自动对齐**（⚠️ 2026-04-05 修正：不赌 TTS 原生 timestamps）
   - CosyVoice **全局配音**（完整剧本一口气读完，不段级切碎）
   - Qwen3-ForcedAligner（首选）/ WhisperX（备选）输出 word-level timestamps
   - 自动转换为 `<Sequence from={timestamp * fps} durationInFrames={...}>` 编排
   - voice-script 驱动字幕时序，不再手动标注每句字幕的起止秒数
   - 架构：Data Contract (JSON) 与 Renderer (Remotion/FFmpeg) 解耦
5. **写 `video-forge` Skill**（对标 ppt-forge SKILL.md）
   - 场景路由：brief → 素材入库 → spec 冻结 → 配音 → 渲染 → 审查 → 交付
   - 多猫分工：Ragdoll（内容+编排）、Maine Coon（音画同步+事实审查）、Siamese（节奏+调性）
   - 审查标准：类比 ppt-forge 的视觉审查 6 件套

### Phase 2: 上生产运维能力

1. **BullMQ 异步队列**（参考 waoowaoo 的 4 队列思路，自己实现）
   - `ingest` — 素材归档、元数据提取、proxy 生成
   - `ai-draft` — 跑 chapter-plan、storyboard、voice-script、gap-analysis
   - `audio-build` — TTS、音量标准化、ducking、mix stems
   - `render-preview` — 低成本预览渲染
   - `render-final` — 正式成片 + 封面导出
   - `publish` — 上传 + 回写 external id + 核验
2. **三轴状态机**
   - `editorial_state`: briefing → drafting → review_required → changes_requested → approved
   - `build_state`: idle → ingesting → preview_rendering → final_rendering → failed
   - `release_state`: not_ready → metadata_ready → publishing → published → publish_failed
3. **失败分类** — transient（自动重试）vs terminal（人工介入）

### Phase 3: 把 AI 接进来 + 路径 A 能力

**路径 B 增强（AI 辅助脚本编写）**：
1. **Prompt catalog**（第一批）
   - `chapter-plan` — 从 brief 生成章节划分
   - `storyboard-plan` — 从 brief + asset summaries 生成分镜建议
   - `voice-script-draft` — 从 approved storyboard 生成旁白草稿
   - `asset-gap-analysis` — 检查素材缺口
   - `cover-copy` — 封面文案
2. **Prompt 铁规矩**：输出必须是 JSON draft 或 JSON patch，不吐 prose（KD-7）
3. **Prompt eval suite** — 5-10 个真实 tutorial brief 做回归测试

**路径 A 引入（先素材后配音）**：
4. **素材自动理解管线**
   - 画面切段：镜头变化检测（ffmpeg scene detect 或 PySceneDetect）
   - 多模态逐段理解：视觉小模型（Qwen-VL-2B / moondream）描述每段画面内容
   - 输出 `auto_markers` — 每段的起止时间 + 画面描述 + 变化类型（静态/活跃/过渡）
5. **按段生成配音文案**
   - LLM 根据画面描述 + 风格关键词，按段生成第一人称独白
   - 字数受段时长约束（~3 字/秒）
   - 输出仍是 video-spec JSON patch
6. **自动铺放**：配音按段时间戳铺入 Remotion timeline

### Phase 4: 生成式素材 + 端到端（远期）

1. AI 封面图 / 插图生成
2. provider-agnostic 生成接口
3. 更复杂的异步多阶段流水线
4. **路径 A 端到端**："丢一段视频 → 自动配音 → 自动成片"（类剪映图文成片）
5. **路径 B 端到端**："一段话描述 → 自动分镜 → 自动生成视频"
6. AI Music BGM 生成

## Acceptance Criteria

### Phase 0（冻结合同）
- [x] AC-0a: waoowaoo 深度调研报告完成 ✅ 2026-03-25
- [x] AC-0b: GPT Pro 设计审阅完成，Phase 重排确认 ✅ 2026-03-25
- [x] AC-0c-pre: 两条生产路径设计收敛（路径 A/B）✅ 2026-04-05
- [x] AC-0c-pre2: 锻造策略确认：用实战磨管线，对标 F144 ✅ 2026-04-05
- [ ] AC-0c: 最小 schema 定义完成（video-spec + voice-script 先行，其余 Phase 2 补）
- [ ] AC-0d: snapshot 版本机制可用
- [ ] AC-0e: 素材管理规范 + 压缩脚本可用

### Phase 1（路径 B 生产环 — showcase 视频锻炼）
- [ ] AC-1a: Remotion 项目重构为 schema 驱动的模板库
- [ ] AC-1b: TTS + forced alignment → Remotion 自动对齐可用（全局音频，不段级切碎）
- [ ] AC-1c: `video-forge` Skill 文件完成（场景路由 + 多猫分工 + 审查标准）
- [ ] AC-1d: 用管线跑通 showcase 60s 精华版视频
- [ ] AC-1e: 用同一套管线跑通第 2 支视频（验证复用性）
- [ ] AC-1f: 至少 1 支视频上传 B 站

### Phase 2（生产运维）
- [ ] AC-2a: BullMQ 最小可用队列：ingest + render-preview + render-final
- [ ] AC-2b: 三轴状态机可用
- [ ] AC-2c: 失败分类 + 自动重试机制

### Phase 3（AI 辅助 + 路径 A）
- [ ] AC-3a: 至少 3 个 prompt（chapter-plan/storyboard-plan/voice-script-draft）可用
- [ ] AC-3b: prompt eval suite 覆盖 5+ 个 tutorial brief
- [ ] AC-3c: AI 生成的 draft 可直接落进 video-spec
- [ ] AC-3d: 路径 A 素材自动理解：场景分段 + 多模态逐段描述 → auto_markers
- [ ] AC-3e: 路径 A 按段配音生成 + 自动铺放 demo

### Phase 4（生成式素材 + 端到端）
- [ ] AC-4a: provider-agnostic 接口定义
- [ ] AC-4b: 路径 B 端到端：brief → 自动视频
- [ ] AC-4c: 路径 A 端到端：原始视频 → 自动配音 → 成片

## Dependencies

- **Evolved from**: F054（HCI 预热基础设施 — B 站 MCP 调研在 F054 Phase 1）
- **Related**: F093（Cats & U 世界引擎 — 介绍视频的创意方向）
- **Related**: F066/F103（Voice Pipeline / Per-Cat Voice Identity — TTS 配音能力）
- **Sister pipeline**: F144（PPT Forge — 管线锻造路径的参考模板）
- **External**: [waoowaoo](https://github.com/saturndec/waoowaoo)（参考架构，无 License，仅学习）

## Risk

| 风险 | 缓解 |
|------|------|
| waoowaoo 无 License，代码不能直接用 | 只学习架构思路和 prompt 模板，自己实现 |
| 大视频素材导致 git 仓库膨胀 | Phase 0 就解决存储方案，schema uri 预留 `s3://` 前缀 |
| B 站 API 限制 | Phase 1 先手动上传，Phase 2 MCP 自动化 |
| AI 生成图片质量不稳定 | Phase 4 才做生成式素材，教程优先屏幕录制 |
| 教程会随产品版本腐烂 | asset-manifest 必须有 productVersion + recordedAt |
| 事实散在多处无 SSOT | video-spec snapshot 化为唯一中枢 |
| 路径 A 多模态小模型画面理解精度不足 | Phase 3 才引入，Phase 1 用人工粗标兜底；粗筛 OK 精选靠人 |
| TTS timestamps 精度因模型而异 | Phase 1 验证 CosyVoice/Qwen-TTS 的 word-level 精度，不够则降级为句级 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | waoowaoo 仅作参考架构，不 fork/复制代码 | 无 License = all rights reserved | 2026-03-24 |
| KD-2 | Phase A 先重构现有 Remotion 代码，再考虑 AI 辅助 | 基础不牢地动山摇 | 2026-03-24 |
| KD-3 | Phase 重排：0→1→2→3→4，spec 先于队列先于 AI | GPT Pro 设计审阅建议 | 2026-03-25 |
| KD-4 | `video-spec` 而非 `storyboard` 作为中枢 schema | 教程语义字段（purpose/mustShow/locks）比分镜排列更重要 | 2026-03-25 |
| KD-5 | `voice-script` 比 `subtitle-track` 更早冻结 | 字幕是旁白的派生物，voice-script 才是源头 | 2026-03-25 |
| KD-6 | 不自建 timeline editor，先用 Remotion Studio | Remotion v4 的 schema + inputProps + Studio 已够用 | 2026-03-25 |
| KD-7 | prompt 输出必须是 JSON draft/patch，不吐 prose | "AI 说得再漂亮，只要不能落进 spec，它就只是彩带，不是齿轮" | 2026-03-25 |
| KD-8 | 两条生产路径：路径 B（先脚本后素材）Phase 1 主攻，路径 A（先素材后配音）Phase 3 引入 | 路径 B 我们已有全部零件且 showcase 选题已定；路径 A 需要多模态模型，依赖更重 | 2026-04-05 |
| KD-9 | 用实战磨管线，不从纸上设计 schema 开始 | 对标 F144 ppt-forge 成长路径：先手搓 → 沉淀 Skill → 沉淀 schema → gate 化 | 2026-04-05 |
| KD-10 | TTS + forced alignment（不赌原生 timestamps）→ Remotion 自动对齐 | 两份云端调研 + 三猫交叉验证：CosyVoice/Qwen-TTS 均无生产级原生 timestamps | 2026-04-05 |
| KD-11 | 先冻 video-spec + voice-script 两个 schema，其余 Phase 2 补 | 5 个 schema 一起冻容易纸上谈兵，先用实战验证最核心的两个 | 2026-04-05 |
| KD-12 | 全局音频，不段级切碎 TTS | Gemini "致命缺陷" + Siamese"情绪连贯性" — 段级切碎丢失语调/呼吸感/上下文 | 2026-04-05 |
| KD-14 | retiming 拒绝暴力慢放，优先 FREEZE_STYLIZED > B_ROLL > SLOW_MO | Siamese审美判断 + 三猫拍板 | 2026-04-05 |
