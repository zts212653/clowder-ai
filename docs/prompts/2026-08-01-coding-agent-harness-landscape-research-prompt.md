---
feature_ids: []
topics: [coding-agent, harness, open-source, landscape]
doc_kind: research_prompt
created: 2026-08-01
---

# Research Brief: Coding Agent Harness 开源生态全景

## 1. Problem Frame（任务边界）

**要回答的问题**：截至 2026-08-01，市面上尤其 GitHub 开源的 coding-agent harness 有哪些主流项目？它们在模型接入、工具执行、上下文管理、扩展协议、自治/人在环、多 agent、可观测与部署形态上的能力、优势、劣势及适用场景如何？

**范围定义**：harness 指承载“模型 → 工具 → 环境反馈 → 下一步动作”循环的执行系统。主榜分为终端原生 harness、IDE/工作台型、评测/自动修复型，避免把不同任务形态硬排成一个总榜。

**非目标**：不把纯模型、纯补全插件、单一 benchmark、只做 PR review 的 SaaS、通用 workflow 框架混入主榜；不做主观模型质量排名；不以营销 benchmark 代替架构比较。

## 2. Current Hypotheses（当前假设）

1. Claude Code、Codex CLI、Gemini CLI、OpenCode、Kimi CLI、Hermes Agent、Pi、AGY 只覆盖了主流生态的一部分。
2. Aider、Cline、Roo Code、Continue、OpenHands、SWE-agent、Goose、Plandex、Crush、Qwen Code 等值得纳入候选。
3. 真正影响选型的不是 Star 单指标，而是执行边界、可扩展性、provider lock-in、自治与审计能力。

**证据缺口**：准确仓库归属、当前 stars/forks/activity、许可证、核心是否真正开源、能力是否由官方一手文档支持、项目是否仍活跃。

## 3. Disconfirm First（先找反例）

1. 查明高 Star 项目是否已转向产品壳、归档或只公开插件/issue tracker。
2. 查明“支持多模型/多 agent/自主执行”等说法是否只存在于营销文案。
3. 查明低 Star 新项目是否在架构上更贴近目标，而高 Star 是否来自更宽泛的 IDE 用户群。

## 4. Source Mix Quota（来源配额）

- GitHub Repository API：stars、forks、更新时间、许可证、归档状态。
- 官方 README/文档：能力和限制。
- 项目源码/配置入口：对关键边界抽样验证。
- 内部历史调研：只作候选线索和比较框架，不代替当前官方证据。

所有数字统一标注快照日期；核心开源性、许可和能力 claim 追到官方一手来源。

## 5. Local Constraints（本地约束）

- Clowder AI 需要多模型、多 agent、人在环、持久身份、共享记忆与可验证审查链。
- 知识和治理资产在 Git/Markdown 中；优先开放协议、可审计实现和 headless/SDK 接口。
- 不因现有适配器而偏袒 Claude/Codex/Gemini/OpenCode/Kimi/AGY。

## 6. Output Schema（输出格式）

1. 口径与结论摘要。
2. 主流项目总表：项目、形态、Stars 快照、许可证/开放性、模型策略、关键能力、优势、短板、适用场景。
3. 分层能力矩阵与选型建议。
4. 未纳入/相邻项目及排除理由。
5. Claim ledger、来源清单和数据快照说明。

## 7. Decision Interface（决策映射）

- **重点拆解**：值得读源码或做适配 spike。
- **持续观察**：有差异化但成熟度/开放性不足。
- **仅作对照**：闭源、偏 IDE 或任务范围不匹配。

## 8. Risk Register（风险登记）

1. Stars 随时变化且受项目年龄/受众影响 → 固定日期快照，不作为质量排名。
2. 名称歧义（AGY、Pi、Kimi Code）→ 明确仓库/产品坐标，无法确认时标注。
3. “开源”口径污染 → 分开记录代码可见、OSI 许可证、核心闭源与仓库仅作 issue tracker。
4. 快速迭代导致能力过时 → 记录采集日期、默认分支 commit 和官方文档链接。
