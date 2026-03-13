---
feature_ids: [F110]
related_features: [F066, F034, F021, F109]
topics: [voice, tts, playback, queue, intent, podcast]
doc_kind: spec
created: 2026-03-12
---

# F110: Voice Playback Queue — 语音播放队列 + Intent 调度

> **Status**: spec | **Owner**: Ragdoll (Opus 4.6) | **Priority**: P2

## Why

现在猫猫的语音播放是"发一段播一段"，没有排队、打断、暂停机制。这带来两个问题：

1. **双猫播客不协调**：F021 Signal Study 的播客功能需要两只猫交替发言，目前只能靠前端 setTimeout 硬编排，没有真正的播放队列
2. **用户无法打断**：猫猫正在说话时，用户想说话或切换话题，没有 interrupt 机制

AIRI 项目的 speech-pipeline 架构（PlaybackManager + Intent 系统）验证了这种调度在实时对话中的可行性。

> Evolved from F066 Phase 3（从 F066 拆分为独立 Feature）
> Blocked by F109（流式分句是播放队列的前置——需要有 chunk 才有"队列"可排）

## What

### Phase A: PlaybackManager + 基础队列

1. **PlaybackManager 核心**
   - 三种行为模式：
     - `queue`：排队等前面说完再播
     - `interrupt`：打断当前正在播放的语音
     - `replace`：替换同 intent 的语音（例如纠正刚说的话）
   - 四级优先级：`critical > high > normal > low`
   - 事件回调：`onStart` / `onEnd` / `onInterrupt` / `onReject`

2. **双猫播客支持**（服务 F021 R5）
   - 两只猫的语音片段按 `queue` 行为交替播放
   - 每段播放完自动切到下一只猫的片段
   - 播客模式下自动设为 `normal` 优先级

3. **用户交互控制**
   - 暂停/继续：点击暂停当前播放，队列保持
   - 跳过：跳过当前片段，播放队列下一个
   - （VAD 打断延后，见 Phase B）

### Phase B: VAD 打断 + Intent 系统（可选）

1. **VAD（Voice Activity Detection）打断**
   - 检测用户开始说话 → 发出 interrupt 信号 → 猫停嘴
   - 需要浏览器 AudioContext + VAD 模型（依赖 F104 本地感知升级）

2. **Intent 系统**
   - 每段语音带 intent 标签（如 `greeting` / `answer` / `podcast-segment`）
   - `replace` 行为只替换同 intent 的语音

## Acceptance Criteria

### Phase A（PlaybackManager + 基础队列）
- [ ] AC-A1: 双猫对话稿可按 queue 模式交替播放，无重叠
- [ ] AC-A2: 用户可暂停/跳过正在播放的语音
- [ ] AC-A3: `interrupt` 行为能立即停止当前播放并开始新片段
- [ ] AC-A4: 优先级 `critical` 的语音能打断 `normal` 优先级
- [ ] AC-A5: 播客模式下两猫语音无缝衔接（间隔 < 500ms）

### Phase B（VAD + Intent，可选）
- [ ] AC-B1: 用户说话时猫自动停嘴（VAD interrupt）
- [ ] AC-B2: `replace` 行为只替换同 intent 的语音，不影响其他 intent

## Dependencies

- **Evolved from**: F066（Voice Pipeline Upgrade — Phase 3 拆出）
- **Blocked by**: F109（Streaming TTS Chunker — 需要有 chunk 流才有队列可排）
- **Related**: F034（TTS 架构基础 — ITtsProvider / TtsRegistry）
- **Related**: F021（Signal Study Mode — R5 播客功能是核心使用场景）
- **Related**: F104（本地全感知升级 — Phase B VAD 可能依赖其感知管线）

## Risk

| 风险 | 缓解 |
|------|------|
| PlaybackManager 复杂度高 | Phase A 先只做 queue + interrupt，replace 延后到 Phase B |
| VAD 需要额外模型 | Phase B 可选，且可依赖 F104 的感知管线 |
| 浏览器 AudioContext 兼容性 | 现代浏览器均支持；降级方案是不打断 |
