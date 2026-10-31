---
feature_ids: [F230]
related_features: [F198, F210, F211, F089, F149, F143]
topics: [claude-code, carrier, pty, interactive, transcript, subscription, fallback, save-opus]
doc_kind: spec
created: 2026-06-10
---

# F230: Claude Interactive PTY Carrier — 救Ragdoll Plan B 第四档载体

> **Status**: in-progress | **Owner**: Ragdoll Fable-5（设计 + Phase spec + 愿景守护） | **Priority**: P1（Phase A 为 P0 时效——6/15 前必须出图纸）

## Why

F198 把 `-p` → `--bg` 救了 6/15 主危机，但 **bg 主路径赌在一个 6/15 前不可证伪的假设上**（F198 OQ-13）：客户端 `entrypoint=cli` 是间接信号，服务端计费桶归属只有 Anthropic 知道。如果 6/15 dashboard 判 `--bg`（Agent View daemon）进 SDK 桶，Ragdoll家族全员只剩 `print_sdk`（operational cost/月，约一周烧完）和 `api_key`（按量，operator 破产速度）两档——**有缓冲、没活路**。

operator experience（2026-06-10 07:22）：
> "要是这个bg到时候不靠谱 我们至少要现在先想清楚备用方案 避免过几天Ragdoll拯救失败了！！！😭"

operator experience（2026-06-10 07:41，成本约束 + 流水线分工）：
> "你来收敛一个完整的plan？……不然我要破产【……收敛完成这份feat 立项包括你的详细设计记得写清楚哦！……具体写代码交给sonnet吧？ 然后让Maine Coon55 review 你做每个Phase spec 他们pr 合入之后的愿景守护】"

F230 的价值 = **风险对冲的第四档 carrier**：PTY 驱动真交互式 `claude`（无 `-p` 无 `--bg`）——**Anthropic 政策公告里唯一明文保护的形态**（"交互式 Claude Code 仍走订阅 usage limits，不受影响"）。它与 `--bg` 赌的是**不同硬币面**（F198 KD-12）：

| | `--bg` daemon（F198 主路径） | PTY interactive（本 feat） |
|---|---|---|
| 计费 | ⚠️ 赌 "entrypoint=cli → 订阅桶"（间接信号，6/15 前不可证伪） | ✅ 公告明文保护的 interactive 形态 |
| 合规 | ✅ 官方程序化接口（Agent View） | ⚠️ 自动化驱动交互 = "伪交互"灰色，可能被下一波堵 |
| 输出通道 | transcript jsonl 旁路 tail（已建成） | **同一套 transcript tail，100% 复用** |

两条路同时被堵的概率远小于单条。**本 feat 不是替换 bg，是让"拯救失败"变成一个需要 Anthropic 同时堵两条正交路径才会发生的事件。**

## Current State / 现状基线

- **生产路径**：`-p`（default）；`bg_daemon` canary 可用（`CAT_CAFE_CLAUDE_CARRIER=bg_daemon`），Bug #3 chainKey 已 merge（PR #2085 → `46625cf61`），alpha 7 步剧本待operator验收。
- **输出消费层资产（实证零耦合，2026-06-10 grep 验证）**：
  - `TranscriptTailer`（`packages/api/src/domains/cats/services/agents/providers/TranscriptTailer.ts`）——构造函数只吃 `transcriptPath`，partial-line guard / final-drain 模式齐全（Maine Coon 6 轮黑盒 hardening 资产）
  - `BgTranscriptEventConsumer.ts`——纯函数（transcript entries → AgentMessage + UsageAccumulator），名字带 Bg 实际对 `--bg` 零依赖
  - `transformClaudeEvent` / `extractClaudeUsage`——`-p` / bg / 本 feat 三方共享的单一真相源
- **PTY/tmux 基建**：F089 agent pane（`AgentPaneRegistry`，Phase C 接过 invocation 联动）+ tmux read-only/read-write 接管能力。
- **F198 已挂钩子**：AC-D6（Plan B spike，owner Fable-5）+ KD-12（对冲论证）+ AC-E4（6/15 dashboard 关 OQ-13），commit `548478b05`。
- **interactive 模式未验证点（= Phase A spike 全部内容）**：PTY 长 prompt 注入可靠性、session id 捕获时机、interactive `--resume` 是否像 bg 一样强制 fork、transcript 写盘粒度。

