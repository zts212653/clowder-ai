---
feature_ids: [F066]
related_features: [F034, F021, F054]
topics: [voice, tts, audio, pipeline, streaming, mlx-audio, kokoro]
doc_kind: spec
created: 2026-03-05
---

# F066: Voice Pipeline Upgrade — 本地 TTS + 流式合成 + 播放队列

> **Status**: done | **Owner**: Ragdoll (Opus 4.6)
> **Created**: 2026-03-05 | **Completed**: 2026-03-12
> **Phase 1 Closed**: 2026-03-09 — 本地 TTS 语音基础设施落地完成（Qwen3-TTS Base clone + E 型统一方案）
> **Phase 4 Closed**: 2026-03-11 — TTS 韧性增强合入（PR #356, Maine Coon R2 + 云端 Codex 双关放行）
> **AC-10 补漏**: 2026-03-12 — PR #414 补齐 resynthesize 按钮（GPT-5.4 愿景守护发现遗漏）
> **未来方向**: 流式分句（Phase 2）+ 播放队列（Phase 3）拆分为独立 Feature

## Why

F034 建立了完整的 TTS 架构（ITtsProvider + TtsRegistry + VoiceBlockSynthesizer + 微信风格语音条），但底层用的是 **edge-tts**（微软云端 API）——这是一个"先跑通链路"的简陋方案，有三个硬伤：

1. **依赖云端**：edge-tts 走微软服务器，延迟不可控、离线不可用、有被限流风险
2. **全文合成**：VoiceBlockSynthesizer 等整段 text 合成完才返回 audioUrl，长文本延迟高
3. **无播放调度**：没有优先级/排队/打断机制，无法支撑双猫交替对话（F021++ 播客）

**核心判断**：Provider 架构已就绪（F034 遗产），升级是"换引擎"不是"造车"。

## What

### Phase 1: 本地 TTS — edge-tts → Qwen3-TTS Base clone（P0）✅ Done

替换 TTS 后端，从云端迁移到 Apple Silicon 本地推理。最终方案：Qwen3-TTS 1.7B Base clone + 原神角色参考音频（E 型统一方案）：

1. **Python TTS 服务 Adapter 化重构**
   - `scripts/tts-api.py` 引入 `TtsAdapter` 抽象：`synthesize(text, voice, model, speed) → bytes`
   - 两个实现：`MlxAudioAdapter`（默认）+ `EdgeTtsAdapter`（fallback / 未来可选）
   - 通过 env var `TTS_PROVIDER=mlx-audio|edge-tts` 切换（默认 mlx-audio）
   - 未来加 CosyVoice3 / Spark-TTS 只需新增一个 Adapter 子类
   - 接口不变：`POST /v1/audio/speech`（OpenAI 兼容），Node API 零改动

2. **MLX-Audio 依赖 + 模型**
   - 模型：`mlx-community/Kokoro-82M-bf16`（82M 轻量，MLX 原生）
   - 依赖：`mlx-audio` + `misaki[zh]`（中文 phonemizer）
   - 启动时 warmup 调用预加载模型（与现有 Whisper 服务一致）

3. **声线试听脚本 + 声线选择**
   - 新建 `scripts/tts-voice-audition.py`：传 voice name + 中文文本 → 生成 wav
   - operator试听所有 `zm_*` 声线，为每只猫选定声线
   - 三只猫的声线期望描述（供operator参考）：
     - **Ragdoll** (Ragdoll)：偏低沉温暖，语速略慢 (0.95)，"安静讲故事"
     - **Maine Coon** (Maine Coon)：清朗干脆，语速标准 (1.0)，"认真审稿的编辑"
     - **Siamese** (Siamese)：明快年轻，语速略快 (1.05)，"灵感停不下来的设计师"

4. **cat-voices.ts 声线更新**
   - operator试听拍板后，更新 Kokoro voice name
   - edge-tts voice name 保留为注释（回退参考）

**不做**：不改 Node API 层、不改前端、不改 VoiceBlockSynthesizer——纯后端替换。

### Phase 2: 流式分句管线（P1）

LLM 边生成文字，TTS 边合成语音，减少首次发声延迟：

