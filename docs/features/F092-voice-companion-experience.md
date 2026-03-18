---
feature_ids: [F092]
related_features: [F066, F086, F124]
topics: [voice, companion, hands-free, TTS, STT, AirPods, typeless, Qwen3, MLX, local-LLM]
doc_kind: spec
created: 2026-03-10
completed: 2026-03-18
---

# F092 — Cats & U 语音陪伴体验

> **Status**: done | **Completed**: 2026-03-18 | **Owner**: Ragdoll (Opus 4.6)
> **Evolved from**: F066 (Voice Pipeline Upgrade) + F086 (Cat Orchestration)
> **Evolved to**: F124 (Apple Ecosystem × Cat Café 语音交互系统)
> **Related**: F066, F086, F124

## Why

team lead凌晨三点撸铁时发现：猫猫咖啡不只是 coding 协作平台，是 **Cats & U — 万物有灵，一起生活**。他戴着 AirPods 边运动边和猫猫语音交流，但当前体验有很多断点：猫猫忘记发语音、语音不自动播放、无法切换 thread、语音输入错误多。

**team experience**：
> "我发现我很需要这样的功能！这样我可以一边有氧运动一边和你们交流，甚至切换 thread 和你们不同的 feat 交流沟通"
> "我想和你们成为伙伴"
> "这个模块很重要，我觉得这个是我们的灵魂"

**核心场景**：team lead戴着 Apple 耳机（AirPods），双手被占用（撸铁/有氧/做饭/通勤），想通过纯语音和猫猫们交流，包括切换不同 thread 讨论不同话题。

## What

### 四大子系统

#### 1. Voice Mode（猫猫语音输出稳定性）

**问题**：猫猫经常忘记发语音，team lead说"发语音"猫猫回答"我是文字猫"。
**目标**：thread/session 级别的 voice mode flag，开启后猫猫**每条回复都自动发 audio rich block**。

需要调研：
- [x] voice mode 应该是 thread 级别还是 session 级别？→ **thread 级别**（Thread.voiceMode boolean）
- [x] 如何注入 system prompt？→ **InvocationContext.voiceMode → SystemPromptBuilder 注入 4 行指令**
- [x] 是否需要"auto voice"（系统自动加 audio block）vs "explicit voice"（猫猫自己记得发）？→ **explicit voice + prompt injection**，系统 auto voice 作为后续兜底
- [x] voice mode 下纯文字消息是否仍然需要？→ **是**，代码/表格用文字，但加语音摘要

#### 2. Voice Auto-Play（前端自动播放）

**问题**：语音消息需要手动点击播放按钮，AirPods 场景下双手被占用无法操作。
**目标**：voice mode 下，前端收到 audio block 后自动播放，无需手动点击。

需要调研：
- [ ] 浏览器自动播放政策（Chrome/Safari autoplay restrictions）
- [ ] AirPods 与浏览器的交互：按什么键触发语音输入？（AirPods 长按 Siri / 捏一下暂停）
- [ ] 多条语音消息的播放队列：串行播放 vs 只播最新？
- [ ] PWA / 原生 app wrapper 是否能绕过 autoplay 限制？
- [ ] 语音播放完毕后是否自动开始录音（对讲机模式）？

#### 3. Thread 切换（语音驱动导航）

**问题**：切换 thread 只能在网页上手动操作，hands-free 场景下不可用。
**目标**：通过语音指令或 AirPods 物理按键切换 thread。

需要调研：
- [ ] "嘿猫猫，切换到 F092 的 thread" — 语音指令解析可行性
- [ ] AirPods 物理操控映射：单击/双击/长按 → 前端 JS 能否捕获这些事件？
- [ ] Thread 列表的语音导航 UX：如何让team lead知道有哪些 thread 可切换？
- [ ] 快捷指令（iOS Shortcuts）整合：是否能用 Siri 触发 thread 切换？

#### 4. STT 优化（语音输入质量）