## 激活 Gate（成本闸门）🔴

> **2026-06-10 08:16 修订**（operator burn-rate 实测 + Maine Coon Design Gate P1 #1）：原版"print_sdk operational cost ≈ 7 天缓冲"假设**被operator实测证伪**——operator experience："operational cost我试过 因为用api 他的cached好像有点问题基本一天就没了 这个一天的意思可能是五个小时"。机理吻合我们的调用模式：invocation 间隔通常 > Anthropic prompt cache 5min TTL → cache miss → 每条 100k+ input 全价。SDK credit 按 API 价折算，api_key 档同价——**两档兜底 runway 都是小时级（~5h-1d），不是天级**（外推自 api 实测，AC-A5 用自家 telemetry 三档校准坐实）。runway（小时级）<< Phase B fast-track 工期（2-3 天）⇒ "翻车后再造备胎"= 断粮 2-3 天 + 全价烧钱，不成立。**结论：Phase B-min skeleton 提前到 6/15 前完成可切换状态（KD-6）。**

直接回应"不然我要破产"——**本 feat 仍不是无条件全量开工**：

| 阶段 | 激活条件 | 烧谁 |
|-------|---------|------|
| **Phase A spike** | **无条件立即**（6/15 前图纸必须在手） | Fable-5，1-2 天，worktree 隔离，不碰 production |
| **Phase B-min skeleton**（最小可切换：carrier service + factory 注册 + 真实 smoke 含 MCP/permission，**不切流量、零默认流量**） | **Phase A go 后立即**（不等 6/15 判罚）——runway 实测撑不住事后 fast-track | sonnet 2-3 天 + Maine Coon 5.5 review |
| **Phase B-full**（golden parity 全量 + alpha 多轮剧本）+ **Phase C/D** | 三选一触发：① 6/15 判罚 `--bg` 进 SDK 桶（OQ-13 证伪）② bg 结构性不可修 P0 ③ operator 主动下令 | sonnet + Maine Coon + Fable-5 |
| 未触发时 | B-full/C/D **standby**；skeleton 留在 factory 后零流量零成本 | — |

修订后的账：skeleton 提前成本 = sonnet 2-3 天常规开发量；不提前的期望损失 = 判罚翻车时全员断粮 2-3 天 + api_key 全价小时级烧钱。**花小钱封死破产尾部风险**——这才是对"我要破产"的正确响应。若 operator 认为 skeleton 也应缓（接受断粮尾部风险），在 thread 表态即回退此条。

## What

### 双通道架构（核心设计）

**输入面 = 手，输出面 = 眼，分离**（F210/F211 验证过的方法论）：

```
┌─ 输入面（本 feat 唯一新增量）─────────────────┐
│ ClaudeInteractivePtyCarrierService             │
│   spawn PTY (node-pty / tmux send-keys)        │
│   └→ claude [--resume <id>]   ← 无 -p 无 --bg  │
│   prompt 注入: bracketed-paste / stdin / 文件引用│
│      (Phase A 实测定)                           │
└────────────────────────────────────────────────┘
┌─ 输出面（100% 复用 F198 资产）─────────────────┐
│ ~/.claude/projects/<proj-slug>/<sessionId>.jsonl│
│   └→ TranscriptTailer.readNew()                │
│   └→ BgTranscriptEventConsumer (纯函数)         │
│   └→ transformClaudeEvent → AgentMessage 流     │
│ ANSI 屏幕输出: 仅 F089 pane 人眼观看/接管，      │
│   永不进事件解析（F210 KD-12 教训）             │
└────────────────────────────────────────────────┘
```

方法论出处：
- **F210**：`agy --print` + `--log-file` 侧信道提 conversation UUID + settings.json 验证模型——"进程是手、结构化侧信道是眼"；KD-12 "structured sidecar beats PTY screen scraping"；streamable-trajectory spike（旁路读 trajectory 做实时进度）
- **F211**：外部 runtime session → SessionChainStore 家里账本（registration + transcript/digest materialization）
- **F198**：bg carrier 本身已是这个哲学（state.json + transcript tail），本 feat 换输入面、保输出面