1. **TTS Chunker**（参考 AIRI `tts-chunker.ts`）
   - 硬断点：句号、问号、感叹号、换行 → 立即发送 TTS
   - 软断点：逗号、顿号、冒号 → 攒够 4-12 词后发送
   - Boost 机制：前 2 个 segment 提前发送（减少首次发声延迟）
   - 中文适配：`Intl.Segmenter` 分词 + 中文标点识别

2. **Streaming Synthesis API**
   - 新增 WebSocket 端点或 SSE 端点：`/api/tts/stream`
   - 前端逐段接收 audio chunk → 逐段播放

3. **AudioBlock 升级**
   - 支持流式播放（边接收边播放）
   - 进度条反映真实播放进度

### Phase 3: 播放队列 + Intent 系统（P2）

支持多段语音的调度和交互控制：

1. **PlaybackManager**（参考 AIRI speech-pipeline）
   - 三种行为：`queue`（排队等前面说完）/ `interrupt`（打断当前）/ `replace`（替换同 intent）
   - 四级优先级：`critical > high > normal > low`
   - 事件回调：onStart / onEnd / onInterrupt / onReject

2. **双猫播客支持**（服务 F021++ R5）
   - 两只猫的语音片段按 queue 行为交替播放
   - 每段播放完自动切到下一只猫

3. **用户交互**
   - 用户说话时猫停嘴（interrupt，需 VAD 信号）
   - 播放暂停/跳过控制

### Phase 4: TTS 合成韧性增强 — Resilience Enhancement（P1）

TTS 服务可能因瞬时不可用（OOM / 模型重载 / 请求竞争）导致合成失败。Phase 1 的 graceful degradation（🔇 warning card）保底有效但体验差。三项增强：

1. **后端重试（Retry with Backoff）**
   - `VoiceBlockSynthesizer.synthesize()` 合成失败后自动重试 1 次（间隔 2s）
   - 仅对可重试错误重试：`ECONNREFUSED` / `ETIMEDOUT` / HTTP 5xx
   - 不重试：4xx（参数错误）/ 文本为空等确定性错误
   - 日志标记 `[TTS-RETRY]` 便于排查

2. **前端重试按钮**
   - 🔇 warning card 新增 "重新合成" 按钮（action button）
   - 点击后调用 `/api/tts/resynthesize` 端点，传入原始 text + voiceConfig
   - 成功后替换 card 为正常 audio block

3. **具体错误信息**
   - 🔇 card 的 bodyMarkdown 追加错误分类：`连接被拒绝` / `合成超时` / `服务错误(500)` / `未知错误`
   - 帮助operator/用户快速判断是否需要手动干预（重启 TTS 服务 vs 等待 vs 检查配置）

## Acceptance Criteria

- [x] AC-A1: 本文档需在本轮迁移后维持模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。
- [x] AC-1: TTS 合成完全在本地 Apple Silicon 完成，不依赖外部云服务 ✅ Qwen3-TTS 1.7B Base clone via mlx-audio
- [x] AC-2: 现有语音消息功能（F034）不受影响——微信风格语音条、缓存、降级全部正常 ✅ PR #333 回归测试通过
- [x] AC-3: 中文合成质量主观评估不低于 edge-tts（operator试听确认）✅ operator："牛逼！是我要的了！"
- [x] AC-8: (Phase 4) TTS 瞬时失败（ECONNREFUSED/timeout/5xx）自动重试 1 次，无需用户干预 ✅ PR #356
- [x] AC-9: (Phase 4) 🔇 warning card 显示具体错误分类（连接拒绝/超时/服务错误） ✅ PR #356
- [x] AC-10: (Phase 4) 🔇 warning card 提供"重新合成"按钮，点击后可重新触发 TTS 合成 ✅ AC-10 补齐（PR #356 遗漏 → 本 PR 补齐）
- [ ] AC-4: (Phase 2) LLM 流式输出到首次发声延迟 < 2 秒 → 拆分至未来 Feature
- [ ] AC-5: (Phase 2) 长文本（>100 字）合成延迟比全文合成降低 50%+ → 拆分至未来 Feature
- [ ] AC-6: (Phase 3) 双猫对话稿可按 queue 模式交替播放 → 拆分至未来 Feature
- [ ] AC-7: (Phase 3) 用户可暂停/跳过正在播放的语音 → 拆分至未来 Feature

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | 简陋方案升级——从 edge-tts 换成本地 TTS | AC-1, AC-2 | test: mlx-audio 本地合成 + F034 回归测试 | [x] |
| R2 | 中文声音质量不能倒退 | AC-3 | manual: operator试听对比 | [x] |
| R3 | F021++ 播客需要流式合成（AIRI 调研启发） | AC-4, AC-5 | test: 首次发声延迟测量 | [ ] 拆分 |
| R4 | 双猫交替对话播放（AIRI Intent 系统启发） | AC-6 | test: queue 行为验证 | [ ] 拆分 |
| R5 | 用户可控制播放 | AC-7 | manual: 暂停/跳过操作 | [ ] 拆分 |
| R6 | TTS 合成失败自动重试 1 次（瞬时故障容错） | AC-8 | test: mock ECONNREFUSED → 验证重试 + 成功 | [x] |
| R7 | 🔇 card 显示具体错误信息（连接拒绝/超时/500） | AC-9 | test: 各类错误 → 验证 card 文案 | [x] |
| R8 | 🔇 card 提供"重新合成"按钮 | AC-10 | test: degraded card actions + resynthesize() method（32/32 pass） | [x] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [ ] 前端需求已准备需求→证据映射表（若适用）— Phase 2/3 有前端改动时补充