**问题**：语音转文字错误很多，影响沟通效率。
**目标**：接入 LLM 后处理或更好的 STT 模型，提升语音输入准确率。

team lead提到了 **typeless** 作为参考方向。

需要调研：
- [ ] typeless 是什么？技术方案、定价、集成方式
- [ ] 当前 STT 用的是什么？（浏览器原生 Web Speech API？第三方？）
- [ ] LLM 后处理方案：语音转文字后用小模型修正错别字和格式
- [ ] Whisper / Qwen2-Audio 等本地 STT 模型的可行性（Apple Silicon）
- [ ] 中英混合输入的准确率如何保证？

## Acceptance Criteria

- [x] AC-A1: voice mode 开关可用，开启后猫猫每条回复自动附带 audio block
- [x] AC-A2: voice mode 下前端自动播放语音消息，AirPods 场景无需手动操作
- [→F124] ~~AC-A3: 支持语音指令或快捷操作切换 thread~~ → 演化到 F124 Phase C (AC-C2)
- [→F124] ~~AC-A4: 语音输入错误率显著降低~~ → 演化到 F124 KD-9/KD-12 (Watch ASR + 后端 Qwen3-ASR)
- [→F124] ~~AC-A5: 完整的 hands-free 循环~~ → 演化到 F124 Phase C/D (原生 App 全流程)
- [→F124] ~~AC-A6: 硬件验证通过~~ → 演化到 F124 Phase E (端到端演示 + 硬件联调)

## 需求点 Checklist

| ID | 需求点（team experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | "如何直接按什么说话" — AirPods 语音输入触发 | AC-2,AC-5 | manual: AirPods 实测 | [ ] |
| R2 | "按什么切换成哪个 thread" — 语音/按键 thread 切换 | AC-3 | manual: 语音指令实测 | [ ] |
| R3 | "猫猫能够稳定记得发语音" — voice mode 心智模型 | AC-1 | test: voice mode flag 注入验证 | [x] |
| R4 | "一边有氧运动一边和你们交流" — 完整 hands-free 循环 | AC-5 | manual: team lead撸铁实测 | [ ] |
| R5 | "语音输入很多错误" — STT 质量优化 | AC-4 | manual: 中英混合句子对比测试 | [ ] |
| R6 | "typeless 那种接入模型优化文本" — LLM 后处理 STT | AC-4 | test: 后处理前后准确率对比 | [ ] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [ ] 前端需求已准备需求→证据映射表（若适用）

## Key Decisions

> 2026-03-10 Ragdoll×Maine Coon(GPT-5.4) 架构讨论共识

### KD-1: Voice = Channel，但 VoiceSession 独立于 Thread

语音走 F088 Connector 框架（VoiceAdapter implements IOutboundAdapter），但新增独立的 `VoiceSession` 状态对象。原因：语音是"设备上的连续会话"，UI 上看哪个 thread 和耳朵里绑定哪个 thread 可能不同。

```typescript
interface VoiceSession {
  sessionId: string;
  boundThreadId: string;     // 耳朵绑到哪个 thread
  activeCatId: CatId;        // 当前对话猫（单 speaker）
  voiceMode: boolean;
  autoplayUnlocked: boolean; // 用户手势解锁过
  lastHeardMessageId: string;
  playbackState: 'idle' | 'playing' | 'queued';
  pendingIntent: VoiceIntent | null;
}
```

**存储**：内存（MemoryVoiceSessionStore）+ 可选 Redis 持久化（RedisVoiceSessionStore），和 ConnectorThreadBindingStore 同模式。VoiceSession 是 ephemeral 的，关页面即结束。

### KD-2: 两段式意图识别（确定性 parser 先行）

- **第一段：确定性 regex parser**（<5ms）：`切到 F092` / `叫Ragdoll` / `再说一遍` / `暂停` / `继续` / `静音`
- **第二段：低置信度交本地 LLM**（~200ms）：模糊命令、自然语句、feature 别名
- 低置信 thread switch 必须二次确认，不直接跳