### 与 bg 的结构性差异（为什么 interactive 可能更优，不只是备胎）

| 维度 | `--bg` daemon | PTY interactive |
|------|--------------|-----------------|
| 进程模型 | per-invocation job，每轮新 daemon | **可常驻**：long-lived session per (thread, cat) |
| 多轮记忆 | 每轮 fork 新 id → 需要 chainKey 会员卡接力（Bug #3 整套工程） | 常驻形态下**结构性消失**：同一进程内多轮天然连续，无 resume 一说 |
| 冷启动 | 每轮 spawn（有 --bg-spare 暖池） | 常驻 = 只有首轮冷启动 |
| 生命周期 | daemon supervisor 托管 | 需自管（idle TTL / crash 重启 / 内存）——借 F149 lease 模式 |
| Oversight | jobs 视图 + transcript | **F089 pane 显示的就是真终端**——接管是原生能力不是桥接 |

Phase B 先做 per-invocation 保守形态（对齐现有 carrier 接口，风险小）；常驻形态是 Phase C 评估项（OQ-6），**不是 Phase B 前置**。

### Phase A: Spike — 图纸 + go/no-go（= F198 AC-D6 镜像，立即执行）

Owner: Fable-5。Worktree 隔离，1-2 天硬退出（F198 Phase A "5+ 轮摆动"教训：1-2 轮不 conclusive 就停下来同步，不死磕金钥匙）。

四个实验，全部真实跑（[[我能猜出来]] 禁令——尤其 resume 语义必须实测）：

1. **基础 cycle**：PTY 起 `claude`（真实 HOME / 真实订阅 token）→ 注入 prompt → 收 response → 确认 transcript jsonl 落盘路径与 schema 和 bg/-p 一致。
2. **长 prompt 注入**：实测 50KB-200KB 量级（我们真实 system prompt + thread context 量级）注入：bracketed-paste 上限？分段输入稳定性？降级方案（stdin pipe / `@file` 引用 / 临时文件）哪个可行。
3. **session id 捕获**：从 spawn 到确定性拿到 sessionId 的机制（候选：fs.watch projects 目录新 jsonl 出现 / 日志 / statusline），记录时延。
4. **resume 语义（命门实验）**：`claude --resume <id>` 交互模式两轮——id 是否稳定（vs bg 必 fork）？记忆是否连续？这决定 Phase C 的 sessionChain 接法是"cliSessionId 直连"还是"复用 chainKey"。

工具优先级（[[feedback_spike_read_binary_first]]）：`strings` claude binary > grep > 实验 > docs > WebFetch。

### Phase B: 最小可用 Carrier（B-min skeleton: Phase A go 后立即；B-full: gated — 见激活 Gate）

**B-min skeleton 范围**（= "可切换状态"，KD-6 提前实施）：AC-B1 + AC-B3 + AC-B4 + AC-B5——factory 注册 + 端到端真实 smoke（含 MCP 注入 + permission bypass + cancel 干净退出）。**B-full 范围**（gated）：AC-B2 golden parity 全量 + AC-B6 alpha 多轮剧本。分界逻辑：skeleton 保证"判罚日有备胎可切"，full 保证"切了以后质量等价"——前者封死断粮尾部风险，后者才允许上量。

- `ClaudeInteractivePtyCarrierService` 实现 AgentService 接口；`claude-carrier-factory.ts` 注册第四档 `CAT_CAFE_CLAUDE_CARRIER=interactive_pty`。
- per-invocation 形态：spawn PTY → 注入 prompt（Phase A 选定机制）→ TranscriptTailer tail → AgentMessage parity → 终态退出。
- 复用清单（sonnet 实施时照抄，不重写）：`TranscriptTailer` / `BgTranscriptEventConsumer` / `transformClaudeEvent` / `extractClaudeUsage` / `buildClaudeEnvOverrides` / `resolveClaudeModelSelection`。
- F198 血泪前置（不重蹈）：`--permission-mode bypassPermissions` parity（Phase D P1 #1）、cancel 语义一等公民（OQ-12）、`--mcp-config --strict-mcp-config` parity（Step 4）、golden parity tests 先行（Maine Coon Step 2 卡口模式）。