## Key Decisions

| 决策 | 选项 | 结论 | 决策者 |
|------|------|------|--------|
| Phase 1 首发模型 | Kokoro-82M / Qwen3-TTS / CosyVoice3 | **Qwen3-TTS 1.7B Base clone**（Kokoro 质量不可接受→Qwen3 VoiceDesign 不稳定→GPT-SoVITS 英文弱→Base clone + ref_audio 锚定声线最终胜出） | operator (2026-03-09) |
| 升级路径 | 一步到位 / 渐进 | **渐进**：Qwen3 1.7B → 补 stream_synthesize + chunker → CosyVoice3(可选上限) | Ragdoll+GPT-5.4 |
| Python TTS 替换策略 | 写死替换 / Adapter 模式 | **Adapter 模式**：`TtsAdapter` 抽象 + env var 切换 provider | operator (2026-03-05) |
| 声线选择流程 | 猫猫自选 / operator选 | **猫猫出期望描述 → operator试听拍板**（猫听不到声音） | operator (2026-03-05) |
| Phase 2 流式协议 | WebSocket / SSE | **待定**（Phase 2 plan 时决策） | — |
| Feature 归属 | 并入 F054 / 并入 F034 / 独立 | **独立 F066**（范围自成体系，F034 已 done） | operator (2026-03-05) |
| Ragdoll声线方案 | Qwen3 VoiceDesign / GPT-SoVITS / Qwen3 Base clone | **Qwen3-TTS Base clone + 流浪者 v2 ref audio** — clone 模式 + instruct 叠加解决一切 | operator (2026-03-09) |
| Maine Coon声线方案 | Qwen3 VoiceDesign / GPT-SoVITS / Qwen3 Base clone | **Qwen3-TTS Base clone + 魈 v2 ref audio** — 统一引擎 | operator (2026-03-09) |
| Siamese声线方案 | Qwen3 VoiceDesign / GPT-SoVITS / Qwen3 Base clone | **Qwen3-TTS Base clone + 班尼特 v1 ref audio** — 统一引擎 | operator (2026-03-09) |
| 声线方案架构 | D 型混合(Qwen3+GPT-SoVITS) / E 型统一(Qwen3 Base clone) | **E 型统一方案** — 三猫都走 Qwen3 Base clone，GPT-SoVITS 降为离线工具 | operator (2026-03-09) |
| GPT-SoVITS 版本 | v2 / v3 / v4 | **v2Pro / v2ProPlus** — 社区训练集参差，v2 更宽容 | GPT Pro 调研 (2026-03-09) |

## Dependencies

- **Evolved from**: F034 Voice Block（ITtsProvider + TtsRegistry + VoiceBlockSynthesizer + AudioBlock）
- **Related**: F021++ Study Mode R5 播客（下游消费者）
- **Related**: F054 Phase 3 性格档案（声线选择输入）
- **Requires**: Apple Silicon Mac（MLX 原生推理）
- **Requires**: mlx-audio + misaki[zh] Python 依赖

