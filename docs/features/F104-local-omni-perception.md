---
feature_ids: [F104]
related_features: [F066, F092, F103]
topics: [local-inference, mlx, qwen, omni-modal, perception]
doc_kind: spec
created: 2026-03-11
---

# F104: 本地全感知升级 — Qwen Omni + VL MoE 替换管道

> **Status**: spec | **Owner**: Ragdoll | **Priority**: P1

## Why

当前猫猫的感知管道由三个独立小模型串行组成（ASR 1.7B + LLM后修 4B + TTS 1.7B），总延迟高、能力有限、且猫猫完全没有视觉理解能力。operator的 128GB M4 Max 有充足算力跑 MoE 30B 级模型（3B 激活），升级后猫猫从"只会读写的文字 AI"变成"能听能看能说的全感知伙伴"。

operator experience："我们能做什么！？他们能帮你们干嘛？"

## What

### Phase A: Omni 听说一体化 — 替换 ASR + LLM后修 + TTS

用 **Qwen3-Omni-30B-A3B**（MoE，3B 激活，~18GB@4bit）替换现有三模型管道：

- **现状**：语音输入 → Qwen3-ASR-1.7B(9876) → Qwen3-4B-Instruct 后修(9878) → 文本 → 猫处理 → Qwen3-TTS-1.7B(9879) → 语音输出
- **目标**：语音输入 → Qwen3-Omni（听+理解+说）→ 语音/文本输出

关键工作：
1. 调研 Qwen3-Omni 的 MLX 适配情况（mlx-community 是否有量化版）
2. 搭建 Omni serving（MLX/vLLM/本地推理）
3. 实现 OmniAudioProvider（替换 MlxAudioTtsProvider + ASR + LLM后修）
4. 保持 clone voice 能力（三猫声线不能丢，关联 F103）
5. 回退机制：Omni 不可用时 fallback 到现有三模型管道

### Phase B: VL 视觉理解 — 猫猫获得"眼睛"

用 **Qwen3.5-35B-A3B**（MoE 多模态，3B 激活，~18GB@4bit）为猫猫增加视觉理解能力：

1. 搭建 VL serving（MLX 量化版）
2. 实现 LocalVisionProvider（图片理解 API）
3. 接入场景：截图理解、设计稿审查、UI 渲染验证
4. 与猫猫工作流集成（quality-gate 可调用视觉检查）

### Phase C: 感知层架构统一（如需要）

将 Omni + VL 统一为 Perception Layer API，供所有猫猫调用：
- 统一的 `/perceive` 端点（自动路由到听/看/说）
- 与 /loop 结合实现主动感知（定时扫描环境）

## Acceptance Criteria

### Phase A（Omni 听说一体化）
- [ ] AC-A1: Qwen3-Omni-30B-A3B 在 M4 Max 128GB 上成功运行推理
- [ ] AC-A2: 语音输入 → Omni → 文本输出，延迟 < 现有 ASR+LLM后修总延迟
- [ ] AC-A3: 文本 → Omni → 语音输出，三猫声线可区分（不退化于现有 TTS 效果）
- [ ] AC-A4: 现有三模型管道保留为 fallback，可通过环境变量切换
- [ ] AC-A5: 现有语音功能（F066/F092）全部正常工作

### Phase B（VL 视觉理解）
- [ ] AC-B1: Qwen3.5-35B-A3B 在 M4 Max 128GB 上成功运行推理
- [ ] AC-B2: 猫猫可以理解截图内容并用文字描述
- [ ] AC-B3: 至少一个工作流场景集成（如 quality-gate 视觉检查）

## 需求点 Checklist

| ID | 需求点（operator experience） | AC # | 验证方式 | 状态 |
|----|---------------------|------|----------|------|
| R1 | 升级成 Omni 和 3.5-35B | AC-A1, AC-B1 | 本地推理成功 | [ ] |
| R2 | 替换掉现在的 ASR 和 TTS | AC-A2, AC-A3, AC-A5 | 端到端语音对话测试 | [ ] |
| R3 | 猫猫能听能看能说 | AC-A2, AC-A3, AC-B2 | 多模态交互演示 | [ ] |

## Dependencies

- **Evolved from**: F066（语音管道升级，Omni 是下一代）
- **Related**: F103（Per-Cat Voice Identity，Omni 需保持声线区分）
- **Related**: F092（Voice Companion，受益于 Omni 低延迟）

## Risk

| 风险 | 缓解 |
|------|------|
| Qwen3-Omni MLX 适配不成熟 | Phase A 先调研，不成熟则用 vLLM/llama.cpp 等替代方案 |
| Omni 不支持 voice clone | 保留 TTS 管道作为语音合成 fallback，Omni 只替换 ASR+理解 |
| 两个 30B MoE 同时跑显存不足 | MoE 3B 激活，理论 ~36GB@4bit，128GB 绰绰有余；实测确认 |
| 现有功能回退 | AC-A4 强制 fallback 机制，切换无需改代码 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 优先 Phase A（Omni），再 Phase B（VL） | Omni 替换三模型管道收益最大，且operator日常语音交互最频繁 | 2026-03-11 |
| KD-2 | 保留现有管道作为 fallback | 新模型适配有风险，不能断掉已有能力 | 2026-03-11 |

## Review Gate

- Phase A: 跨家族 review（优先 @codex/@gpt52）
- Phase B: 跨家族 review + Siamese视觉验证