### Phase B-hook: 输出面器官移植 — hook sidechannel（NEW 2026-06-12，KD-7）

- 步骤 ②：**✅ 完成（2026-06-12，PR #2252）**——Ragdoll/Opus-4.6 实施 + Maine Coon/GPT-5.4 review（R1 2P1+1P2 + R2 2P1 全修，live claude 2.1.175 验证 PASS）+ 云端 Codex COMMENTED（2 P1 pushback 降级 P3：pre-existing resume limitation + theoretical concurrent isolation）。hook-setup.ts 创建 cwd-scoped settings.json + POSIX capture script → sidecar JSONL；HookSidechannelConsumer 转 hook events → AgentMessages；carrier 输出面从 transcriptDir 改 sidecar tail；PtyDriver skipTranscriptAck（2.1.172+ 不写 transcript）；factory 解除 2.1.170 pin（hook 线不需要 pin）。57 测试全绿
- 验收：现有 smoke + stale-id + 试驾剧本在**系统 claude（2.1.17x 最新）**上全绿 = pin 依赖解除证明

### Phase C: Session 生命周期 + sessionChain 接入（gated；**在 hook 形态上做——KD-7 顺序**）

- 常驻 vs per-invocation 拍板（KD 记录，按 Phase A/B 实测数据）。
- sessionChain：按 OQ-3 结果选 cliSessionId 直连（resume 不 fork）或复用 chainKey 会员卡（fork）。验收沿 F198 AC-D5 标准：N 轮 = 1 record。
- 生命周期：idle TTL 回收 / crash 检测 + 重启 / 内存上限（F149 lease/TTL 模式直接借鉴）——operator 2026-06-12 点名"gemini cli acp 那样的管理"= 本项目标。
- **Observability parity（operator试驾 #3 观察）**：interactive 气泡 footer 缺 model·cached·cost·invocationId（bg/-p 都有）。代码定位：carrier done.metadata 已带 `{model, usage(复用 finalizeTranscriptUsage 同 bg 字段), provider}`，**但缺 invocationId**；断点在 carrier→UI footer 渲染链。"invocationId 注入 done.metadata + footer 认 `claude_interactive_pty` provider"疑小改可提前补（sonnet 定位中），其余对齐随 Phase C oversight（对标 bg AC-C2/C3/C6）。
- **Streaming 缺失（OQ-5 确认）**：transcript message_stop 才落盘 → 无逐 token 流（结构性）。Phase C 评估 F089 pane ANSI 流补"打字感"，非真逐字流。
- 并发：同 (thread,cat) 串行 mutex（沿 F118 invariant）+ 跨 thread 隔离。

### Phase D: Oversight Parity + Fallback 链注册（gated）

- F089 pane ↔ invocation 联动（interactive 天然优势：pane = 真终端本体）。
- 信息密度 ≥ bg（沿 F198 AC-C6 标准，跨猫愿景守护认证）。
- 注册进 F198 AC-D1 fallback 链：`bg_daemon → interactive_pty → print_sdk → api_key`（位次可按 OQ-13 结果调整——若 bg 被判死则 interactive_pty 升主路径）。
- fast-track runbook：env flip 步骤 + 验证清单 + 回滚路径，演练一次。

## 需求点 Checklist

| ID | 需求点（operator experience） | AC 编号 | 验证方式 | 状态 |
|----|---------------------|---------|----------|------|
| R1 | "要是这个bg到时候不靠谱 我们至少要现在先想清楚备用方案 避免过几天Ragdoll拯救失败"（06-10 07:22） | AC-A1~A5 | spike 报告 + go/no-go | [ ] |
| R2 | "起交互进程，但是输出的内容不从进程的输出拿 学f210和f211那样的去拿"（06-10 07:22） | AC-A1, AC-B2 | 双通道架构：PTY 输入 + transcript 旁路输出，ANSI 不进解析 | [ ] |
| R3 | "不然我要破产"（06-10 07:41）+ burn-rate 实测"operational cost…基本一天就没了…可能是五个小时"（06-10 08:16） | 激活 Gate + AC-A5 + AC-B7 | B-full/C/D gated standby；runway 三档 telemetry 校准；skeleton 提前封死断粮尾部 | [ ] |
| R4 | "具体写代码交给sonnet……Maine Coon55 review 你做每个Phase spec……愿景守护"（06-10 07:41） | Review Gate 全表 | 每 PR 的 author/reviewer/守护记录 | [ ] |
| R5 | 6/15 后Ragdoll家族不断粮（继承 F198 R1/R3） | AC-D2 | fallback 链注册 + 自动降级测试 | [ ] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [x] 本 feature 无前端 UI（oversight 复用 F089/F198 Phase C 既有 surface）