## Risk

| 风险 | 影响 | 缓解 |
|------|------|------|
| Kokoro-82M 中文质量不如 edge-tts | 用户体验倒退 | Phase 1 做 A/B 对比试听；不满意可快速切 Spark-TTS |
| mlx-audio 在特定 macOS 版本有兼容问题 | 服务无法启动 | scripts/services/tts-server.sh 做依赖检查 + fallback 到 edge-tts |
| 流式分句对中文分词不准 | 断句不自然 | 用 Intl.Segmenter + 中文标点硬断点双重保障 |
| Phase 3 播放队列复杂度高 | 开发周期长 | 先只做 queue 行为，interrupt/replace 延后 |

## Review Gate

- **Self-check**: `quality-gate`
- **Reviewer**: 跨 family（Maine Coon优先，关注 Provider 接口兼容性）
- **Cloud review**: 合入前必须

## Voice Audition Progress (2026-03-09)

### 模型升级决策
- **Kokoro-82M**: 质量不可接受（"五年前机器朗读水平"）→ 淘汰
- **Qwen3-TTS 1.7B VoiceDesign**: 9 轮抽卡不稳定 → 降为备选
- **GPT-SoVITS v2Pro**: R1-R3 试听，英文处理极弱 → 降为离线声库工具
- **Qwen3-TTS 1.7B Base clone**: 🏆 最终胜出！`ref_audio` + `instruct` 双层控制

### E 型统一方案（最终决策）🎉

| 猫猫 | 引擎 | 角色参考 | 参考音频 | instruct |
|------|------|---------|---------|----------|
| **Ragdoll** | Qwen3 Base clone | 流浪者 v2 | `vo_wanderer_dialog_greetingMorning.wav` | 调皮狡黠、得意戏弄 |
| **Maine Coon** | Qwen3 Base clone | 魈 v2 | `vo_xiao_dialog_close2.wav` | 傲娇冰山、严厉关心 |
| **Siamese** | Qwen3 Base clone | 班尼特 v1 | `vo_bennett_dialog_greetingNight.wav` | 阳光开心、元气兴奋 |

### GPT-SoVITS 试听历程
- [x] conda env `GPTSoVits` (Python 3.10) 创建
- [x] GPT-SoVITS 仓库克隆 + install.sh 完成
- [x] 预训练模型下载（v2Pro, gsv-v2final, chinese-hubert-base）
- [x] AI-Hobbyist 原神 V2 数据集下载（流浪者/魈/班尼特/嘉明/空）
- [x] R1 试听（cut5，14 wav）→ 班尼特不错，流浪者奇怪
- [x] R2 试听（cut0，17 wav）→ 韵律改善，英文乱码
- [x] R3 试听（纯中文，50 wav）→ 声线可用但限制明显

### Qwen3-TTS Base clone 试听
- [x] clone API 调研（`ref_audio` + `ref_text` + `instruct` 三参数）
- [x] 试听脚本：`scripts/tts-qwen3-clone-audition.py`
- [x] 全量试听（9 preset × 5 texts = 45 wav）→ operator拍板通过！
- [x] 声线配置固化到 `cat-voices.ts` — PR #333 合入 main (f27b827d)
- [x] Siamese Qwen3 VoiceDesign `shuo_hinata` → clone 模式迁移完成（全部统一 Base clone）

## Phase 1 交付物（2026-03-09 合入 main）

| 交付物 | PR/Commit | 说明 |
|--------|-----------|------|
| TtsAdapter ABC + MlxAudio/EdgeTts 实现 | PR #234 (2026-03-07) | Python TTS 服务 Adapter 化重构 |
| Qwen3-TTS Base clone Adapter | PR #333 (2026-03-09) | `Qwen3CloneAdapter` + ref_audio/ref_text/instruct 全链路 |
| VoiceBlockSynthesizer clone passthrough | PR #333 | clone 参数从 cat-voices → synthesize() 全链路透传 |
| cat-voices.ts E 型统一配置 | PR #333 | 三猫声线：流浪者/魈/班尼特 + Kokoro 兼容 voice ID |
| Clone-aware timeout (30s→120s) | e57d81ae | 长文本 clone 合成防超时 |
| Maine Coon R1→R3 review + remote review | PR #333 | 5 findings (3P1+1P2) 全部修复 |

