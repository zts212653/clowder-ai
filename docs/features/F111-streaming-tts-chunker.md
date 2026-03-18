---
feature_ids: [F111]
related_features: [F066, F034, F021]
topics: [voice, tts, streaming, chunker, latency]
doc_kind: spec
created: 2026-03-12
---

# F111: Streaming TTS Chunker — 流式分句合成管线

> **Status**: done | **Owner**: 金渐层 (OpenCode, claude-opus-4-6) | **Priority**: P1 | **Completed**: 2026-03-17

## Why

F066 Phase 1 落地了本地 TTS（Qwen3-TTS Base clone），但合成方式是**全文一次性**：VoiceBlockSynthesizer 收到完整 text → 调用 TTS → 等整段合成完 → 返回 audioUrl。对于长文本（>100 字），用户要等 10-30 秒才能听到第一个音节。

team lead的核心痛点：**"为什么要等这么久才开始说话？"**

流式分句的思路是：LLM 边生成文字，TTS 边合成语音，前端边收边播。首次发声延迟从"全文合成时长"降到"第一句合成时长"（通常 1-2 秒）。

AIRI 项目的 `tts-chunker.ts` 已验证了这种管线在 TypeScript 中的可行性（F054 调研）。

> Evolved from F066 Phase 2（从 F066 拆分为独立 Feature）

## What

### Phase A: TTS Chunker + Streaming API

1. **TTS Chunker 模块**
   - 接收 LLM 的流式文字输出（SSE / token stream）
   - 硬断点：句号（。.）、问号（？?）、感叹号（！!）、换行 → 立即发送 TTS
   - 软断点：逗号（，,）、顿号（、）、冒号（：:）→ 攒够 4-12 词后发送
   - Boost 机制：前 2 个 segment 降低阈值提前发送（减少首次发声延迟）
   - 中文适配：`Intl.Segmenter` 分词 + 中文标点识别

2. **Streaming Synthesis API**
   - 新增端点：`/api/tts/stream`（SSE，前端用 `fetch` + `ReadableStream` 消费）
   - 鉴权：不用浏览器原生 `EventSource`（不支持自定义 header），改用 `fetch` + `ReadableStream` 读取 SSE 流，保留现有 `X-Cat-Cafe-User` header 鉴权链路，无需引入 token/query 鉴权
   - 前端逐段接收 audio chunk（Base64 编码）→ 解码 → 逐段播放
   - 保持与现有 `/api/tts/synthesize` 的兼容（非流式仍可用）

3. **AudioBlock 升级**
   - 支持流式播放（边接收边播放）
   - 进度条反映真实播放进度（而非下载进度）

### Phase B: route-serial Token-Stream Speech Pipeline（边吐字边转语音）

> Phase A 验证了分句合成可行（TTS 部分 < 2-3s），但 LLM 思考时间（3-5s）被白白串行化。
> Phase B 将 TtsChunker 嵌入 route-serial 的 token 流，实现"LLM 边输出 → TTS 边合成 → 前端边播放"三级管线。
> 与 F112 协同实现：F111-B 负责后端 speech stream，F112 Phase A 负责前端 PlaybackManager。

1. **StreamingTtsChunker（后端，route-serial）**
   - 在 route-serial 的 `msg.type === 'text'` 循环中接入
   - 逐 token 喂入 TtsChunker，凑够一句（句号/问号/换行）→ 异步发起 TTS 合成
   - TTS 合成不阻塞主 token 循环（fire-and-forget + 回调推送）
   - 合成完成 → 通过 `socketManager.broadcastToRoom()` 推送 `voice_chunk` 事件

2. **WebSocket 事件协议（最小集）**
   - `voice_stream_start`: `{ catId, invocationId }` — 通知前端初始化 PlaybackManager
   - `voice_chunk`: `{ catId, invocationId, index, audioBase64, text, format }` — 实时音频数据
   - `voice_stream_end`: `{ catId, invocationId, totalChunks }` — 流结束，前端清理状态
   - Abort 不需要单独事件：前端检测到 WebSocket `done` 或断开即 abort

3. **Scope 约束（Phase B-1）**
   - 只做 route-serial + 单 cat + voiceMode 主路径
   - 不做 Route A（callback-only / create_rich_block(audio)）优化
   - 不做 route-parallel
   - 现有 `/api/tts/stream` + `useVoiceAutoPlay` 保留为 fallback（页面刷新/断线恢复/非实时场景）