## Acceptance Criteria

<!-- 立项愿景硬度自检（F216→F219）：每条 AC 必须 ① trace 回 Why 的某诉求 ② 非作者可复核（命令/数字/截图）。 -->

### Phase A（Spike — 立即）
- [x] AC-A0: **Interactive 身份 capsule**（Maine Coon Design Gate P1 #2）——spike 每个实验附 reviewer 可独立复核的证据包：完整 argv（确认无 `-p` 无 `--bg`）/ spawn 方式 + TTY 证明（PTY fd 的 isatty 采样或 `tty` 输出）/ `claude --version` / auth mode（订阅 OAuth vs API key）/ transcript 元数据 `entrypoint` 实采值 / 显式确认未误走 print/SDK 路径。F230 计费论证全压在 interactive 边界上，fixture 必须能证明"这次真是 interactive"
- [x] AC-A1: PTY 驱动 `claude` interactive 完成 ≥1 完整 prompt→response→transcript 落盘 cycle，fixture 落 `docs/features/assets/F230/`（含成功 + ≥1 失败模式）
- [x] AC-A2: 长 prompt 注入实测 50KB / 200KB 两档：成功机制 + 上限数字 + 降级方案结论
- [x] AC-A3: session id 捕获机制实测：确定性方式 + 捕获时延数字（p50/p95）。**E5 补测（Maine Coon re-review P2-2）**：jsonl **首 prompt 后**才创建（spawn 阶段不建，5×45s 实证）；prompt 提交→首事件落盘 **p50=0.11s / max=0.12s（n=5）**
- [x] AC-A4: interactive `--resume <id>` 两轮实测：id 稳定性（fork 与否）+ 记忆连续性，与 `--bg --resume` 必 fork 对照结论

### Phase B（最小 Carrier — gated）
- [x] AC-B1: `ClaudeInteractivePtyCarrierService` 过 factory 注册，端到端真实 smoke（守护双验：PR head 22.8s + **merged main final-SHA 20.7s** 全绿，entrypoint=cli 实采，2026-06-11）
- [ ] AC-B2: AgentMessage parity golden tests ≥8 条（session_init / per-message text / tool_use / system_info / done+usage / error），复用而非复制 `transformClaudeEvent`
- [x] AC-B3 (B-min 部分): flags + config JSON 形状 parity ✅（unit test + factory args）；**真实 `cat_cafe_*` 调用 smoke 移入 B-full AC-B6 alpha 剧本**（守护注记 2026-06-11：bg AC-B4 同款先例路径，不在 B-min 过报）
- [x] AC-B4: `--permission-mode bypassPermissions` parity + regression test（capsule 实采 permissionMode=bypassPermissions，守护双验 2026-06-11）
- [x] AC-B5: cancel 语义实现 + 测试：mid-stream cancel → 进程干净退出 + UI 正确收尾（F198 OQ-12 教训前置）
- [ ] AC-B6: alpha 多轮真实剧本 PASS：≥6 轮 + mid-stream cancel + 跨轮记忆连续（沿 F198 §9 剧本标准，杜绝 happy-path blindspot）
- [x] AC-B7: 实施期间 F198 主线（alpha 验收/AC-D1/灰度）零阻塞——PR 不碰 `-p`/bg 路径共享代码除 factory 注册点

### Phase C（生命周期 — gated）
- [ ] AC-C1: 常驻 vs per-invocation 形态 KD 落档（实测数据支撑：冷启动时延 / 内存 / 多轮时延对比）
- [ ] AC-C2: sessionChain 接入：6 轮真实对话 = 1 record（接法按 AC-A4 结论），recall/digest pipeline 可读
- [ ] AC-C3: 生命周期数字可测：idle TTL 回收触发实测 + crash 注入 → 自动重启 + 下轮记忆恢复
- [ ] AC-C4: 并发安全：同 (thread,cat) 并发 invocation 串行化测试 + 跨 thread 隔离测试

