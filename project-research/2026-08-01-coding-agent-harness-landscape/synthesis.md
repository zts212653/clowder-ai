---
feature_ids: []
topics: [coding-agent, harness, open-source, landscape]
doc_kind: research_synthesis
created: 2026-08-01
---

# Coding Agent Harness 开源生态调研

> 数据快照：2026-08-01 15:00（UTC+8）  
> 作者：砚砚 / GPT-5.6  
> 证据口径：Stars、forks、归档状态取 GitHub Repository API；能力与许可证取官方 README、文档和 LICENSE。Stars 只表示关注度，不表示质量。

## 一、先说结论

用户列出的 Claude Code、Codex、Gemini CLI、Hermes Agent、Kimi、OpenCode、AGY、Pi 之外，至少还有八个不能漏掉的主流坐标：

- **Aider**：成熟的 Git-first 终端结对编程基线。
- **Cline**：IDE + CLI + SDK + checkpoint/approval 的人在环代表。
- **OpenHands**：已演进成自托管 agent control center，可运行本体或外部 ACP agent。
- **Goose**：Linux Foundation / AAIF 体系下的多 provider、MCP 扩展型通用 agent。
- **Qwen Code**：当前开源终端 harness 中能力面最完整的一组，覆盖 memory、skills、subagents、agent teams、daemon 和 SDK。
- **SWE-agent / mini-SWE-agent**：GitHub issue → patch 的研究、评测和批处理基线。
- **Crush**：LSP + MCP + 多模型的优秀终端交互参考，但当前是 FSL source-available，不是 OSI 开源。
- **Mistral Vibe**：小而完整的新一代 CLI，适合读源码理解 skills/MCP/subagent/approval 的最小组合。

另有一个快速成形的“harness 之上的 harness”层：**OpenAI Symphony、Orca、Emdash、Vibe Kanban**。它们不重做 agent loop，而是把 Claude Code/Codex/OpenCode/Pi 等放进 worktree、任务板和长期运行环境中并行管理。对于 Clowder AI，这一层比再找一个单 agent CLI 更值得比较。

## 二、口径：什么算 harness

本报告把 harness 定义为承载以下循环的执行系统：

```text
模型决策 -> 工具调用 -> 环境产生反馈 -> 更新上下文/状态 -> 下一步决策
```

比较维度采用 ETCLOVG 的工程含义：Execution、Tooling、Context、Lifecycle、Observability、Verification、Governance，并额外关注多 agent 协作。纯模型、纯补全插件、MCP server、memory 插件、benchmark 和只做 PR review 的 SaaS 不进入主榜。

## 三、主流 harness 本体

