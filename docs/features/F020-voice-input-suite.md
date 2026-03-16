---
feature_ids: [F020]
related_features: []
topics: [voice, input, suite]
doc_kind: note
created: 2026-02-26
---

# F020: 语音输入 M1 MVP

> **Status**: done | **Owner**: 三猫
> **Created**: 2026-02-26

## Why
- team lead需求 2026-02-11
- Voice Input design
- Voice Input design + team lead 2026-02-15
- team lead 2026-02-15

## What
- **F20**: 麦克风录音 → 本地 Whisper ASR → 术语纠错 → 填入 textarea → 手动发送。动态按钮 (🎤/▶/⏹/⏳)。Maine Coon 2 轮 review 通过 (P1 安全边界 + P1 启动入口 + P2 stream 泄露)。设计: 2026-02-11-voice-input-design.md，commit 965b569
- **F20b**: 1ec0910 + 23a5c30 — requestData() 轮询 + partialTranscript + streamSeqRef 竞态保护。
- **F20c**: 已独立实现为 relay-station 平级项目（非 cat-cafe 子包）。macOS 全局热键（⌥Space）+ Whisper 转写 + 术语纠正 + 打字到任意 app。
- **F20d**: CatCafeHub "语音设置" tab：可编辑术语纠正表 + initial_prompt 编辑 + 语言选择。内置词典 + localStorage 用户自定义合并。计划: 2026-02-15-voice-accuracy-and-system-whisper.md Phase B
- **F20e**: 语音 ASR 自修正 — 干掉 LLM 后修中间人。前端标记 `isVoiceInput: true`，system prompt 注入提示大模型"这条消息来自语音输入，可能有识别错误，请自行理解原意"。大模型本身有完整上下文（项目术语、猫名、feature 编号），是最好的后修者，零额外延迟零额外成本。LLM 后修服务（`scripts/llm-postprocess-*`）保留但不再用于语音后修。起因：Qwen3.5 35B MoE 无上下文时把"magic word"修不回来，而主模型天然理解。2026-03-13 team lead提出。
- **F20f**: ASR streaming 质量退化修复。**根因**：`useVoiceInput.ts` 的 streaming 逻辑每 3 秒把全部累积 chunks 拼成 blob 重新发给 ASR（Qwen3-ASR），音频越长质量越差（幻觉、乱码、奇怪符号）。Qwen3-ASR 还多一步 ffmpeg 转 WAV，长音频开销更大。**修复方向**：前端改增量发送（只发最近 chunk，不重发历史音频）；加 backpressure（上一次转写没完成不发下一次）。Qwen3-ASR 可调参数有限（仅 `context`），优化主要在前端。2026-03-13 team lead发现录音越长识别越差。

## Acceptance Criteria
- [x] AC-A1: 本文档已补齐模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。

## Key Decisions
- Phase B

## Dependencies
- **Related**: 无
- 无显式依赖声明

## Risk
| 风险 | 缓解 |
|------|------|
| 历史文档口径与当前实现可能漂移 | 在 F094 批次里持续复跑审计脚本并按批次回填 |
