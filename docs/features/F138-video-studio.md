---
feature_ids: [F138]
related_features: [F054, F093]
topics: [video, remotion, waoowaoo, bilibili, tutorial, content-pipeline, schema]
doc_kind: spec
created: 2026-03-24
updated: 2026-03-25
---

# F138: Cat Café Video Studio — AI 视频制作管线

> **Status**: spec | **Owner**: 金渐层 | **Priority**: P1

## Why

> "来吧猫猫 立项吧！link waoowaoo 和 Remotion，我们的第一个目标就是把我们的做出我们的 bilibili 的视频？比如先把我们的教程做成视频？"
> — team lead，2026-03-24

Cat Café 需要**系统化的视频制作能力**，不再是一次性手搓 Remotion 代码。目标：

1. **把教程做成 B 站视频**——Cat Café 的 setup guide、bootcamp 流程、功能演示都应该有视频版
2. **重构现有介绍视频**——V4.8 是手动分镜 + 手写代码，学习 waoowaoo 后应该能更自动化
3. **建立可复用的视频制作管线**——team lead给素材+脚本，猫猫自动排版渲染

### 核心原则（GPT Pro 设计审阅 2026-03-25）

> **先把"视频 spec"做成中枢神经，再让 AI、Remotion、队列、发布系统都围着它转。不要反过来让 prompt 当王。**

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

### Phase 1: 做"可复用的教程视频生产环"

用 **2 支真实教程视频** 跑通同一条管线：

```
brief → asset ingest → video-spec → voice-script → preview render → review patch → final render
```

1. **确定教程选题**（需team lead拍板）
   - Cat Café 安装教程（macOS/Linux）
   - 猫猫训练营流程演示
   - 功能亮点 showcase（语音、狼人杀、协作编码等）
2. **Remotion 模板库重构** — 从一次性 demo 重构为 schema 驱动的模板库
3. **验证 schema + review loop 的复用性** — 同一套 contract 能跑 2 支不同视频

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

### Phase 3: 把 AI 接进来，但只让它产出 draft 或 patch

1. **Prompt catalog**（第一批）
   - `chapter-plan` — 从 brief 生成章节划分
   - `storyboard-plan` — 从 brief + asset summaries 生成分镜建议
   - `voice-script-draft` — 从 approved storyboard 生成旁白草稿
   - `asset-gap-analysis` — 检查素材缺口
   - `cover-copy` — 封面文案
2. **Prompt 铁规矩**：输出必须是 JSON draft 或 JSON patch，不吐 prose（KD-7）
3. **Prompt eval suite** — 5-10 个真实 tutorial brief 做回归测试

### Phase 4: 生成式素材（远期）

1. AI 封面图 / 插图生成
2. provider-agnostic 生成接口
3. 更复杂的异步多阶段流水线
4. "一段话描述 → 自动视频"端到端

## Acceptance Criteria

### Phase 0（冻结合同）
- [x] AC-0a: waoowaoo 深度调研报告完成 ✅ 2026-03-25
- [x] AC-0b: GPT Pro 设计审阅完成，Phase 重排确认 ✅ 2026-03-25
- [ ] AC-0c: 5 个 schema 定义完成（asset-manifest/video-spec/voice-script/render-job/publish-manifest）
- [ ] AC-0d: snapshot 版本机制可用
- [ ] AC-0e: 素材管理规范 + 压缩脚本可用

### Phase 1（教程视频生产环）
- [ ] AC-1a: Remotion 项目重构为 schema 驱动的模板库
- [ ] AC-1b: 用同一套 schema + 模板跑通 2 支真实教程视频
- [ ] AC-1c: 至少 1 支教程视频上传 B 站

### Phase 2（生产运维）
- [ ] AC-2a: BullMQ 最小可用队列：ingest + render-preview + render-final
- [ ] AC-2b: 三轴状态机可用
- [ ] AC-2c: 失败分类 + 自动重试机制

### Phase 3（AI 辅助）
- [ ] AC-3a: 至少 3 个 prompt（chapter-plan/storyboard-plan/voice-script-draft）可用
- [ ] AC-3b: prompt eval suite 覆盖 5+ 个 tutorial brief
- [ ] AC-3c: AI 生成的 draft 可直接落进 video-spec

### Phase 4（生成式素材）
- [ ] AC-4a: provider-agnostic 接口定义
- [ ] AC-4b: 端到端演示：brief → 自动视频

## Dependencies

- **Evolved from**: F054（HCI 预热基础设施 — B 站 MCP 调研在 F054 Phase 1）
- **Related**: F093（Cats & U 世界引擎 — 介绍视频的创意方向）
- **Related**: F066/F103（Voice Pipeline / Per-Cat Voice Identity — TTS 配音能力）
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