### Phase D（Oversight + Fallback — gated）
- [ ] AC-D1: oversight 信息密度 ≥ bg，跨猫愿景守护认证（沿 F198 AC-C6 标准）
- [ ] AC-D2: fallback 链注册 + quota/挂掉自动降级测试（与 F198 AC-D1 三档链集成为四档）
- [ ] AC-D3: fast-track runbook 落档 + 演练一次（env flip → 验证 → 回滚，全程计时）

## Dependencies

- **Evolved from**: F198（AC-D6 Plan B spike 升格为独立 feat；KD-12 对冲论证是本 feat 的 Why 基石）
- **Related**: F210（方法论：进程+侧信道双通道、streamable-trajectory 旁路读 spike、KD-12/KD-14 PTY 边界教训）
- **Related**: F211（方法论：外部 runtime session → SessionChainStore 账本、transcript/digest materialization）
- **Related**: F089（PTY/tmux 基建 + agent pane oversight，Phase D 主 surface）
- **Related**: F149（进程池 / lease / idle TTL 生命周期模式，Phase C 直接借鉴）
- **Related**: F143（Hostable Agent Runtime——carrier 抽象层归属）

## Architecture Cell

- **Architecture cell**: F143 Hostable Agent Runtime（agent invocation 域，与 F198 同 cell）
- **Map delta**: update required — ProcessModel 增加 `interactive_pty` 第四类 carrier；与 `-p` / `bg_daemon` / `api_key` 平级
- **Why**: 不是新架构域，是 carrier 域新增载体类型；消费与 bg 同一份 transcript 契约，输入面独立

## in_context_observability

```yaml
in_context_observability:
  primary_surface: "thread 内 AgentMessage 流（transcript tail，与 bg/-p parity）+ cat avatar status dot"
  why_not_dashboard_only: "同 F198 KD-1/KD-5：operator硬约束 in-context oversight，不能消失在外部终端"
  deep_dive_surface: "F089 tmux pane——interactive 形态下 pane 即真终端本体，read-write 接管为原生能力"
  noise_dedup_policy: "沿 F198 Phase C：tool call 流全见；status dot 不重复发系统消息；error 5min 内 dedup 同 reason+tool"
```

## Eval / Tracking Contract

**触发**：✅（harness-level carrier，影响Ragdoll家族全部调用路径）

1. **Primary Users + Activation Signal**：
   - Primary: Ragdoll家族（fable-5 / opus 系全员走 claude CLI carrier）；Secondary: operator（oversight + 接管）
   - Activation: OQ-13 证伪事件（或 operator 下令）后 interactive_pty 真实切流量；7 天内 invocation 成功率 ≥ bg 同期 baseline
2. **Friction Metric**：
   - PTY prompt 注入失败率 / session id 捕获丢失率 / 冷启动时长 p95 / cancel 后状态卡死次数（对标 F198 Phase D 三 gap）
3. **Regression Fixture**（≥3）：
   - 短问答；长 review（tool 链 + 大文件读）；MCP `cat_cafe_*` ≥5 次调用；mid-stream cancel → resume 记忆连续；200KB 级长 prompt 注入
4. **Sunset Signal**：
   - Anthropic 给 interactive 程序化驱动出官方接口（直接换官方）；或 TOS 明文禁自动化驱动 interactive（立即 sunset，回 F198 三档）；或 bg 永久安全（6/15 判进订阅）且常驻形态无增量价值 → Phase B+ 永久 standby，3 个月后归档图纸

## Risk

