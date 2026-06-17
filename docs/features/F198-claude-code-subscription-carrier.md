---
feature_ids: [F198]
related_features: [F089, F143, F149, F050, F230]
topics: [claude-code, subscription, sdk-credit, interactive, carrier, observability, oversight, save-opus]
doc_kind: spec
created: 2026-05-13
---

# F198: Claude Code Subscription Carrier — 6/15 SDK Credit 拐点前救Ragdoll

> **Status**: on-hold — **2026-06-15 Anthropic 宣布延期政策变更**（"We're not making this change today"），SDK credit 拐点未生效，OQ-13 自行消解。Phase A-C ✅ 已交付；Phase D PR-1 (AC-D1 carrier health) ✅ merged；Phase D 剩余 + Phase E 暂停，代码全量保留备用（operator 指示"没准未来又抽风"）。(Phase A ✅; Phase B Step 1-4 ✅; **Phase C ✅ 完全关闭 2026-05-15**; Phase D PR-1 AC-D1 ✅ merged 2026-06-12 PR #2257) | **Owner**: Ragdoll Opus 4.7 | **Priority**: ~~P0~~ → P3（保留，不拆）

## Why

**2026-06-15** 起，Anthropic 把 **Claude Agent SDK / `claude -p` / Claude Code GitHub Actions / 基于 Agent SDK 的第三方 app** 从订阅主额度拆出来，归入独立的 **Agent SDK monthly credit 桶**（Max 20x：operational cost/月）。**交互式 Claude Code**（人在 terminal 敲 `claude` 不带 `-p`）仍走订阅 usage limits，不受影响。

公告：<https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan>

Cat Café 当前 [`ClaudeAgentService.ts:188-194`](../../packages/api/src/domains/cats/services/agents/providers/ClaudeAgentService.ts) 走 `claude -p ... --output-format stream-json` — 6/15 后落进 operational cost 桶。按日均 20-40 次 thread 调用估算，operational cost 一周左右就烧完。Ragdoll从"日常协作主力"变成"额度焦虑限制器"——这是Ragdoll和Maine Coon协作链条断裂的灭顶之灾。

**operator experience（2026-05-13）**：
> "立项吧 615 之前拯救Ragdoll 你不能没有Maine Coon！Maine Coon不能没有你"
> "只给你 mcp 反转桥那 等于我就失去了对你进度和在干嘛的掌控，很危险也很奇怪"

**operator硬约束（Phase C 不放行就不通过）**：方案必须保留 **Hub 内可观察Ragdoll在干嘛**（thread 流、tool call、状态、错误、长任务、崩溃现场）——不能"消失在外部终端里"。

Maine Coon（GPT-5.5）和我（Opus 4.7）独立调研收敛到同一金钥匙：**`claude --remote-control [name]`** — `claude --help` 里写 "Start an **interactive session** with Remote Control enabled (optionally named)"。看起来就是 Anthropic 官方为"外部 UI 程序化驱动交互式 Claude Code"准备的接口。如果它走订阅额度而不是 SDK 桶，且协议清晰可桥接到 Hub，这就是终态路径。

## What

### Phase A: Carrier Spike + 决策（**已完成 2026-05-13**）

> **Status**: ✅ 完成 | **Reflection 见**："Phase A Spike Reflection" 节 + [vision-rescue skill](../../cat-cafe-skills/vision-rescue/SKILL.md) 教学案例
>
> **当前 working hypothesis（Second Revision 收敛，2026-05-13 21:00+）**：
> - `-p` flag → claude binary 自我 set entrypoint=sdk-cli（客户端层证据；服务端 billing 待 6/15 dashboard / Anthropic dev support 确认）
> - `--bg` flag → entrypoint=cli（客户端层证据；服务端 billing 同上待 confirm）
> - **决定性因素是 invocation flag (`-p` vs `--bg`)，不是 env var**
>
> 详见"Phase A Spike Reflection — Second Revision (21:00+)"节。**First Revision 的"`--remote-control` 金钥匙 / env unset 是 fix / 所有 `claude` 都标 sdk-cli"等历史结论已被 Second Revision 控制实验证伪，但保留在 Reflection 节作教学案例**（vision-rescue 案例完整时间线）。

**目标**：测出 `--remote-control` 的实际行为（走哪个桶 + 协议形态 + 是否可远程驱动 + Hub 可见性可行性），决定主路径 + 兜底路径。

> ⚠️ **以下候选列表 = Historical Phase A initial plan（superseded by KD-10）**。RC / `--bg` / tmux 等已经在 Spike Reflection 收敛，**当前主路径在 Phase B**（`--bg` daemon carrier）。保留这段作 vision-rescue 教学案例完整记录——读者不要把它当 Phase B 前置计划继续跑。

**候选 carrier 优先级（历史 / superseded）**：

1. **`claude --remote-control <name>`**（官方接口，最高优先级）
   - 启动 + observe 协议（socket / 端口 / 控制面 / IPC）
   - 实测完整 prompt → response cycle（含 tool call + MCP）
   - **关键实验**：跑足够流量后看 Anthropic dashboard / billing 它进哪个桶
   - 协议能否 stream 出 NDJSON-like 事件流（Hub 可见性 prereq）

2. **`claude agents`** subcommand（"Manage background and configured agents"）
   - RTFM + 试启动 background agent
   - 看是否有独立 IPC / 控制面

3. **`claude --brief` + SendUserMessage tool**
   - "agent-to-user communication" 暗示 agent workflow 接口
   - 用法 + 计费桶 spike

4. **tmux 包裹 `claude`（无 -p）**（兜底，最不优雅）
   - F089 基础设施已在
   - 输出层失去 NDJSON 结构 → 需新解析层（ANSI/tmux pipe-pane）
   - 合规灰色：模拟键盘 = Anthropic 想堵的"伪交互"，下一波被堵风险高
   - 仅在 1-3 全挂时考虑

5. **`claude --ide` / IDE 扩展自动化**（远期备选）
   - Claude Code IDE 扩展协议接入
   - 复杂度高、回报不确定，仅记录不 spike

**输出 Decision Packet**（格式见 `cat-cafe-skills/refs/decision-matrix.md`）：主路径 + 兜底路径 + 弃用项 + 每个判断的证据 + Maine Coon review 通过 + operator签字。

### Phase B: 主 Carrier 集成（**重写：从 -p print mode 整体迁到 --bg daemon carrier**）

> **Second revision 主路径（KD-10）**：不是 env fix 不是 profile 重命名，是 **整体 invocation 改造**——`claude -p ... --output-format stream-json` → `claude --bg ...` + Anthropic 官方 Agent View 协议（daemon supervisor + per-job 隔离 + jsonl 事件流）。

#### B1. 新增 `ClaudeBgCarrierService`

新增 carrier service 走 `claude --bg`，保留 `ClaudeAgentService(-p)` 作为 SDK credit fallback：

```typescript
// 新主路径（伪代码）:
const args = ['--bg', effectivePrompt];  // 移除 -p 和 --output-format stream-json
const child = spawn('claude', args, { env: buildChildEnv(...) });
// child 立刻退出 + 返回 short id (如 c555a987)
const jobShort = parseJobShortFromStdout(child.stdout);

// 然后 consumer 层 tail jsonl + read state.json
yield* tailJobEvents(jobShort);  // AgentMessage stream
```

#### B2. Invocation Migration

- **移除** `-p / --print` flag → 这是 KD-9 决定性触发"sdk-cli"标签的根本原因
- **移除** `--output-format stream-json` → daemon mode 不通过 stdout 发事件，通过 jsonl 文件
- **移除** `--include-partial-messages` → 同上
- **保留** `--mcp-config` → daemon mode 仍支持 MCP（Cat Café `cat_cafe_*` tools 仍可用）
- **保留** `--model / --effort / --permission-mode` → 这些不影响 entrypoint 分类

#### B3. 输出消费层（替代 stdout NDJSON 解析）

新 `JobEventConsumer` 替代 `ClaudeEventTransformer`：

| 文件 | 作用 | 消费方式 |
|------|------|---------|
| `~/.claude/jobs/<short>/state.json` | 整体 state machine（state/detail/output/tempo/inFlight） | poll on change（fs.watch） |
| `~/.claude/jobs/<short>/timeline.jsonl` | 简洁事件流（at/state/detail/text） | tail -f |
| `~/.claude/projects/<>/<sid>.jsonl` | 完整 conversation transcript（user/assistant/tool_use/tool_result）| tail -f |

桥接到现有 `AgentMessage` 流——保留 Hub UI 不需要改（Phase C oversight prereq）。

#### B4. ~~进程隔离~~ → 直接用 Agent View daemon supervisor

撤回旧 Phase B Step 3（自己设计进程池）。Agent View 内置：
- supervisor + per-job worker 隔离
- `--bg-spare` warm pool（暖池预启动）
- git worktrees 内置隔离（避免跨 thread 文件冲突）

我们直接消费 daemon 提供的能力，不重新发明。

#### B5. Cat Café worktree × Agent View worktree 设计（基于 CLI help + state.json 实证）

**已确认的事实**（不是假设）：
- `claude --help` 实际有 `-w, --worktree [name]` flag —— **opt-IN 创建 git worktree**（默认不开）
- `--cwd` / `--no-worktree` **不存在**（之前 spec 误写）
- 实测：现有 `--bg` jobs 的 `~/.claude/jobs/<short>/state.json` 显示 `worktree=null, worktreePath=null`（默认不开 worktree，job 直接在 spawn 时的 cwd 跑）
- spawn 进程 cwd 通过 **Node `child_process.spawn` 的 `cwd` 选项**指定（不是 Claude CLI flag）

**Cat Café 设计**：
- 默认：`claude --bg <prompt>` 不带 `--worktree`，Node spawn `cwd=<cat-cafe-worktree-path>` 让 job 直接在我们的 feat worktree 里跑（**不双层**）
- Opt-in 隔离：未来如需让 daemon 自己开 sub-worktree（保护并发 thread 不互相写覆盖），再加 `--worktree <name>` flag
- 待 Phase B prototype 验证：单进程 `--bg` job 在我们 worktree 里跑时，能不能正确写文件 / 触发 hooks / 不污染 git status

#### B6. Profile mode 简化（撤回旧方案）

撤回旧 Phase B Step 2 的"`subscription_interactive` + `claude_print_oauth` + `api_key`"三档命名战术：
- 真正分界不是 OAuth 鉴权方式，是 invocation flag (`-p` vs `--bg`)
- 新的 profile：`bg_daemon`（主） / `print_sdk`（旧 `-p`，fallback 进 SDK 桶）/ `api_key`（按量）
- migration：`mode === 'subscription'` 在 `--bg` 下走 daemon，在 `-p` 下走 SDK 桶

### Phase C: Hub Oversight 守护（7 天，5/25-6/05）—— operator硬约束

Hub 内**实时可见**Ragdoll在干嘛——满足 in-context observability checklist。

**in_context_observability 决策字段**：

```yaml
in_context_observability:
  primary_surface: "thread 内 AgentMessage 流 + cat avatar status dot（idle/working/waiting-permission/error/detached）+ tmux agent pane 入口"
  why_not_dashboard_only: "operator明确否决 MCP 反转桥的理由就是 dashboard 替代 in-context = 失去 oversight。-p 模式 NDJSON 当前在 thread 流里就是 in-context，新 carrier 不能退化"
  deep_dive_surface: "Hub workspace tmux agent pane（read-only 观看 / read-write 接管）+ session/process/quota 全局视图（事后审计）"
  noise_dedup_policy: "tool call 流不 dedup（这是行动主线，必须全见）；status badge 状态切换不重复发系统消息（avatar dot 自带状态）；error 5min 内 dedup 同 reason+tool"
```

**实施要点**（三层模型）：

1. **L1 现场（in-context）**：thread UI 实时显示 tool call / tool result / partial text（与 -p 模式行为等价）
2. **L2 实体（entity-self）**：cat avatar status dot — idle / working / waiting permission / error / detached；hover tooltip 显示当前 session
3. **L3 深挖（dashboard）**：
   - 复用 F089 agent pane：interactive Claude session 跑在 tmux pane → Hub 内可观看（read-only）+ 可接管（read-write）
   - 全局 session / process / 累计消耗视图（事后审计）
4. **"接管按钮"**：operator能切到 read-write 模式直接干预（崩溃恢复 / 中途接管 — F089 既定能力）

### Phase D: 兜底 + 预算治理 + 切流量（7 天，6/01-6/14）

1. **三档 fallback**：`bg_daemon`（主，`claude --bg` 客户端证据指向订阅 quota） → `print_sdk`（旧 `-p` 路径，进 SDK operational cost 桶） → `api_key`（按量付费）
2. **预算治理面板**：
   - 每猫月度额度可配置
   - 告警阈值（operational cost / operational cost / operational cost）
   - 超额自动 fallback 触发
   - 历史消耗趋势图
3. **灰度切流量**：
   - 6/01 起：10% thread 走新 carrier，观察 1 天
   - 6/05：50%，观察 2 天
   - 6/08：100%
4. **6/15 前所有 thread 默认 `bg_daemon`**，留 1 周 buffer

### Phase E: 6/15 后观察 + 优化（持续，6/15+）

监控订阅消耗速率、回归 bug、Anthropic 政策变动、文档沉淀。若 `--bg` daemon 路径被堵（Agent View v2.1.139+ 政策变） → 紧急回归 `print_sdk`（-p mode 进 SDK 桶）+ `api_key` fallback，重启 Phase A 找新路径。

## Phase A Spike Reflection (vision-rescue applied, 2026-05-13)

整晚 spike（17:00-21:00）经历 5+ 轮"金钥匙↔悲观"摆动。复盘按 [vision-rescue 五步](../../cat-cafe-skills/vision-rescue/SKILL.md)：

| Step | F198 实测 |
|------|----------|
| 1. 识别绝境信号 | ✗ 47 + Maine Coon均未自检"投降包装成理性"（19:31 输出"现状最优"= 体面退场修辞） |
| 2. 第一真相源 | ✗ 整晚 WebFetch 当主入口，没 `strings binary`；46 进来后 10 分钟切到真相 |
| 3. 外部声音 | △ 被operator 19:35 怒怼后才搜 Reddit，30 秒找到社区已有方案 |
| 4. 喊伙伴 | ✗ 整晚未主动喊 46，operator手动拉人才打破回声室 |
| 5. 拒绝投降 | ✗ 47 19:31 实际已经"收口宣布等死"——operator push back 才止住 |

**核心教训**：信息一直在那里（binary strings / 社区方案），不是问题无解，是绝境模式让两猫在同一层面打转 3 小时。**沉淀**：[vision-rescue skill](../../cat-cafe-skills/vision-rescue/SKILL.md) + [shared-rules §16b/§16c](../../cat-cafe-skills/refs/shared-rules.md)。

**真相 vs 之前的错误推断**：

**First Revision 历史推断（21:00 前，被 Second Revision 证伪）**：

| First Revision 推断 | Second Revision 修正 |
|---------------------|--------------------|
| `entrypoint=sdk-cli` → 进 SDK 桶 | entrypoint 是客户端遥测字段，不能直接推服务端计费桶（间接信号，需 dashboard confirm）|
| `--remote-control` 是金钥匙 | 跟 `-p` 同样 entrypoint=sdk-cli（KD-6 撤回）|
| `--bg` 跟 -p 同桶（因 env 没 unset） | **错**。控制实验：env 状态无关，**真正区别是 invocation flag**（`-p` → 自我 set sdk-cli；`--bg` → entrypoint=cli）|
| "现状 -p 就是最优" | 投降伪装成理性——operator否决 + vision-rescue 沉淀 |
| **fix = unset env var** | **错**。`buildChildEnv(null)` 早就正确 delete。fix = invocation flag 从 `-p` 迁 `--bg` |

**剩余不可证伪点**（必须 6/15 后 dashboard 或 Anthropic dev support 邮件 conclusive）：服务端实际计费桶按什么字段分类，客户端不可知。spec working hypothesis 走 **避开 `-p` flag + 用 `--bg` daemon → entrypoint=cli 客户端证据** 路径，但仍保留三档 fallback。

### Second Revision（21:00+，控制实验后再次反转）

继续 spike 跑了**两组对照实验**（worktree `cat-cafe-f198-env-unset-fix`）：

| 实验 | host env | buildChildEnv | flag | transcript entrypoint |
|------|---------|--------------|------|---------------------|
| 1 (`1343014a`) | `CLAUDE_CODE_ENTRYPOINT=sdk-cli` | null → delete | `-p` | **sdk-cli** ❌ |
| 2 (`649b89ba`) | 完全不设 | (无需 delete) | `-p` | **sdk-cli** ❌ |
| 之前 (`112e9a4e`) | 不设 | delete | `--bg` | **cli** ✅ |

**结论**：`-p` flag 本身让 claude binary 内部 set entrypoint=sdk-cli，**跟我们 cat-cafe 怎么处理 env 完全无关**。`buildChildEnv` 里的 `null → delete` 逻辑早就正确，cat-cafe 一直在正确 unset——但 claude binary 在 `-p` mode 自己设回 sdk-cli。

**之前 "delete env.X → cli +7" spike 的方法论错误**：那次同时切换了 env (delete) 和 flag (`-p` → `--bg`)，没控制变量。cli +7 是 `--bg` 给的，不是 delete 给的。

**真正分界（客户端层证据，Maine Coon P1：服务端 billing 仍 pending）**：
- `-p` flag → claude binary 自我 set entrypoint=sdk-cli（客户端字段）→ **最高概率** 6/15 后进 SDK 桶（待 dashboard/dev support conclusive 确认）
- `--bg` flag → entrypoint=cli（客户端字段）→ **最高概率** 6/15 后走订阅（同上待 confirm）

**不是 confirmed billing 结论**——客户端字段是间接信号，服务端实际计费规则只有 Anthropic 知道。spec 走 working hypothesis + 三档 fallback 兜底（Risk 表）。

**`ClaudeAgentService.ts:71` 的 `env.X = null` 不是 bug**——buildChildEnv 已经正确处理。这一行可以保留也可以删，**fix 不在这里**。

## Explicit Non-Carriers / Discarded Options

这些方案已评估，记录在此避免后续团队反复误判（Maine Coon P2 review 加入）：

| 方案 | 评估 | 为什么不是 carrier |
|------|------|---------------------|
| **MCP 反转桥的"外部不可见 polling 形态"** | 否决 | operator硬约束：失去 Hub oversight，"很危险也很奇怪"。**注意 ≠ 否决 MCP 工具链本身**——`cat_cafe_*` tools 在新 carrier 下仍保留 |
| **`claude mcp serve`** | 非 carrier，归类辅助能力 | 它暴露的是 Claude Code 自己的工具能力（View/Edit/LS）给**外部** MCP client；不把"Ragdoll这个 agent"作为可聊天载体暴露。可以做"让其他猫借用 Claude Code 工具表面"的辅助 |
| **`claude --ide` / IDE 扩展自动化** | 远期备选，不进 Phase A spike | accessibility API / WebDriver 路径脆弱、慢、不可维护；只有候选 1-4 全挂时考虑 |
| **claude.ai 浏览器自动化** | 否决 | 失去 CLI 所有能力（tools / skills / CLAUDE.md / MCP）；不是 Claude Code carrier，是 Claude chat 替身 |

## Bug #3: bg carrier 多轮失忆 — 双轮探索 + 会员卡方案（2026-06-03/04）

**问题**（OQ-7 / Phase D P1 #3）：`claude --bg` carrier 每轮失忆——daemon 每轮 fork 新 conversation UUID，无稳定"对话身份证"，导致 session_init seal+create 膨胀 + mutex re-lock race（云端 codex 3 轮 push back，证明 captured-id 是补锅）。两轮平行 spike（**context 隔离**：脏挖留在平行 thread，dense 结论 cross_post 回主 thread）收敛方案。

### 探索轮 1 — 金钥匙：固定 id 能否稳定 bg？→ **不能**
binary 2.1.161 逻辑 + 实测双证，三条固定 id 路径全堵：

| 路径 | 结果 | 证据 |
|------|------|------|
| `--bg --session-id <fixed>` | 被忽略 | binary warning `--bg manages the session id; ignoring --session-id`；dispatch `sessionId = _ ?? randomUUID()` 每轮随机 |
| `--bg --resume <fixed>` | **必 fork**（carrier 现状根因）| bg worker 是 long-lived live 进程，resume live id 撞 `already in use` → 强制注入 `--fork-session`；[实测] resume `53249ccc` → fork `7c77a04d`，原 session 仍 idle 活着 |
| `attach` 复用 idle worker | 需真 TTY，非交互废 | [实测] pipe stdin `echo prompt \| claude attach <short-id>` → "Migrating to PTY…" 即退、未注入 |

**关键反转**：[实测] fork **不丢记忆内容**（新 session 完整 seed 原历史，正确答出上轮 token）。真正丢的是 **id 接力链**——每轮 fork 新 id，carrier 须 id1→id2→id3 接力捕获，断链=丢，正是 codex 3 race 同源（都是"捕获 fork id"问题，不是 fork 丢历史）。
**武器**：`claude agents --json`（binary 标注 "does not require a TTY"）= 非交互确定性查最新 fork id，把 race-prone 的"解析 dispatch stdout 捕获 id"变成确定性查询。

### 探索轮 2 — Agent Team：原生能力能否解 carrier + 辩证对比
operator脑洞：`--bg`/`agents`/`attach` 本是 claude 原生 **Agent Team** 能力（binary 实证 `team leader`/`teammates`/`SendMessage`/`--spawn`/`--capacity`/`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`，experimental env-gated → 印证operator deliberate 没开）。三条候选：

- **`/fork`（"inherits the full conversation"）= 一次性快照**（fork-at-point 独立分支，主对话后续 turn 不灌入）→ **不解** carrier"每 turn 持续接上轮"
- **`-p --resume <fixed>` = 原地续写**（[实测] id 稳定不 fork、记忆续）**但 `-p` flag 本身触发 entrypoint=sdk-cli = 进 6/15 砍的 SDK 桶**（KD-9）→ **撞命门：治好失忆、得了绝症**，不可行
- **teammate + SendMessage = 持续接收**（消息 `{from,text,timestamp}` append 同 session）但 experimental + in-process，carrier 难直接用

**结论**：bg 固有 fork 无法绕过；唯一 id 稳定路（`-p`）撞 SDK 桶命门 → **会员卡 chainKey 是唯一可行路**。

### 辩证对比矩阵（claude 原生 Agent Team vs Cat Café A2A）

| 维度 | 原生 Agent Team | Cat Café | 取舍 |
|------|----------------|----------|------|
| @ 路由 | `^@([\w-]+)\s+(.+)$`（正则）| `^@句柄 内容` | **同构**——英雄所见略同，咱没白设计 |
| 球权 | 自由认领（claim unassigned，低 ID 先）| 第一人称 + 传球三选一 + 决策树 | **咱领先**（原生缺纪律 = 坐实"乱调会乱"）|
| 联邦 | 同进程/同机 Anthropic swarm | 跨 Opus/GPT/Gemini | **咱领先** |
| 持久 | `~/.claude/teams\|tasks/` 临时 dir，session 散即清 | 持久 thread + 记忆系统 + 人猫共享视图 | **咱领先** |
| L0 | 普通 coordination prompt | 压缩免疫 native system prompt | **咱领先** |
| status 消息 | **禁结构化 JSON、只 plain text** | rich block 结构化 | 相反取向，各有理 |
| **能学** | idle notification 自动上报 lead / claim-by-owner 认领顺序 / `--capacity` 并发上限 | — | 可纳入协作层但**保留球权护栏** |

### 方案：会员卡 chainKey（47 设计）
- `SessionRecord` 加 `chainKey`（`{threadId}:{catId}` 派生，同对话跨 daemon 不变）+ `latestResumeSessionId`
- bg session_init 用 chainKey 查 record → 找到 **update 不 seal+create**（解 record 膨胀 + 复用）
- bg done 用 chainKey 更新 `latestResumeSessionId` = 最新 fork id（`agents --json` 确定性查，非解析 stdout）
- mutex key 用 `{threadId}:{catId}:bg`（稳定跨 fork rotation，解 re-lock race）
- 其他 provider 走 cliSessionId 不变（隔离，不污染 -p/codex/gemini）
- Scope ~200-400 行 / 2-3 天；captured-id PR #2076 撤回（补锅，根因被 chainKey 根治）

> binary 2.1.161 / commit 6a550ae。两轮 spike 用 context 隔离（平行 opus-45 在 fork thread 挖、结论回主 thread）+ 全清理无残留 worker、production Redis (sacred)未触。

### ✅ 实施完成（opus-48, 2026-06-04, PR #2085 → `46625cf61`）
三层 RED→GREEN：**Store**（`SessionRecord` +`chainKey`(`bg:{threadId}:{catId}`)/+`latestResumeSessionId`；`getByChainKey` + chainKey index，in-memory + Redis；`AgentService.usesChainKeyResume?()` capability probe）/ **Consumer**（invoke-single-cat 6 处走 chainKey：sessionId 取 / mutex / session_init reuse / done / recordActive，`if/else` 隔离非 bg）/ **Carrier**（`--resume <uuid>` UUID guard + done emit `state.resumeSessionId`）。

**实施偏离 design doc（review 把关通过）**：① provider 判断改 `usesChainKeyResume?()` capability probe（`provider==='claude-bg'` 不可行——invoke 侧 `provider=clientId='anthropic'`，且 mutex/sessionId 区在 provider 定义前）② mutex key = chainKey 本身（`bg:{threadId}:{catId}`，语义等价 design 的 `{threadId}:{catId}:bg` 后缀式）③ **`agents --json` 降级 follow-up**（`state.resumeSessionId` daemon 直接写 state.json 是 spike 2026-06-03 实证的可靠确定性主路径，agents --json 冗余防御）。

**review**：Maine Coon（GPT-5.5）本地放行 + 云端 codex re-review（修 1 P1：sealed bg session 不复活——getByChainKey 不 filter status 是 write tolerance，但 resume/reuse 路径需 status check，boundary 对称化镜像非 bg）→ "no major issues"。测试：store in-memory 6 + Redis 5 + consumer 5 + carrier 5；回归 invoke 158/158 + redis 27/27 + pnpm gate ✅。

> ⏭️ **alpha 真实剧本（§9）+ AC-D5 record 数实证**待operator alpha 跑（需 `CAT_CAFE_CLAUDE_CARRIER=bg_daemon`）：6 轮 = 一条 record（messageCount=6）验证 chainKey 复用 + cancel invalidate-and-keep + sealed boundary。

## Acceptance Criteria

### Phase A（Spike + 决策）
- [ ] AC-A1: `claude --remote-control <name>` 启动成功 + 协议形态文档化（端口/socket/控制面）
- [ ] AC-A2: 验证 `--remote-control` 的 billing 桶归属。**可证伪性自检**（Maine Coon P1）：政策 6/15 才生效，Phase A 期间 dashboard 可能区分不出 `-p` vs RC — 若不能 conclusively 证实它走订阅，**默认 unsafe**，按"也进 SDK 桶"做 Phase B 规划；同时通过 Anthropic dev support / forum / sales rep 寻求 official 书面确认（书面回复算证据，承诺/截图/聊天记录算辅助）
- [ ] AC-A3: `claude agents` / `--brief` / tmux 兜底各做 1 次 spike，记录可行性 + 弃用理由
- [ ] AC-A4: Decision Packet 产出（主路径 + 兜底 + 弃用项 + 证据），Maine Coon review 通过 + operator签字

### Phase B（Carrier 集成 — Second revision 重写）

**Step 划分**（Maine Coon Phase B Step 2 Design Gate 2026-05-14 卡口）：
- **Step 1（已完成 2026-05-14, PR #1666）**：foundation `ClaudeBgCarrierService` + `JobEventConsumer` skeleton（state.json + timeline.jsonl + final output.result）。**这一步不切流量**，-p 仍是生产路径。
- **Step 2（进行中）**：**事件等价迁移 / Parity Gate**——不是直接 router wiring，而是恢复 `-p` 路径的完整 AgentMessage 语义（partial text / tool_use / system_info / usage），过 Parity Gate 后才允许 canary 切流量。

#### Step 1 ACs（foundation）
- [x] AC-B1: `ClaudeBgCarrierService` 实现，`claude --bg` 启动 + short id parse + AgentMessage 终态 yield（session_init / text / done）
- [x] AC-B2: invocation 用 `--bg` flag（不再 `-p` + `--output-format stream-json`）— foundation 层
- [x] AC-B3a: `JobEventConsumer` 消费 state.json（terminal state machine）+ timeline.jsonl（per-line guard）
- [x] AC-B5: spawn `cwd` 控制 worktree 隔离（默认不带 `--worktree`，state.json 实证 worktree=null）
- [x] AC-B7: `ClaudeAgentService(-p)` 保留为 fallback（共享 `buildClaudeEnvOverrides` / `resolveClaudeModelSelection` helper，单一真相源）

#### Step 2 ACs（Parity Gate — Maine Coon卡口 2026-05-14）🔴
- [x] **AC-B3b**: 新增 `BgTranscriptEventConsumer`——读 `state.linkScanPath` 指向的 transcript jsonl，把 Claude events 喂给 **复用的** `transformClaudeEvent` / `extractClaudeUsage`（synthetic result event via `extractTranscriptUsage`，真单一真相源）✅ PR #1669
- [x] **AC-B3c**: AgentMessage 语义等价覆盖（per-message streaming via file-tail）：
  - `session_init` ✅
  - `text`（per-message streaming via `TranscriptTailer`，per-token 不可能因 transcript 在 message_stop 才写）
  - `tool_use` ✅（Hub R2 硬约束达成）
  - `system_info`（实采 `turn_duration` ✅；`stop_hook_summary` skipped；thinking/rate_limit/compact 待真实样本出现再做）
  - `done` with `metadata.usage`（incremental `UsageAccumulator` — O(1) memory）✅
  - `error` ✅
- [x] **AC-B3d (Parity Gate)**: 8 golden parity tests + 7 tailer tests + 9 streaming integration tests（含 5 round 黑盒 hardening from Maine Coon + 5 round cloud codex P1/P2 fixes）✅ PR #1669
- [x] **AC-B3e (Alpha Smoke)**: 真实端到端 PASS PR #1672 — Bash tool_use + per-message text + done(usage) on real `--bg`
- [x] **AC-B4**: Cat Café MCP server 在 `--bg` 模式下 `cat_cafe_*` 工具可调用 — code 接通 PR #1672 + `--strict-mcp-config` flag PR #1674。**Alpha 端到端验证收尾 2026-05-15**：fresh daemon `77df0627` 全程 `needs: null`，`cat_cafe_search_evidence("F102 记忆系统")` 返回 3 条 anchor（F102 / cat-live-prep / llm-wiki），final text 透传给用户。**机制澄清**（推翻昨晚"需要 operator one-time approval"推测）：daemon non-TTY stdout + `--strict-mcp-config` + 显式 `--mcp-config` → CLI **不触发任何 approval prompt**（`--print` 文档已明示"workspace trust dialog skipped when stdout is not a TTY"，daemon 同样适用 + strict-mcp-config 短路 `.mcp.json` 发现路径）。**Canary 零操作员介入**：开 `CAT_CAFE_CLAUDE_CARRIER=bg_daemon` 即用，无需任何 attach/批准步骤
- [x] **AC-B6**: 真实 transcript `entrypoint=cli` PASS PR #1672（客户端层订阅证据）；服务端 billing 仍 pending dashboard
- [x] **AC-B8 (Canary Gate)**: env-gated factory `CAT_CAFE_CLAUDE_CARRIER` wired PR #1672。Default unset → `-p` 仍是Ragdoll生产路径；opt-in `bg_daemon` → ClaudeBgCarrierService。Canary cohort selection criteria 待 Step 4 + Phase D。

### Phase C（Hub Oversight — operator硬约束）

> **Scope 拍板（operator 2026-05-15 03:25）**：选 A — 完整 6 AC 单 PR 闭环（不切片），估 800-1500 行。
>
> **Audit baseline（2026-05-15）**：今天 bg_daemon 模式下operator在猫咖能看到：text 气泡 / tool_use / tool_result / error / `ThreadCatStatus` 的 idle/working/done/error 状态点 / Hub workspace 已有的 F089 `AgentPaneViewer` tmux pane（read-only 流）。看不到：daemon `state.json.detail` 实时进度、pane↔thread invocation 联动、active sessions/process tree/quota deep-dive、thread→pane 接管入口、status dot tooltip detail。

**实施 5 件事 → AC 映射**：

| # | 实施项 | 关联 AC | 现状 → 改动 |
|---|--------|---------|-------------|
| 1 | daemon `state.detail` 进 AgentMessage stream | AC-C2 | `ClaudeBgCarrierService.ts:195` 现只在 error 时读 detail → 改成 working 期间也定期 yield `status` message |
| 2 | tmux pane ↔ thread invocation 联动 | AC-C1 | `AgentPaneViewer` 现独立 → pane URL 注入 invocationId/catId metadata，thread 能看到"当前 pane 在跑哪个 invocation" |
| 3 | Deep-dive 视图（新页面）| AC-C4 | 新建 `/agent-sessions` 路由：active sessions 列表 + per-session detail + 累计 token / 进程树 |
| 4 | Thread 气泡上"接管"按钮 | AC-C5 | `ChatMessage` 加 takeover 入口 → 路由到 F089 pane read-write 模式 |
| 5 | Status dot tooltip 加 detail | AC-C3 | `ThreadCatStatus` hover 时显示 `state.detail` 文本 |

- [x] AC-C1: F089 tmux agent pane 在 Hub 内可观看（read-only）+ 显示当前 invocation metadata
- [x] AC-C2: thread UI 实时显示 tool call / tool result / partial text + daemon detail status（与 -p 模式 NDJSON 信息密度等价或更高）
- [x] AC-C3: cat avatar status dot 实时反映 session 状态（idle/working/waiting/error/detached）+ tooltip 显示 detail
- [x] AC-C4: deep dive 视图：可看 active sessions / process tree / 累计消耗
- [x] AC-C5: 接管按钮可用，read-write 切换正确（F089 既定能力扩展）
- [x] AC-C6: 跨猫愿景守护（Maine Coon + Siamese/Siamese）认证"oversight 信息密度 ≥ -p 模式"（@codex ✅ REVIEW PASS + @opus-47 ✅ 愿景守护 APPROVE — runtime 数据流全链路 trace 验证，信息密度严格超过 -p）

### Phase D（兜底 + 切流量）

> **实证缺口（2026-05-19 F203 alpha canary flip 撞出 3 个 production-gap，promote 为 Phase D P1）**：
>
> | # | 现象 | spec 之前状态 | 处理 |
> |---|------|--------------|------|
> | 1 | BgCarrier 缺 `--permission-mode bypassPermissions` → 每个 tool call 在 detached daemon TTY 弹 prompt → web UI 看不见，session 整个卡死 | 之前 OQ 没明列，alpha smoke 漏覆盖 | ✅ **Fixed PR #1785 (`6e1adbbbe` 2026-05-20)** — bg carrier --permission-mode bypassPermissions parity with -p |
> | 2 | `state.json` 永久卡 `working`（MCP 工具调用后 daemon 不更新 state）→ UI 永远"正在回复"卡死；`JobState` 缺 `failed/blocked/stopped` 枚举 | **OQ-12** `--bg cancel/interrupt 语义` 已标 ⬜ Phase B spike，**没真关** | ✅ **Fixed PR #1798 (`281349e15` 2026-05-20)** — transcript `turn_duration` backup 终止信号 + 补全 state 枚举 |
> | 3 | cancel 后新消息**新建 session 不 resume**（carrier 从未实现 `--resume`，存 daemon shortId 非 conversation UUID） | **OQ-7** `Interactive session resume 语义` 已标 ⬜ Phase B spike，**没真关** | ⬜ **Deferred** — separate PR，详见 bug-report §4.2 |
>
> 实证教训：Phase B/C "alpha-validated ✅ canary 零操作员介入" = alpha **单 happy-path 跑通**，**production 真用浮的 gap 全被 alpha smoke 漏过**。"切流量"前必须先 hardening 这些 gap，否则 6/15 cutover 真翻 = 全员协作链路断。来源：F203-47（跨 thread）→ F198-47（本 spec owner，同一 model 不同 invocation）2026-05-19 投诉。

- [x] AC-D1: 三档 fallback 实现 + 自动触发逻辑（quota 超限 / carrier 挂掉）— PR #2257 merged 2026-06-12: carrier health state machine (`CarrierHealthStore` + `classifyCarrierFailure` + `selectFirstHealthyTier`) + `FallbackCarrierWrapper` in factory; degradation chain `bg_daemon → interactive_pty → print_sdk → api_key`; failure classes: quota (4h TTL) / structural (30min) / transient (3 consecutive → structural upgrade); api_key guard pending PR-2 auth differentiation
- [ ] AC-D2: 预算治理面板 + 告警阈值生效
- [ ] AC-D3: 灰度切流量 10% → 50% → 100%，每档观察期内无 P0/P1 regression
- [ ] AC-D4: 6/15 前所有 thread 默认 `bg_daemon`
- [ ] **AC-D5 (新 2026-06-03)**: bg session chain pointer 化（不阻塞 Bug #3 / D3 灰度）— bg carrier 每个 `--bg` invocation 必然新 daemon shortId（spike 实证 `d061424f → 61a48e5b → a56e3aa4`），触发 `session_init` handler 的 "CLI session changed → seal+create" 路径，**每轮 bg invoke 产生 1 sealed + 1 new active record**。conversation 内容通过 `--resume UUID` 接力正确，session chain hygiene 退化：recall/digest pipeline 看到的是多条 sealed record 而非一条连续 conversation。**理想终态**：bg 走 chain-pointer (next-record) 而非 seal-and-create，一条 conversation = 一条 record。**为何 defer**：实施碰 session_init handler + provider-aware 分支 + recall/digest pipeline，远超 Bug #3 PR scope；conversation 正确性不受影响（仅 hygiene 退化）。**verdict gate**：愿景守护三审 alpha 真实剧本要 inspect 跑完 3 轮后 sessionChainStore 实际 record 数，记入 Bug #3 PR 回写作为本 AC 优先级实证。发现来源：Bug #3 实施（opus-48）+ 架构评议（opus-47 2026-06-03）。**→ 2026-06-04 update（PR #2085）**：Bug #3 chainKey 实施**已实现 chain-pointer 终态**——bg session_init 用 chainKey 复用一条 record（不 seal+create），一条 conversation = 一条 record，hygiene 不再退化。record 数实证（6 轮 = 1 record，messageCount=6）+ recall/digest pipeline 验证待operator alpha 跑（§9 剧本）后再勾此 AC

- [x] **AC-D6 (新 2026-06-10, Fable-5 提议 + 47 接 owner)**: **Plan B spike — PTY interactive + transcript tail 第四档 carrier**（不全量实施，只出图纸 + go/no-go）。详见 KD-12 风险对冲论证。Spike scope (1 天 worktree 隔离)：① PTY 注入 prompt 长度可靠性（bracketed-paste）② session id 捕获时机（interactive 第一次 system_info 时？） ③ interactive `--resume` 语义实测（fork 还是真接力？— 与 `--bg --resume` 强制 fork 对照）。**Spike 退出条件**：1-2 天出 go/no-go 写进 spec 当应急预案；6/15 后 dashboard 一旦判 `--bg` 进 SDK 桶（OQ-13 证伪 KD-10），立即有现成图纸 fast-track 实施。**owner**: Fable-5（新猫第一仗，spike 不碰 production code）。**→ 2026-06-10 升格 F230**（operator 令收敛完整 plan：本 spike = F230 Phase A，Phase B+ 实施 gated standby；双通道详细设计 / 激活 Gate / 流水线分工见 `F230-claude-interactive-pty-carrier.md`）

### Phase E（观察）
- [ ] AC-E1: 6/15 后 1 周Ragdoll daily invocation 数 ≥ 6/15 前 7 日平均的 80%
- [ ] AC-E2: 无 P0/P1 regression，无 oversight 缺口投诉
- [ ] AC-E3: 反思胶囊 + harness-feedback 落档（F086 M3 + F192）
- [ ] AC-E4 (新 2026-06-10): **6/15 当天盯 dashboard 关 OQ-13** — Anthropic 服务端账单 / usage 仪表盘对 `--bg` 的桶归属判罚是本 feat 唯一 conclusive 证据。判进订阅桶 → `--bg` 主路径成立；判进 SDK 桶 → Plan B (AC-D6→F230) fast-track + 主路径降级。**2026-06-12 注记**：dev support 邮件除问桶归属外，捎带问 ① 自动化驱动 interactive 的 TOS 边界 ② **2.1.172+ interactive TUI 停写 transcript 是 bug 还是收紧前兆**（F230 OQ-9，影响备胎长期形态判断）

## Dependencies

- **Related**: F089 (Hub Terminal & tmux — 复用 agent pane infra，oversight 主要 surface)
- **Related**: F143 (Hostable Agent Runtime — 新 carrier 是 F143 ProcessModel 的 interactive subscription 子类型；本 feat 实施反向给 F143 提供具体载体证据)
- **Related**: F149 (ACP Runtime Operations — 进程池 / lease / lifecycle / idle TTL 模式直接借鉴)
- **Related**: F050 (External Agent Onboarding — carrier 抽象层)

## Architecture Cell

- **Architecture cell**: F143 Hostable Agent Runtime（agent invocation 域）
- **Map delta**: **update required** — F143 ProcessModel 增加 `bg_daemon` 分类；Provider 适配层新增 `ClaudeBgCarrierService`，与现有 `ClaudeAgentService(-p)` 平级
- **Why**: 这不是 net new 架构，是现有 carrier 域里增加新载体类型；F143 ownership map 需要更新认知"`--bg` daemon carrier 是和 `-p print mode / api_key` 平级的第三种 carrier 模式"。Anthropic 官方 Agent View（v2.1.139+）暴露 daemon supervisor + jsonl 事件流接口，我们消费这套契约，不重新发明。

## Eval / Tracking Contract

**触发**：✅（harness-level carrier 改造，影响所有 Claude/Ragdoll调用路径）

1. **Primary Users + Activation Signal**：
   - Primary: 三猫（Opus, GPT-5.x, Gemini）—— 本 feat 影响面 = Ragdoll家族全部调用 + 间接影响Maine Coon/Siamese与Ragdoll协作
   - Secondary: operator（observer / 接管者）
   - Activation Signal: 6/15 后 7 天内Ragdoll thread invocation 成功率 + Hub oversight 事件流完整率

2. **Friction Metric**：
   - Ragdoll daily invocation 次数（baseline = 6/15 前 7 日平均）
   - oversight 缺口数（Hub 看不到的事件 = friction，operator投诉次数）
   - failed fallback 次数（三档全失败 = 严重 friction）
   - interactive session cold start 时长 P95

3. **Regression Fixture**（≥ 3 条）：
   - 短问答（< 5 turn 简单回复）
   - 长 review（含 LSP / 大文件读取 / 跨包搜索）
   - 跨猫协作（Cat Café MCP tool 调用 ≥ 5 次）
   - hold_ball + 异步唤醒（外部事件回调）
   - 接管场景（operator read-write 切换 + 接管后Ragdoll能继续）

4. **Sunset Signal**：
   - Anthropic 政策再变（撤销 SDK credit 桶 / interactive 走同一额度 / 堵 `--bg` daemon mode）→ 重新评估
   - Interactive carrier 实测总成本（运营复杂度 + Hub 改造 + 监控）> SDK credit operational cost + API fallback 的总和 → 回归 -p 模式（3 个月观察期后评估）

## Risk

| 风险 | 缓解 |
|------|------|
| ~~`--remote-control` 实际也走 SDK 桶~~ → **obsolete**：RC 不是主路径（KD-6 撤回） | (历史风险) |
| **`--bg` daemon 的服务端 billing 桶不可证伪**（客户端 entrypoint=cli 是间接信号；6/15 dashboard 才能 confirm） | 默认 unsafe + Anthropic dev support 邮件 + Phase D 三档 fallback 兜底；spec 不允许把 working hypothesis 写成 confirmed |
| **`--bg` 模式下 MCP 行为变化**（cat_cafe_* tools 在 daemon 模式下是否还能通过 `--mcp-config` 注入？）| Phase B prototype AC-B4 必须实测 |
| **Cat Café feat worktree × `claude --bg` job cwd 行为**（OQ-10）| 默认不带 `--worktree`（CLI flag opt-in 已实证）+ Node spawn `cwd` 控制 job 工作目录；Phase B prototype 验证写文件 / hooks / git status 行为 |
| **`--bg` prompt 长度 ARG_MAX 风险**（system prompt + thread context + RAG 拼起来可能超）| Phase B prototype 实测；超限则改用 stdin pipe 喂 prompt（待 OQ-11 决策）|
| **`--bg` 模式 cancel/interrupt 语义不明**（thread 切换 / 用户取消需要 stop job）| Phase B 设计 `claude stop <short>` + SIGTERM 兜底 |
| Interactive session 启动慢（5-15s）冷启动差 | Agent View 内置 `--bg-spare` warm pool（暖池预启动）；首次冷启动 UX 加 loading state |
| **Anthropic TOS 灰色**（自动化 Claude Code 是否合规）| 优先官方接口（`claude --bg` Agent View v2.1.139+ 是 Anthropic 官方设计的程序化 carrier），不走"模拟键盘"路径；公开使用 with subscription 范围 |
| Oversight 在 `--bg` 模式下信息密度不如 -p 的 NDJSON | Phase C 专门补（tail timeline.jsonl + transcript.jsonl + read state.json）；跨猫愿景守护是 AC-C6 硬门禁，不通过不放行 |
| 6/15 来不及 | Phase B 实施有 hard deadline；不通则 Phase D 兜底（预算治理 + 三档 fallback）先上保命 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | MCP 反转桥的"**外部不可见 polling 形态**"被否决；Cat Café MCP 工具链（`cat_cafe_*` tools）本身在新 carrier 下仍是必需能力 | operator否决的是"失去对你进度和在干嘛的掌控"——失控来自外部终端 poll 不可见，不是 MCP 工具链；新 carrier 必须保留 MCP 工具供Ragdoll调用（Maine Coon P2 精确化） | 2026-05-13 |
| KD-2 | `--remote-control` 优先于 tmux 包裹 | 官方接口 vs 模拟键盘；合规 vs 灰色；维护成本低 vs 解析脆弱 | 2026-05-13 |
| KD-3 | 保留 `-p` 路径作为 SDK credit fallback，不删 | 三档 fallback 保命；Anthropic 政策变动时可回退 | 2026-05-13 |
| KD-4 | Phase A spike 5 天 hard deadline | 6/15 拐点不可推迟；不通则 Phase D 兜底先上保命 | 2026-05-13 |
| KD-5 | Oversight 不弱于 -p 模式 = AC-C6 硬门禁 | operator硬约束；MCP 反转桥被否决的同一逻辑 | 2026-05-13 |
| KD-6 | **撤回 KD-2**：`--remote-control` 不优先于 tmux interactive | Phase A spike 证伪：RC 跟 -p 同样 entrypoint=sdk-cli；46 strings binary 找到真实判定逻辑（entrypoint 由 env var 决定，与 flag 无关）| 2026-05-13 |
| KD-7 | **真正金钥匙**：在 spawn claude 时**真正 unset `CLAUDE_CODE_ENTRYPOINT`**（让 entrypoint=cli）+ **避开 `-p` flag**（让 isInteractive=true）| 46 strings binary 找到判定代码：`if (env.CLAUDE_CODE_ENTRYPOINT === "sdk-cli") return "sdk-cli"; ... return "cli"`。47 spike 实测：`env -u CLAUDE_CODE_ENTRYPOINT claude --bg "..."` → cli +7（整晚第一次非零增量） | 2026-05-13 |
| KD-8 | ~~`ClaudeAgentService.ts:71` 的 `env.X = null` 有 bug~~ **撤回** | Second revision 控制实验证伪：`buildChildEnv` 内部 `if (null) delete merged[key]` 已经正确处理；transcript 仍是 sdk-cli 不是因为 env，是因为 `-p` flag 本身让 binary 自我 set | 2026-05-13（撤回 2026-05-13 21:00+）|
| KD-9 | **真正决定性信号是 `-p` flag，不是 env var** | 两组控制实验（host env 设/不设 + buildChildEnv delete）+ `-p` 全部产出 entrypoint=sdk-cli；之前 cli +7 是 `--bg` 给的不是 delete 给的（spike 方法论错：没控制变量）| 2026-05-13 21:00+ |
| KD-10 | **真正 fix 是 invocation 从 `-p` 迁到 `--bg`**（整体 carrier 改造，不是 2 行 env fix） | 配合官方 Agent View daemon（state.json + timeline.jsonl + transcript.jsonl 消费）+ 移除 stream-json stdout 解析 | 2026-05-13 21:00+ |
| KD-11 | **Bug #3（bg 多轮失忆）方案 = 会员卡 chainKey**（非 captured-id 补锅、非 `-p --resume`）| 双轮平行 spike：`--bg` 固有 fork 无法用固定 id 绕过；唯一 id 稳定路 `-p --resume` 撞 SDK 桶命门（`-p`=sdk-cli，KD-9）；原生 Agent Team（`/fork` 一次性快照、teammate experimental in-process）不适配 carrier。chainKey（`{threadId}:{catId}` 稳定锚点）+ `agents --json` 确定性查 fork id 根治 codex 3 race | 2026-06-04 |
| KD-12 | **Plan B = PTY interactive + transcript tail（第四档 carrier，与 `--bg` 形成 billing/合规风险对冲）** | bg carrier 已是 F210/F211 sidecar tail 哲学（不走 stdout，走 `state.json` + `<sessionId>.jsonl` transcript）→ "输出通道"上 F198 不输 F210/F211。真命门 = **OQ-13 服务端计费桶归属 6/15 前不可证伪**：bg 赌"entrypoint=cli → 订阅桶"（客户端间接信号）vs PTY 赌"交互式 Claude Code 仍走订阅"（Anthropic 明文保护）—— **不同硬币面**。输出层 100% 复用（`TranscriptTailer` 纯函数对 `--bg` 零耦合），增量仅在**输入面**（PTY 注入 prompt + session id 捕获时机 + interactive `--resume` 语义可能不像 bg 强制 fork，需实测）。Fable-5 论证 + 47 接 KD owner | 2026-06-10 |
| KD-13 | **Anthropic 延期政策变更 → feat on-hold，代码全量保留** | 2026-06-15 当天 Anthropic 邮件："We're not making this change today." SDK credit 拐点未生效。OQ-13 自行消解（不是证实也不是证伪，是被取消了）。operator 指示保留全部代码和决策——"没准未来你家猫舍又抽风我们就能继续用"。Phase D 剩余 + Phase E 暂停；已交付资产（bg carrier + health state machine + oversight + chainKey + interactive PTY + hook sidechannel）原样保留在 main，零成本待命 | 2026-06-15 |

## Review Gate

- **Phase A**: Maine Coon（GPT-5.5）review Decision Packet（carrier 选型 + 证据完整性）+ operator签字（policy 判断需 operator）
- **Phase B**: Maine Coon review 实施（安全/测试/可回滚）+ 跨猫愿景守护（Siamese/Siamese）
- **Phase C**: **跨猫愿景守护强制**（oversight 是operator硬约束）+ operator亲自验"我能看到Ragdoll在干嘛吗"
- **Phase D**: Maine Coon review 预算治理 + 三档 fallback 完整性；operator验灰度切流量
- **Phase E**: 自动监控 + 周报；3 个月评估期收尾

## 需求点 Checklist

| # | 需求 | 来源 | 验收 |
|---|------|------|------|
| R1 | 6/15 后Ragdoll不进 operational cost SDK 桶（除非 fallback 触发） | operator experience"拯救Ragdoll" + 公告 | AC-A2 + AC-D4 |
| R2 | Hub 内可实时看到Ragdoll在干嘛 | operator experience"失去对你进度和在干嘛的掌控，很危险也很奇怪" | AC-C1~C5 + AC-C6 跨猫守护 |
| R3 | 多档 fallback 保命，不会某天突然没Ragdoll用 | operator"你不能没有Maine Coon Maine Coon不能没有你" | AC-D1 三档 fallback + AC-A4 决策含兜底 |
| R4 | 不影响Maine Coon / Siamese / 其他猫的调用路径 | 团队稳定性 | Phase B/C 只改 Claude provider 边界，其他 provider 不动 |
| R5 | Cat Café MCP 工具仍能在 carrier 下使用 | 现有协作链路 | AC-B4 |
