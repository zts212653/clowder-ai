---
doc_kind: note
created: 2026-09-07
topics: [harness, prompt, skills, model-adaptation]
---

# GPT-6 Prompt / Skill 审计与本地优化候选

Issue: [#1442](https://github.com/zts212653/clowder-ai/issues/1442)
审计基线: `730c37b08fa49478a0cc1eed7240064cbaaccc71`
交付状态: **已形成协议审阅候选；未合入、未激活运行配置。**
原始目标: 分析当前对话 Prompt 与日常 skill，优化模型升级后低收益或冲突的 harness；长期模型适配评分产品另行讨论。

## 结论与证据边界

本轮已形成 58 项第一方 skill 的冻结来源清单，并对七项开发/检索 skill 做重点语义审计。候选修正身份、检索、review、调试和工件处置的入口/正文冲突，收窄规划、验收与调研流程。

这是**内容一致性与局部运行行为改进候选**。尚无模型配对实验、近期使用频率、真实请求完整覆盖或退役证据。不能把“少了多少行”“规则更一致”写成“GPT-6 提效多少”。

[skill-inventory.json](./skill-inventory.json) 记录基线 commit、每份源文件 hash、行数、字节数、frontmatter 和审计状态。58 项全部进入清单：7 项 targeted_semantic、5 项 workflow_reference、46 项 inventory_only；全部 effectVerdict 为 unmeasured，usageFrequency 为 null。主机动态插件目录、HOME mounts 和运行覆盖不属于这个文件数的分母。

## 原始需求到本轮候选

| 发现 | 本轮处置 | 依据/限制 |
|---|---|---|
| A1 provider 绑定猫身份 | AGENTS 改为接受 runtime 的身份/角色，保留仓库安全与非作者 review 边界 | 同方向修复已在 PR #1398，采用其等价条款；不声称独立发现或已上游合入 |
| A2 L2 旧模型评价 | 移除旧 Anthropic 评价文字，保留 source-audit 入口 | 不代表其他家族治理可以一并移除 |
| A3 规划粒度与预写代码 | 计划按用户授权交付单元和依赖组织，取消固定分钟数、完整代码教程与默认流程串联；frontmatter/manifest 同步 | 保留生命周期对象、不变量、对抗场景与真实命令要求 |
| A4 调试门槛 | runtime 版本/进程归因需要对应证据；独立源码/测试调查可继续；复杂调查复用胶囊或等价记录 | shared-rules §16a 与 skill 同步，未知仍为未知，不允许无证据断言环境有问题 |
| A5 检索停止条件 | startup 只指向 skill 的题型停止条件，保留原文核验 | skill 内 coverage 多路要求保留；没有证据取消它 |
| A6 Review 入口 | S6 只在风险路由已选择 local peer 时发本地审查；修复回 active finding source | request-review/TDD 正文保留；非作者要求及 cloud provenance 保留 |
| A7 验收范围 | 完整 feature、授权局部修复、候选各自对照其原始目标；UI/close 检查按适用范围触发 | 不能自行把完整需求缩成“小任务”；身份专属、安全、hotfix 与已选审查边界独立生效 |
| A8 调研路径 | 按证据缺口选择研究与审阅路径，解除默认三路/GPT-5.2 Pro 绑定，实际 reviewer 标识进入文件名 | 保留一手来源、分歧、反例和代码核对；遵守独立回答及外部操作授权 |
| A9 启动卫生提示 | 输出本地 ref 的 ahead/behind 并标注未刷新；不 fetch、不指令先同步/清理；根目录检查先过滤路径深度 | 启动状态不授权处置其他工作；新媒体仍按 evidence-output-contract 归档 |

工件合同同步保留“新产物不写仓库根目录”，同时明确既有无关工件不自动阻断/接管当前任务。独立审查曾发现“skill 已改、引用源没改”的三处 P2，均已修正，见 review 记录。

## 实际输入构建：源码确认与未知部分

“源码中存在”“已组装”“交给 provider”“服务端实际请求包含”“模型行为采用”是不同证据，不能互相替代。

| 来源/阶段 | 构建入口与投递方式 | 本轮证据 |
|---|---|---|
| L0 | assets/system-prompts/system-prompt-l0.md；scripts/compile-system-prompt-l0.mjs 加入 L1–L7、cat catalog、家规摘要、画像入口、roster、S6 | 已读源码；实际画像正文未读取 |
| 覆盖 | workflow-triggers.local.yaml 可覆盖 S6；shared-rules.local-override.md / .local.md 可替换或追加家规；prompt-template-loader 解析可覆盖模板 | 已读解析代码；本次运行究竟用了哪些覆盖仍 unknown |
| 静态/动态 builder | SystemPromptBuilder 委托 PipelinePromptBuilder/HookPipeline；静态输出 S 段，动态输出 D 段 | 已读源码；不能把所有 fired hook 都算实际输出 |
| 路由 | route-serial 组装模式、bootstrap、历史增量、当前消息与必要 MCP fallback；原生 L0 使用 pack-only 静态片段 | Codex 串行/独立主链已读；全部 parallel/recovery 分支未逐例运行 |
| 调用层 | invoke-single-cat 处理 resume 重注入、mission、staging、context hint、transcript hints，并调用 provider | 已读源码；本轮没有真实会话请求快照 |
| Codex | CodexAgentService 编译 L0 为 developer_instructions，正文经 stdin；另叠加宿主基础规则、AGENTS、skill/tool 元数据 | 已读代码并观察当前会话可见输入；不可见宿主内容仍 unknown |
| Claude | ClaudeAgentService 的 --system-prompt-file；pack-only 可走 --append-system-prompt-file | 读取关键分支；未执行实际 provider 请求 |
| Gemini | GeminiAgentService 在已读路径将 options.systemPrompt prepend 到正文 | 读取关键分支；ACP/其他路径待核 |
| OpenCode | OpenCodeAgentService 声明原生 L0；invoke 层提供 instructions 文件配置 | 读取关键分支；未更改或执行 runtime config |
| Kimi | kimi-code 使用 --agent-file；resume 依据绑定 fingerprint；legacy kimi-cli 保留 prepend | 读取关键分支；未实际验证二进制与恢复行为 |
| CatAgent / 其他 carrier | CatAgentService 已读 anthropic body.system 分支；ACP、AGY、A2A adapter 尚待完整核查 | partial / unknown |
| 启动 hook / 按需内容 | session-start-recall 输出、skill 正文、工具返回、用户中途消息继续进入上下文 | hook 在临时 git fixtures 实跑；其余只记录已知入口 |

已有 D8/D21 nativeL0Injected suppression 不在本轮改动面；其去重行为由源码确认，本轮不宣称跑过其所有恢复回归。F153 best-effort capture 与 F237 contentAssembled 的限制仍存在；本轮没有新增 capture 框架。

## 验证与审查

### 确定性 hook 回归

scripts/session-start-recall.test.mjs 在隔离临时 git 仓库中执行：

1. 保留工件与 git 状态；研究子目录不被列为根目录垃圾；不把未知归属写成“忘记提交”。
2. 检索提示指向 canonical 题型停止规则，不输出通用 ≥3 路铁律。
3. 分叉信息标明本地 upstream 快照；用 git 包装器断言没有 fetch 尝试，HEAD 与 ref 保持不变。

基线观测: **0/3 pass**，失败对应上述实际输出。
候选验证: **3/3 pass**。这是 hook 合同行为测试，不是 agent 任务效用评估。

### 独立内容/压力场景审查

通过 writing-skills 的 testing-skills-with-subagents 流程，由另一 invocation 只读审查候选与六个场景：精准 RED 小修、版本证据缺失、跨层持久化故障、半完成完整 feature、试图省略已选高风险 review、独立回答的调研任务。

首轮: 3 P2/block + 1 P3：
- debugging 与 shared-rules 的旧门槛不一致；
- 规划/验收仍有强制完整 feature 的残余模板；
- 工件合同仍是任意命中即 BLOCK；
- 实际 reviewer 与 gpt-pro 文件名不一致。

这些实质 delta 已修正并由同一独立审查 invocation 复核，结果 **approve，无遗留发现**。这是内容与场景审查，不能替代模型效用实验，也不是 maintainer/跨族治理或 merge 授权。

### 工程检查与环境限制

- bash -n hook: pass。
- check-skills-manifest: 58 项 pass；5 条既有 MCP 声明 advisory 明确保留。
- changed-surface Biome / git diff --check: pass。
- pnpm check 首次在系统 Python 3.9 的 TTS 测试处失败：anext 未定义。该测试文件不在改动面；主机已有 Python 3.11.15，后续检查使用仅对命令生效的 PATH，不修改启动或 runtime 配置。
- Convention Graph 命令返回 No projects matched：上游未提供被脚本引用的 workspace 包。它不是成功的影响图检查。替代证据是源码引用检索、manifest 校验、精确在飞 PR 文件集核对与独立审查；图覆盖仍记 unavailable。
- 最终 `PATH=/opt/homebrew/opt/python@3.11/libexec/bin:$PATH pnpm check`: **exit 0**。仅对验证命令选择已有 Python 3.11，系统/运行配置未修改。
- `node --test packages/api/test/l0-pipeline-equivalence.test.js packages/api/test/transport-boundary-l0-equivalence.test.js packages/api/test/system-prompt-builder.test.js packages/api/test/governance-l0.test.js`: **140/140 pass**。中途两个既有字符预算断言失败（7059/7056 > 7050），压短 S6 等价措辞后通过；未提高预算阈值。
- 新增 hook 测试最终 **3/3 pass**；manifest、frontmatter delta、changed-surface Biome、staged diff whitespace 均通过。
- 未执行 `pnpm gate`、完整 API public suite、实际 provider/用户任务效用实验；不把这些未跑检查写成通过。

## 并发、隔离与未完成范围

候选以最新 origin/main 建在独立 checkout。共享 main 的 ahead/behind 与其他工作改动未被同步、提交或清理；未访问生产数据。

已核对 PR #1398 的实际 diff：它有等价 AGENTS 身份修复，并给 writing-plans/quality-gate 添加其他门槛；未来合入需要复核语义与冲突。PR #1237/#139 也改 manifest，但涉及其他条目。本地候选不修改这些 PR、不接管其作者工作。

worktree skill / SopDefinition 的“main 双向同步才准隔离”本身是新增审计候选：本轮以冻结上游基线隔离保全了其他工作；不将此例直接升级成修改整个同步门禁的许可。

仍未完成：
- 46 项 inventory_only 的全文语义审计；
- 使用频率与实际模型/调用版本的归属；
- 完整 provider、新建/resume/recovery 的实际请求覆盖；
- GPT-6 多次配对执行、独立 holdout 和效用结论；
- maintainer 对 #1442 的范围确认、跨族治理审查及合入/运行验证。

## 下一步与回滚

当前以 Draft Protocol PR 提交审计与候选，供 maintainer 对治理范围与剩余审计安排作明确 review；#1442 当前尚无 maintainer 回复或 Feature ID。第一项工作并未因候选存在而整体完成。

候选只包含源码、测试与本审计目录；激活前可直接不采纳该提交。若后续合入，按当前仓库策略 revert 对应提交；不涉及生产数据迁移，不要求修改 runtime 配置。

[宪宪/gpt-6-astra🐾]