## 踩坑复盘 / 调试心得（2026-03-09）

### 坑 1: Kokoro-82M 质量远低于预期
- **现象**：Kokoro-82M 中文合成效果像"五年前的机器朗读"，韵律生硬
- **根因**：Kokoro 是 82M 超轻量模型，中文训练数据不足
- **教训**：TTS 模型参数量对中文质量影响巨大；轻量模型省算力但品质落差大。先做 A/B 试听再集成

### 坑 2: Qwen3-TTS VoiceDesign 抽卡式不稳定
- **现象**：同一 voice description 每次生成的声线差异大（9 轮试听仍不收敛）
- **根因**：VoiceDesign 是 zero-shot 文本描述到声线的映射，本质是 sampling，高 variance
- **教训**：VoiceDesign 适合探索不适合生产。生产环境需要确定性声线 → Base clone 用 `ref_audio` 锚定

### 坑 3: GPT-SoVITS 英文处理是结构性缺陷
- **现象**：81 个 wav 中，所有含英文的文本都出现乱码/断裂
- **根因**：GPT-SoVITS 以中文/日文为主训练，英文 phonemizer 基本不可用
- **教训**：Cat Café 内容中英混杂频率高（代码术语、猫名等），GPT-SoVITS 不适合做在线引擎。降级为离线声库工具

### 坑 4: Clone 合成超时导致语音降级
- **现象**：长文本（~200 字"坏猫计划"）发送后显示 `🔇 语音合成失败`
- **根因**：Qwen3-TTS Base clone 合成 200 字中文需要 ~35.6s，超过 `MlxAudioTtsProvider` 默认 30s timeout
- **修复**：检测 `refAudio` 或 `instruct` 参数存在时，自动将 timeout 提升到 `Math.max(this.timeoutMs, 120_000)`
- **教训**：clone 模式比标准合成慢 3-5x（Kokoro 82M ~3s vs Qwen3 clone ~35s）。新 provider/模式必须重新评估 timeout

### 坑 5: Voice ID 不兼容导致 clone 失败
- **现象**：`wanderer`/`xiao`/`bennett` 作为 voice ID 时 Kokoro 报错，clone 模式也可能受影响
- **根因**：这些是"化妆品名"（cosmetic names），Kokoro 合法 voice ID 是 `zm_*` 系列。虽然 clone 模式用 ref_audio 覆盖声线，但 voice 参数仍需合法
- **修复**：所有猫统一恢复为 `zm_yunjian`（Kokoro 兼容 ID）
- **教训**：voice ID 是模型层面的标识符，不是用户友好名。cat-voices.ts 的 `voice` 字段必须用模型认可的值

### 坑 6: VoiceBlockSynthesizer 未透传 clone 参数
- **现象**：通过 `/api/tts/speech` 直接调用可以 clone，但语音消息气泡（Route A/B）不 clone
- **根因**：`VoiceBlockSynthesizer.synthesize()` 只传了 `text/voice/langCode/speed/format`，clone 参数（refAudio/refText/instruct/temperature）被丢弃
- **修复**：从 `getCatVoice()` 提取 clone 字段 → 透传到 `provider.synthesize()` + 加入 cache hash
- **教训**：多层透传链路（config → service → provider）每层都需要确认参数传递，不能假设"上层已处理"

### 坑 7: Runtime 激活 TTS_PROVIDER
- **现象**：operator执行 `TTS_PROVIDER=qwen3-clone python3 tts-api.py` 后发现仍显示 `mlx-audio`
- **根因**：在 cat-cafe-runtime 目录下运行的是旧代码（未 pull 最新 main）
- **教训**：合入 main ≠ 部署到 runtime。runtime 是独立的生产环境，需要operator主动更新

### 坑 8: Cache key 缺少 refText 导致声线串台
- **现象**：Code review 发现的潜在 bug — 同一 text + 不同 refText 会命中同一缓存
- **根因**：`/api/tts/speech` 路由的 cache hash 只包含 refAudio/instruct，漏了 refText
- **修复**：在 `tts.ts` 和 `VoiceBlockSynthesizer.ts` 的 hashParts 中加入 refText
- **教训**：引入新参数时，搜索所有 hash/cache/key 计算点，确保无遗漏