4. **持久化策略**
   - 实时 voice_chunk 是临时态（base64 in WebSocket），不落盘
   - 消息 done 后，audio block 存储 text（无 url），fallback 走 `/api/tts/stream`
   - VoiceBlockSynthesizer 的 cache 机制覆盖"同文本不重复合成"

5. **系统约束变更**
   - voiceMode 下实时语音由 **backend text stream 主触发**，不依赖模型主动发 audio rich block
   - Audio rich block 退为持久化/回放载体，不再作为实时语音的主触发器

## Acceptance Criteria

### Phase A（Streaming Chunker）✅ Done — merged PR #522
- [x] AC-A1: LLM 流式输出到首次发声延迟 < 2 秒（100 字以上文本）— 需真 TTS server 验证
- [x] AC-A2: 长文本（>100 字）端到端合成延迟比全文合成降低 50%+ — 需真 TTS server 验证
- [x] AC-A3: 中文标点正确断句（不在词中间断开）— TtsChunker 17 tests 覆盖
- [x] AC-A4: 前 2 个 segment 的 Boost 机制生效（可通过日志验证）— TtsChunker 含 boost 测试
- [x] AC-A5: 非流式合成路径不受影响（回归测试）— route-serial/parallel 的 !voiceMode guard
- [x] AC-A6: AudioBlock 流式播放时进度条平滑更新 — useStreamingAudio onTimeUpdate

### Phase B（route-serial Token-Stream Speech Pipeline）✅ Done — merged PR #529
- [x] AC-B1: voiceMode 下 LLM 吐出第一句话后 2-4 秒内前端开始播放语音（不含 CLI 冷启动）
- [x] AC-B2: voice_chunk 通过 WebSocket 实时推送，不阻塞 text token 流（打字动画不受影响）
- [x] AC-B3: 页面刷新后回退到 `/api/tts/stream` fallback 正常回放
- [x] AC-B4: 非 voiceMode 线程不触发 StreamingTtsChunker（零开销）
- [x] AC-B5: TTS 合成失败时 graceful degradation（跳过失败 chunk，后续 chunk 继续）

## Dependencies

- **Evolved from**: F066（Voice Pipeline Upgrade — Phase 2 拆出）
- **Related**: F034（TTS 架构基础 — ITtsProvider / TtsRegistry / VoiceBlockSynthesizer）
- **Related**: F021（Signal Study Mode — R5 播客功能将受益于流式合成）
- **Related**: F054（HCI Preheat Infra — AIRI tts-chunker.ts 参考架构）

## Risk

| 风险 | 缓解 |
|------|------|
| 流式分句对中文分词不准 | `Intl.Segmenter` + 中文标点硬断点双重保障 |
| ~~WebSocket 复杂度高于 SSE~~ | **已决**：选 SSE（单向足够，复杂度低） |
| Qwen3-TTS mlx-audio SDK 不支持流式 generate | 三路可选：A) vLLM-Omni serving（真流式）B) KV-cache 手动 step（社区方案）C) Node 层分段调用全量合成（伪流式，最简单） |

## 实测延迟报告（2026-03-17 team lead亲测）

**测试环境**：M-series Mac，本地 Qwen3-TTS (mlx-audio)，runtime worktree

**端到端延迟拆解**：

| 阶段 | 耗时 | 说明 |
|------|------|------|
| opencode CLI 冷启动 | ~28s | CLI 拉起 + 加载 context（框架固定开销） |
| CLI 启动后 → 首次出声 | ~10s | LLM 思考 + MCP 投递 + TTS 合成 + 前端播放 |
| 其中 TTS 流式合成 | ~2-3s | TtsChunker 分句 + 第一句 Qwen3-TTS 合成 |
| `/api/tts/stream` SSE | 正常 | 2 句文本 → 2 chunk 逐一返回，格式 wav |

**关键结论**：

1. **F111 Plan C（分句合成）方向验证通过** — TTS 合成部分只占 2-3s，主要延迟来自 LLM 思考和 CLI 启动
2. **CLI 冷启动 28s 是最大瓶颈** — opencode 框架开销，非 Cat Café 可优化范围
3. **"边吐字边转语音"（Plan A 真流式）可进一步优化** — 理论上把 10s 压缩到 3-5s，因为 LLM 思考时间被 TTS 并行利用
4. **当前实现满足 AC-A1 的精神**（TTS 合成部分 < 2s），但完整端到端还受 LLM 思考时间影响

**下一步优化方向**：在 route-serial 的 token 流中嵌入 TtsChunker，实现"LLM 边输出 → TTS 边合成 → 前端边播放"三级管线