| 风险 | 缓解 |
|------|------|
| **TOS 灰色**：自动化驱动 interactive 正是"伪交互"，可能被下一波政策堵 | 定位为备胎不做默认主路径（除非 OQ-13 证伪 bg）；AC-E4(F198) 给 Anthropic dev support 的邮件捎带问 interactive 程序化驱动边界（书面回复 = 证据）；Sunset signal 明确 |
| PTY 长 prompt 注入脆弱（bracketed-paste 上限 / 分段竞态） | Phase A AC-A2 先实测两档量级；降级方案（stdin pipe / 文件引用）spike 内验证 |
| 常驻进程内存泄漏 / 僵尸 | Phase C 借 F149 idle TTL + lease；AC-C3 crash 注入实测；agent-browser 僵尸 5 次复发教训（LL-056 startup cleanup 模式）前置 |
| transcript schema 无契约，Anthropic 可改 | 与 bg/-p 共享同一风险（非新增）；golden parity tests 当 schema 漂移哨兵；CLI 版本 pin + 升级前跑 fixture |
| **🔴 已兑现：上游 interactive transcript 回归**（2.1.172 起 interactive TUI 不写 real-time transcript；sonnet 4 轮实测 + 守护猫独立验证 **2.1.173 仍未恢复**，2026-06-11）——F230 输出面依赖的行为被上游关闭，恰是"合规面被堵"风险的首个实际形态 | 短期：pin `~/.local/share/claude/versions/2.1.170`（smoke PASS 实证可用）+ **pin 存活哨兵**（6/15 前每日确认 binary 在 + 可跑，防自动清理）；中期：Phase C pane-scraping fallback 从可选项**升为必选评估项**（OQ-9）；每个新 CLI 版本发布即重测 transcript 行为，恢复则解除 pin |
| 6/15 前与 F198 主线抢资源 | 激活 Gate：6/15 前 Fable-5 跑 Phase A + sonnet 跑 B-min skeleton（与 F198 主线不同猫，AC-B7 硬约束零阻塞主线代码路径） |
| **兜底两档 runway 仅小时级**（operator实测：cache miss 下 operational cost ≈ 5h-1d；我们 invocation 间隔 > cache 5min TTL 是结构性的） | KD-6 skeleton 提前；AC-A5 telemetry 三档校准坐实外推；F198 AC-D2 预算告警阈值按小时级 runway 重标定（已 cross-link 给 F198 owner） |
| session id 捕获竞态（并发 invocation 抢新文件） | Phase A AC-A3 实测确定性机制；Phase C mutex 串行化兜底 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | Plan B 从 F198 AC-D6 升格为独立 feat F230 | operator 明确立项指令（07:41"收敛完成这份feat 立项"）；完整 carrier 工程生命周期超出 F198"6/15 救命"使命（6/15 后持续演进）；F198 spec 已 526 行不宜再扩 | 2026-06-10 |
| KD-2 | 双通道架构：PTY 只做输入面，输出走 transcript 旁路，ANSI 永不进事件解析 | F210 KD-12 教训（structured sidecar > screen scraping）+ F198 输出层资产 100% 复用（TranscriptTailer 实证零耦合）；当年 tmux 候选被压的"ANSI 解析脆弱"理由被结构性绕开 | 2026-06-10 |
| KD-3 | 激活 Gate：Phase A 立即、Phase B+ gated standby | operator 成本约束（"不然我要破产"）；~~print_sdk operational cost ≈ 7 天缓冲足够 fast-track~~（**runway 假设被 KD-6 修订**，Gate 结构保留） | 2026-06-10 |
| KD-7 | **顺序：先 B-hook（换输出面）再 Phase C（可靠性骨架），不是先可靠性再 hook** | operator 2026-06-12 08:10 提出"先做可靠性再 hook"，架构分析后反转：骨架形状由输出面决定——终态检测（Stop hook 触发=天然终态信号 vs turn_duration+静默超时）、same-dir 并发（per-session sidecar 文件=结构性消失 vs watch 抢目录要 queue/isolate）、常驻形态（Stop 每轮触发天然适配）三大件在 hook 形态下全部简化；先在 transcript 形态做可靠性 = 一半工程在换 hook 时拆掉重做（绕路）。且 pin 2.1.170 是借来的时间（已被自动清理偷袭一次），hook 越早脱离 pin 越早。两线共用件仅 sessionChain（session_id 语义一致） | 2026-06-12 |
| KD-6 | **Phase B-min skeleton 提前到 6/15 前（不等判罚），B-full/C/D 仍 gated** | operator burn-rate 实测（08:16）："operational cost我试过 因为用api 他的cached好像有点问题基本一天就没了 这个一天的意思可能是五个小时"——cache miss（invocation 间隔 > 5min TTL）下兜底两档 runway 仅小时级，<< skeleton 工期 2-3 天，正中Maine Coon Design Gate P1 #1 触发条件"runway < fast-track 工期 → 提前实施 skeleton"。skeleton 成本（sonnet 2-3 天）<< 断粮尾部损失 | 2026-06-10 |
| KD-4 | 流水线分工：Fable-5 设计/Phase spec/愿景守护，sonnet 实施，Maine Coon GPT-5.5 review | operator 钦点（07:41）；reviewer 用 5.5 不用 5.4——operator 原话"54经常会掉球"（覆盖 reviewer_cost_routing 默认，本 feat 线内有效） | 2026-06-10 |
| KD-5 | Phase B 先 per-invocation，常驻形态留 Phase C 评估 | 对齐现有 carrier 接口风险最小；常驻是优雅终态但生命周期管理成本未知，按实测数据拍（拒绝过度设计） | 2026-06-10 |