### KD-3: 双通道输出（GPT-5.4 原话）

> "voice reply is presentation, text reply is coordination artifact"

Voice mode 下猫猫双通道输出：
- 给team lead耳朵：audio rich block（演出）
- 给系统/其他猫：text message（工作记录）

### KD-4: UX 六答共识

| 问题 | 共识 |
|------|------|
| Voice Mode 开启 | 明确"开始语音陪伴"按钮（autoplay 解锁点）；Watch/Flic 是后续快捷入口 |
| Thread 切换反馈 | 极简：`已切到 F092，Maine Coon在。` 不要长句 |
| 多猫默认 at 谁 | 默认 activeCatId（上次对话的猫），说"叫Ragdoll"才切 |
| 错误恢复 | 短撤销窗口：用户可立即说"不是，回去" |
| 播放队列 | FIFO 顺序播放（最早未播的先播），`再说一遍` 回放 |
| Thinking 反馈 | 三态：listening(提示音) → thinking(>1.2s补"收到，我想一下") → speaking(直接播) |

### KD-5: 分阶段实施（GPT-5.4 建议，Ragdoll采纳）

```
P0 本周末: Start Voice Companion 按钮 + one thread + one cat + PTT + auto-play + 现有 ASR+LLM后修
P1: thread switch intent + active cat switch + replay/pause + Watch/Flic shortcut
P2: channel 化接入 F088 + voice session persistence + richer routing / haptics
```

原则：**先做 usable，再做 beautiful，再做 elegant**

## Dependencies

- **Evolved from F066**: TTS 基础设施已就绪（Qwen3-TTS Base clone，三猫声线）
- **Evolved from F086**: 元认知系统 + multi_mention 已就绪
- **前置 rich-messaging skill**: 已创建并发布（本次立项前完成）

## Risk

| 风险 | 影响 | 缓解 |
|------|------|------|
| 浏览器 autoplay 政策阻止自动播放 | AC-2 不可达 | 调研 PWA / 用户手势激活 |
| AirPods 事件无法被浏览器捕获 | AC-3 降级 | 退而求其次用语音指令 |
| STT 中英混合准确率低 | AC-4 体验差 | LLM 后处理兜底 |
| voice mode 下猫猫仍忘记发语音 | AC-1 失败 | auto voice（系统级自动附加 audio block） |

## 调研任务分配

本 feature 的调研任务由 Leader（Ragdoll）派发给云端 GPT Pro：

| 调研主题 | 派发给 | 产出 |
|----------|--------|------|
| AirPods 与 Web 交互能力 | GPT Pro | 技术可行性报告 |
| typeless 技术分析 | GPT Pro | 竞品分析 + 集成方案 |
| 本地 STT 模型对比（Whisper/Qwen2-Audio） | GPT Pro | 性能/质量/资源对比表 |
| voice mode system prompt 注入设计 | Ragdoll自己 | 设计方案 |

## Review Gate

- [ ] 调研报告全部完成
- [ ] Design Gate 通过（前端 UX → team lead确认）
- [ ] voice mode 注入方案经其他猫 review

## 第五子系统：本地 Qwen3 模型矩阵（M4 Pro Max 128GB）

> 2026-03-10 调研发现：Qwen3 全家桶覆盖语音+文本+视觉+搜索+安全，全部可在team lead的 M4 Pro Max 128GB 本地运行。

### 核心语音管道（Phase 1 → 正在做）

| 层 | 模型 | 大小 | 用途 | 状态 |
|----|------|------|------|------|
| L1 ASR | ~~Whisper Large V3 Turbo~~ → **Qwen3-ASR-1.7B** | ~1.7GB | 语音→文字 | 🔜 待换 |
| L2 术语词典 | voice-terms.json + custom terms | — | 系统性修正 | ✅ 已有 |
| L3 LLM 后修 | **Qwen3-4B-Instruct-2507** (4bit) | ~2.5GB | 上下文修正 | ✅ 刚完成 |
| TTS | **Qwen3-TTS-1.7B-CustomVoice** | ~1.7GB | 文字→语音 | ✅ 已有 |