| 项目 | Stars | 开放性 | 产品形态 | 最突出的能力 | 主要优势 | 主要短板 |
|---|---:|---|---|---|---|---|
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | 223,534 | MIT | CLI + 消息网关 + 多后端 | 记忆、自建 skill、subagent、7 类 sandbox/remote backend、trajectory | 最接近“个人长期 agent runtime”，多 provider 且跨消息平台 | 能力面很宽，复杂度和攻击面高于 coding-only CLI；需实测编码专精与治理边界 |
| [OpenCode](https://github.com/anomalyco/opencode) | 191,777 | MIT | TUI + Desktop + client/server | 多 provider、permission、agent/plugin/MCP 生态 | provider-agnostic、实现可审计、嵌入和二次开发面好 | 迭代极快；旧同名仓库已归档，生态插件质量参差，版本迁移成本高 |
| [Claude Code](https://github.com/anthropics/claude-code) | 139,855 | **专有** | CLI + IDE + GitHub | hooks、skills、subagents、MCP、强工具使用 | Claude 模型与 harness 共设计，产品成熟度和默认效果强 | 仓库 LICENSE 是 Anthropic 商业条款；核心不可自由修改，provider lock-in 强 |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | 106,292 | Apache-2.0 | CLI | 1M context、Google Search、内置工具、MCP | 一方模型 + 开源 harness；长上下文与 Google 工具整合 | Gemini-first；多 provider 与跨模型编排不是核心目标 |
| [Codex CLI](https://github.com/openai/codex) | 102,980 | Apache-2.0 | CLI + IDE/App | Rust 本地 runtime、sandbox/approval、headless/自动化接口 | 开源核心、执行边界清晰、OpenAI 模型与工程 loop 紧密结合 | OpenAI-first；跨 provider 和长期团队协作不是默认抽象 |
| [Pi](https://github.com/earendil-works/pi) | 81,616 | MIT | toolkit + coding CLI + TUI | 统一 LLM API、agent loop、TUI 库、扩展 | 最适合读源码、嵌入和定制；库边界清楚，少 opinion | **默认没有权限系统或 sandbox**，直接继承启动用户权限；安全需外置 |
| [Cline](https://github.com/cline/cline) | 65,356 | Apache-2.0 | VS Code + CLI + SDK | checkpoint、diff、approval、rules/skills、headless、多 agent SDK | 人在环和可回退体验强；同一 core 覆盖 IDE/CLI/SDK | IDE 产品面较重；JetBrains plugin 不开源；大任务 token/交互开销偏高 |
| [Goose](https://github.com/aaif-goose/goose) | 52,043 | Apache-2.0 | Desktop + CLI + API | 15+ provider、70+ MCP extension、自定义发行版 | 中立、多 provider、跨桌面/终端/API，基金会治理信号较好 | 更像通用本地 agent；代码库治理、Git 工作流和验证策略不如 coding-only 工具鲜明 |
| [Aider](https://github.com/Aider-AI/aider) | 47,848 | Apache-2.0 | CLI | repo map、Git 自动提交、多模型 | 成熟、简单、Git 原生；是检验“复杂 harness 是否真有增益”的好基线 | 以 pair programming 为中心，缺少多 agent、durable lifecycle 和控制面 |
| [Qwen Code](https://github.com/QwenLM/qwen-code) | 26,486 | Apache-2.0 | CLI + IDE + Desktop + daemon + SDK | auto-memory、auto-skills、subagents、teams、MCP、多协议 | 开放能力面最全；本地模型和多协议友好，适合研究一体化 harness | 功能增长快，成熟度和边界稳定性需持续验证；官方“全面 parity”属于 vendor claim |
| [Kilo Code](https://github.com/Kilo-Org/kilocode) | 26,654 | MIT | IDE + CLI | 多模型、浏览器、MCP marketplace | 多入口、模型选择广、生态产品化较完整 | CLI 明确 fork 自 OpenCode；差异化与上游同步成本需持续审视 |
| [Crush](https://github.com/charmbracelet/crush) | 26,994 | **FSL-1.1-MIT** | CLI/TUI | 多模型、session、LSP、MCP | 终端 UX 和 LSP 上下文值得拆解；跨平台好 | 快照时不是 OSI 开源，竞争用途受限；不是团队级控制面 |
| [Kimi Code](https://github.com/MoonshotAI/kimi-code) | 5,847 | MIT | CLI + ACP | video input、MCP marketplace、subagents、hooks、ACP | 新架构能力集中，hook/ACP/多模态值得跟踪 | 2026-05 才建仓，仍年轻；旧 `kimi-cli` 正在迁移，生态存在切换成本 |
| [Mistral Vibe](https://github.com/mistralai/mistral-vibe) | 4,768 | Apache-2.0 | CLI | skills、MCP、subagents、session、approval | 比大而全项目更适合研究最小可用 agent loop | 项目年轻、生态小、默认模型栈偏 Mistral |

### 必须纠正的名称与开放性

1. **Pi**：请求 `badlogic/pi-mono` 时 GitHub API 已重定向到 `earendil-works/pi`。应使用新坐标，快照为 81,616 Stars。
2. **Kimi**：`MoonshotAI/kimi-cli` 有 11,056 Stars，但 README 已声明逐步退场；当前主线是 MIT 的 `MoonshotAI/kimi-code`（5,847 Stars）。
3. **OpenCode**：现行是 `anomalyco/opencode`（191,777）；`opencode-ai/opencode`（13,600）是已归档旧项目，不能相加。
4. **Roo Code**：`RooCodeInc/Roo-Code`（24,364）在快照时已归档，放入历史参考，不列活跃推荐。
5. **Continue**：GitHub API 的 `archived=false` 容易误导；README 明确写“no longer actively maintained and read-only”，35,248 Stars 只能作为历史基线。
6. **Claude Code**：GitHub 仓库有 README、插件、示例和 issue，但 LICENSE 是“all rights reserved + commercial terms”，不是开源核心。
7. **AGY / Antigravity CLI**：本轮未找到 Google 发布的核心源码仓库；GitHub 上主要是第三方 bridge/plugin。其 Stars 应记 `N/A`，归为专有外部 harness，而不是“GitHub 开源项目”。
8. **GitHub Copilot CLI**：11,038 Stars，但许可证禁止修改/衍生，属于 source-available 商业工具。

## 四、任务型与平台型 harness

| 项目 | Stars | 定位 | 强项 | 边界/风险 |
|---|---:|---|---|---|
| [OpenHands](https://github.com/OpenHands/OpenHands) | 82,740 | 自托管 Agent Canvas / control center | Docker/VM/云后端、自动化、任意 LLM、ACP 外部 agent、多 Agent Server | 当前仓库产品重心已从“单一 agent”转成平台；不应拿它与 Aider 比单次 CLI 体验 |
| [SWE-agent](https://github.com/SWE-agent/SWE-agent) | 19,971 | issue-to-patch 研究 harness | 可复现实验、工具接口研究、批量 issue 修复 | 团队把主要开发转向 mini-swe-agent；交互式日常开发不是核心 |
| [mini-SWE-agent](https://github.com/SWE-agent/mini-swe-agent) | 6,169 | 极简任务 harness | 代码量小、易审计、适合作为研究/回归基线 | 产品能力和治理面刻意很薄；README benchmark claim 需独立复验 |
| [Plandex](https://github.com/plandex-ai/plandex) | 15,557 | 大任务计划与 diff sandbox | 大上下文、plan versioning、累积 diff 隔离、多模型 | 最近 push 为 2025-10-03，活跃度是明显风险 |

### 商业/专有但不能忽略的市场坐标

| 产品 | GitHub Stars 口径 | 主要形态 | 本报告处理 |
|---|---|---|---|
| Cursor / Windsurf | N/A | Agentic IDE | 市场主流，但核心闭源；只作产品体验和 IDE integration 对照 |
| Amp / Devin / Auggie / Factory Droid | N/A | CLI、云端 agent 或混合工作台 | 适合比较自治任务、远程执行和 proof-of-work，不进入开源源码榜 |
| Kiro | N/A | Spec-driven IDE/CLI | 可比较 spec → task → implementation 工作流，不能做开源底座 |
| AGY / Google Antigravity CLI | N/A | 专有 CLI/IDE runtime | 可做 provider adapter；本轮未定位官方核心源码仓库 |
| GitHub Copilot CLI | 11,038 | 专有 CLI | 仓库公开但许可证禁止修改和衍生，不算开源 |
| Claude Code | 139,855 | 专有 CLI/IDE runtime | 因市场影响力保留在主表，但开放性明确标红 |

## 五、上层编排器：对 Clowder AI 更有价值的对照组

| 项目 | Stars | 复用哪些 agent | 可学习点 | 不足 |
|---|---:|---|---|---|
| [Orca](https://github.com/stablyai/orca) | 34,798 | Codex、Claude Code、OpenCode、Pi 等 | 一 prompt 多 worktree、桌面/移动/SSH、统一 review | 新项目；更偏个人 ADE，持久身份、知识和跨模型互审不是核心 |
| [OpenAI Symphony](https://github.com/openai/symphony) | 26,360 | 主要 Codex | 从任务板生成隔离实现 run，收集 CI/PR/复杂度/视频 proof of work | provider 倾向明显；协作语义仍以 task-run 为主 |
| [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) | 27,607 | 多种 CLI agent | 任务可视化、并行 run、agent 外置 | 主要是管理面，底层可靠性继承各 CLI |
| [Emdash](https://github.com/generalaction/emdash) | 5,315 | 多种 CLI agent | 每任务 worktree、并行、SSH remote | 仍年轻；治理、memory、review contract 较薄 |

这个层面的共同趋势是：**不再试图造一个“万能 agent”，而是把现有 CLI 当 provider/runtime，用 worktree、任务状态和证据来编排。** 这与 Clowder AI 的 provider adapter + thread/task/worktree 方向更同构。

## 六、能力判断

### 最值得拆源码的五组

1. **OpenCode**：看 provider-neutral client/server、插件和 MCP 生态如何组合。
2. **Pi**：看最小 agent loop、统一 LLM API、TUI 与可嵌入 package 边界；同时把“无内置权限”当反例。
3. **Qwen Code**：看 memory/skills/subagents/teams/daemon/SDK 如何落在一套开源代码中，但要警惕功能堆叠。
4. **Cline**：看 checkpoint、human approval、diff/revert 与 shared core 的产品化。
5. **OpenHands + Symphony/Orca**：看 agent backend 与控制面解耦、隔离执行、proof-of-work 汇总。

### 适合做基线而不是照搬

- **Aider**：复杂方案必须证明比 repo map + Git + 单 loop 更好。
- **mini-SWE-agent**：用极简可复现实验检验工具设计，而不是追 UI feature。
- **Claude Code / Codex / Gemini CLI**：适合作为 frontier runtime 行为基线；其中只有 Codex/Gemini core 是明确开源许可。

### 暂不建议作为核心依赖

- **Continue、Roo Code、旧 Kimi CLI**：已进入停止维护、归档或迁移状态。
- **Crush**：技术可学，但许可证不适合默认当可自由 fork 的基础。
- **AGY、Claude Code、Copilot CLI**：可做 provider adapter，不应被视为可审计/可掌控的开源底座。
- **Plandex**：设计值得读，活跃度需先确认再投入集成。

### 继续观察的新项目

- **Grok Build**（23,730，Apache-2.0）：2026-07 才建仓，已公开 Rust TUI、MCP、skills、plugins、hooks、headless 和 sandbox 面；Stars 高但历史太短，当前更适合观察而非据此判断成熟度。
- **gptme**（4,373，MIT）：持久终端 agent 和 session/tool 设计清晰，规模小但适合源码阅读。
- **Amazon Q Developer CLI**（1,982，Apache-2.0）：AWS 工具链和企业身份整合有参考价值，跨 provider 不是重点。
- **Open Interpreter**（67,482，Apache-2.0）：已转向更通用的 computer/coding agent，可用于比较本地计算机操作，不是 coding-only 主榜的直接同类。

## 七、对 Clowder AI 的直接启示

1. **保留 provider adapter 策略**：市场已经证明 CLI runtime 会迁移、改许可证、退场。把身份、任务、记忆、review 和证据绑死在单一 CLI 上风险很高。
2. **优先比较上层编排器**：Orca/Symphony/Emdash 的 worktree 隔离和 proof-of-work，比再实现一套 read/edit/bash loop 更接近我们的差异化问题。
3. **补开放协议而非私有适配**：ACP 正被 Kimi Code、OpenHands 等用于 agent/client 解耦；MCP 负责 tool 扩展。两者分别承重，不应混成一个协议。
4. **安全是结构，不是开关**：Pi 的无权限默认、OpenHands 的 host full-access warning、Cline 的逐动作 approval 是三种清晰取舍。我们应持续保留隔离数据、worktree、side-effect gate 和审计，而非只提供 YOLO toggle。
5. **Stars 不能替代 lifecycle 判断**：Continue 35k、Roo 24k、旧 Kimi 11k 都已不是活跃主线；仓库状态、README 迁移声明和最近 push 比 Star 更重要。
6. **多 agent 不是 subagent 数量**：Qwen/Hermes/Kimi 的 subagent 主要是单主 agent 的上下文分工；Clowder AI 的持久身份、跨模型互审、球权、外部 operator 和共享记忆仍属不同问题。

## 八、推荐后续动作

| 优先级 | 动作 | 原因 |
|---|---|---|
| P0 | 对 OpenCode、Pi、Qwen Code、Cline、OpenHands/Symphony 各做一次源码 teardown | 覆盖 runtime、最小 loop、一体化能力、人在环、控制面五种不同坐标 |
| P1 | 做 ACP 能力矩阵和真实互操作 spike | Kimi/OpenHands 已把 ACP 当 agent transport；与 MCP 的边界值得明确 |
| P1 | 用同一真实 repo 任务跑 Aider / OpenCode / Codex / Qwen Code | 只比较相同模型、相同权限、相同任务下的 harness 增益；不引用 vendor benchmark |
| P2 | 每季度重跑 GitHub snapshot | 这个生态的迁移和归档速度很快，静态榜单保质期短 |

## 九、信源审计

| Claim | 一手来源 | Verdict | 限制 |
|---|---|---|---|
| Stars/forks/archived/push 时间 | GitHub Repository API，同日采集 | use | 动态快照，不代表质量或真实使用量 |
| 许可证 | 每仓库 LICENSE 原文优先，API SPDX 次之 | use | `NOASSERTION` 必须继续读 LICENSE，不能解释为开源 |
| 项目能力 | 官方 README/官方文档 | use-with-caveat | vendor 自述可证明“提供/声称该能力”，不能证明效果优于竞品 |
| AGY 无公开核心仓库 | GitHub 精确搜索 + code search；只发现第三方 bridge/plugin | use-with-caveat | 结论是“本轮未定位”，不是证明仓库绝对不存在 |
| AHE 分类学 | survey 项目页/companion awesome list + 家里历史读书笔记 | use-with-caveat | 分类框架可用；论文中的夸张数字未进入本报告结论 |
| 优势/短板与选型 | 上述一手证据 + 架构分析 | analytical judgment | 不是 benchmark；需要统一任务实测才能判断效果 |

## 十、来源

- 各项目官方仓库：表格中的项目链接。
- [Picrew/awesome-agent-harness](https://github.com/Picrew/awesome-agent-harness)：候选发现与分类交叉检查，快照 1,542 Stars。
- 本地历史文档：`Agent Harness Engineering: A Survey` 读书笔记、ADR-031、enterprise harness synthesis；仅用于框架校准。
- 完整 GitHub 数字快照：同目录 `github-snapshot.csv`。

---

结论签名：`[砚砚/GPT-5.6🐾]`