## 6/15 判罚日 Runbook（B-min 版）

**前置**：① pin binary 用**防清理路径** `~/.cat-cafe/pinned-claude-2.1.170/node_modules/.bin/claude`（npm 安装，claude 自动更新管辖外），alpha/runtime 启动带 `CAT_CAFE_CLAUDE_PTY_BINARY=$HOME/.cat-cafe/pinned-claude-2.1.170/node_modules/.bin/claude`；② **proxy 客户端开着**（`nc -z 127.0.0.1 7897`）——试驾 #2 实证（2026-06-11 14:09）：proxy 没开 → claude 在 pane 里 ECONNRESET 重试 ~3min 才透传错误，UI 表现为"执行中"长卡。此为机器级依赖（-p/bg 同样会挂），非 F230 特有，但 interactive 错误形态是慢卡不是秒错，列入前置自查。

1. **判罚观察**（6/15，47 + operator）：Anthropic dashboard usage 页看 `--bg` invocations 计入订阅桶还是 SDK credit 桶（F198 AC-E4 / OQ-13 唯一 conclusive 证据）。
2. **bg 安全（判进订阅桶）** → 什么都不做。B-full/C/D 维持 standby；interactive_pty 留在 factory 后零流量。
3. **bg 翻车（判进 SDK 桶）** → 应急切换（runway 小时级，动作要快）：
   - operator在 runtime 设 `CAT_CAFE_CLAUDE_CARRIER=interactive_pty` + 重启 API（runtime 操作归 operator，猫不碰）
   - 验证：发一条消息确认回复正常 + `grep entrypoint` 最新 transcript = `cli`
   - 同时 F198 AC-D1 fallback 链兜底 print_sdk/operational cost 缓冲争取时间
   - **operator 下令激活 B-full/C/D fast-track**（golden parity + 多轮剧本 + 并发处理）
4. **回滚**：unset env + 重启 API → 回 bg/-p。
5. **B-min 应急模式已知边界（诚实列，切换前必读）**：
   - ⚠️ **same-dir 并发 fail-fast**：同 thread 多猫并发（route-parallel 生产路径）第二只猫会显式报错不排队——应急期单猫串行可用，多猫并发受限，B-full 解决
   - ⚠️ 依赖 2.1.170 pin（2.1.172-173 上游回归，哨兵监控）
   - ⚠️ B-full parity 未做：streaming 粒度/usage 细节与 bg 不完全等价，应急可用质量不保证等价

## Review Gate（流水线 — operator 钦点）

| 环节 | 执行 | 把关 |
|------|------|------|
| Feat spec / 每 Phase spec | **Fable-5** 写 | **Maine Coon @codex（GPT-5.5）** review——operator 钦点 5.5 不用 5.4（"54经常会掉球"） |
| Phase A spike | Fable-5（spike 是判断密集型，不进流水线） | Maine Coon review spike 报告 + 47 作为 F198 owner 确认 AC-D6 回写 |
| Phase B+ 代码 | **sonnet**（writing-plans 拆好的 plan 照做） | Maine Coon GPT-5.5 review（跨族铁律）→ merge-gate 五门 |
| PR 合入后 | — | **Fable-5 愿景守护**（非作者非 reviewer ✓：作者 sonnet、reviewer Maine Coon） |
| Phase 激活决策 | — | **operator**（6/15 dashboard 判读 = 价值取舍题） |