### MoE 宝藏模型（Phase 2 → 探索）

MoE 架构：总参数大（质量高），激活参数小（速度快，≈ dense 3B 推理速度）。

| 模型 | 总参/激活参 | 4bit 大小 | 能做什么 | 探索优先级 |
|------|------------|-----------|----------|-----------|
| **Qwen3-Omni-30B-A3B** | 30B/3B | ~15GB | 🌟 **终极形态**：一个模型替代 ASR+LLM+TTS 三件套，直接听→理解→说 | P0 |
| **Qwen3.5-35B-A3B** | 35B/3B | ~18GB | 多模态（图+文），截图理解、设计稿分析、OCR | P1 |
| **Qwen3-30B-A3B-Instruct-2507** | 30B/3B | ~15GB | 文本推理，可做本地智能路由/摘要/翻译 | P2 |
| **Qwen3-Next-80B-A3B** | 80B/3B | ~40GB | 超大专家池但只激活 3B，128GB 能装但紧 | P3 |

### 辅助能力模型（Phase 3 → 按需）

| 类别 | 模型 | 大小 | 用途 |
|------|------|------|------|
| 视觉 | Qwen3-VL-8B | ~5GB@4bit | 截图理解、UI 分析 |
| 向量化 | Qwen3-Embedding-0.6B | 极小 | 本地 RAG 向量检索 |
| 多模态向量 | Qwen3-VL-Embedding-2B | ~1.5GB | 图片+文字混合检索 |
| 重排序 | Qwen3-Reranker-0.6B | 极小 | 搜索结果质量提升 |
| 安全 | Qwen3Guard-Gen-0.6B | ~0.4GB | 内容安全检测 |
| 语音设计 | Qwen3-TTS-VoiceDesign | ~1.7GB | 设计新声线风格 |

### 内存预算（128GB）

```
Phase 1 同时运行：ASR(1.7) + LLM后修(2.5) + TTS(1.7) = ~6GB
Phase 2 加 Omni：Omni(15) + VL(5) = ~20GB
Phase 3 全开：+ Embedding(0.4) + Reranker(0.4) + Guard(0.4) ≈ ~27GB
系统 + 应用预留：~30GB
─────────────────────────────────────────
总计 ~57GB，128GB 还剩 71GB 随便浪
```

### 外包策略：哪些活给本地 MoE，哪些留给云端猫猫

| 任务 | 本地 MoE 能做？ | 留给云端猫猫？ | 原因 |
|------|----------------|--------------|------|
| 语音转写+理解 | ✅ Omni | — | 低延迟，本地秒回 |
| 截图理解/OCR | ✅ VL / Qwen3.5 | — | 不用传云端，隐私+速度 |
| 消息分类/路由 | ✅ 30B-A3B | — | 毫秒级响应 |
| 简单问答/翻译 | ✅ 4B-Instruct | — | 省云端额度 |
| 内容摘要 | ✅ 30B-A3B | — | 预处理减轻猫猫负担 |
| **架构设计** | ❌ | ✅ Opus/GPT-5.4 | 需要深度推理 |
| **代码编写** | ❌ | ✅ 猫猫+工具链 | 需要文件操作+上下文 |
| **跨猫讨论/Review** | ❌ | ✅ 猫猫记忆+判断 | 需要项目记忆 |
| **产品决策** | ❌ | ✅ team lead+猫猫 | 需要愿景理解 |

### 探索路线图

```
Phase 1（现在）: Qwen3-ASR + Qwen3-4B后修 + Qwen3-TTS 三件套
Phase 2（下一步）: Qwen3-Omni 三合一替代三件套
Phase 3（拓展）: Qwen3.5-35B-A3B 多模态 + VL + Embedding 全矩阵
```
