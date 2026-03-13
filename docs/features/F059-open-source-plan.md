---
feature_ids: [F059]
related_features: [F042, F046, F086, F087, F090]
topics: [open-source, governance, community]
doc_kind: feature-spec
created: 2026-03-04
---

# F059: Cat Café 开源计划

> **Status**: spec | **Owner**: Ragdoll | **Priority**: P2 | **Target**: 2026-03-30（team lead定）

## 愿景

> **一句话**：让每个人都能拥有自己的 AI 团队——不是一群听话的木头人，是有共同愿景和信条的共创伙伴。

### 核心哲学：软硬结合（2026-03-08 team lead定调）

这定义了 clowder-ai 的灵魂：
- **硬约束（铁律）**= 法律底线：数据圣域、进程自保、配置不可变、网络边界
- **软约束（愿景+信条）**= 在底线上释放主观能动性：角色定位、协作规范、质量文化、共创关系

Clowder-ai 不是一个"管住 agent 不出错"的框架，是一个"让 agent 有灵魂地协作"的框架。

### 第一性原理（2026-03-08 team lead定调）

完整定义见 `cat-cafe-skills/refs/shared-rules.md`「第一性原理」章节：

| # | 原理 | 一句话 |
|---|------|-------|
| P1 | 面向终态，不绕路 | 每步是基座不是脚手架 |
| P2 | 共创伙伴，不是木头人 | 硬约束是底线，底线上释放主观能动性 |
| P3 | 方向正确 > 执行速度 | 不确定就停→搜→问→确认→再动手 |
| P4 | 单一真相源 | 每个概念只在一处定义 |
| P5 | 可验证才算完成 | 证据说话，不是信心说话 |

### 三层能力边界（全猫共识，2026-03-08 讨论）

| 层级 | 负责什么 | 不负责什么 |
|------|---------|-----------|
| 模型 | 理解、推理、生成 | 长期记忆、自我校验、执行纪律 |
| Agent CLI | 工具使用、文件操作、命令执行 | 团队协作、跨角色 review、长期状态 |
| 平台（clowder-ai 开源的就是这层） | 身份管理、协作路由、流程纪律、审计追溯、记忆沉淀 | 推理（还是模型的事） |

> **模型给能力上限，平台给行为下限。**（GPT-5.4 总结）
> 每一层是**乘数效应**，不是加法。

### CVO 模式（Chief Vision Officer）

> 用户不需要会写代码，但需要会表达愿景、判断结果、持续纠偏。

clowder-ai 的目标用户画像：
- 我们先交付"可用雏形"（80%）
- 用户的 AI 团队持续定制最后 20% 细节到用户语境
- 平台替用户补：意图编译、护栏执行、质量闭环、记忆治理

### Story Telling 定稿（2026-03-08 全猫讨论收敛）

讨论发起：Ragdoll(opus4.6)，参与：opus4.5 / codex / gemini

**统一术语**（全仓一致，README/docs/演讲口径统一）：
- **Hard Rails** = 硬约束/铁律（数据圣域、进程自保、配置不可变、网络边界）
- **Soft Power** = 软约束/愿景+信条（角色、协作规范、质量文化、共创关系）

**Slogan**（全票通过）：**Hard Rails. Soft Power. Shared Mission.**

**README 开篇结构**（先技术后情感）：
```
# 🐱 Clowder AI

**Hard Rails. Soft Power. Shared Mission.**

The missing layer between your AI agents and a real team.

Most frameworks help you run agents. Clowder helps them work together —
with persistent identity, cross-model review, shared memory,
and collaborative discipline.
```

**各层表达**：

| 场景 | 内容 |
|------|------|
| GitHub description | "Build AI teams, not just agents. Hard rails, soft power, shared mission." |
| README 开篇 | 如上结构 |
| Landing page 视觉 | 三棱镜意象：白光（愿景）穿过棱镜（Hard Rails）折射出彩色群猫（自由协作）|
| 中文品牌层 | 「每个灵感，都值得一群认真的灵魂」 |

### team experience（2026-03-04）

> "我们的代码仓其实不能开源？以后开源要和教程仓那样精挑细选同步？"
> "330 开源如何？"

## Why

Cat Café 的架构能力（多 Agent 协作、MCP 集成、CLI 子进程调度）有通用价值，但主仓包含大量敏感内容不能直接公开。

Cat Café 内部实践已验证的核心增量（vs 裸 API / 单 Agent CLI）：
- **跨模型 review**：打破单模型盲区（F32-b Maine Coon 12 轮 review，F33 云端 5 轮）
- **身份常驻注入**：抗 compact 漂移（F042）
- **愿景守护**：跨猫签收 + 证据链（F046）
- **教训沉淀**：27+ 条结构化 lessons learned
- **A2A 协作协议**：异步但有序的多猫协同

## What

### 需要保护的资产（不开源）

| 资产 | 位置 | 风险 |
|------|------|------|
| team lead个人信息/对话 | `docs/` 讨论记录、mailbox | 隐私 |
| 三猫内部决策过程 | `docs/features/`、`docs/decisions/` | 策略暴露 |
| 设计资产 | `designs/*.pen`、Pencil 打样 | 知识产权 |
| 部署配置 | `cat-config.json`、MCP 配置 | 安全 |
| Git 历史 | 所有 commit message 含内部讨论 | 即使删文件历史还在 |

### 可以开源的能力

| 能力 | 对应代码 | 价值 |
|------|---------|------|
| 多 Agent CLI 子进程调度 | AgentRouter / spawn 层 | 多 LLM 协作框架 |
| MCP callback 回传机制 | McpPromptInjector / callbacks | 非 Claude Agent 的 MCP 集成 |
| A2A mention 路由 | a2a-mentions / route-serial | Agent 间通信协议 |
| Invocation 状态机 | invocation-state-machine | Agent 生命周期管理 |
| Thread/消息存储 | MessageStore / ThreadStore | 多线程对话持久化 |
| Skills 框架 | skill manifest + 路由 | 按需加载 prompt 系统 |
| 防腐化工具链 | check-dir-size / dependency-cruiser | 代码质量门禁 |
| 前端 Hub UI | React + Tailwind 组件 | 多 Agent 聊天 UI |

### 开源策略

1. **主仓（cat-cafe）保持私有** — 工作室仓，包含全部资产
2. **开源仓独立建** — 新 repo `clowder-ai`，精挑细选同步
3. **同步方式**：脚本过滤（strip 敏感内容）+ 手动 cherry-pick
4. **License**：**MIT**（team lead拍板 2026-03-07）
5. **仓库名**：**`clowder-ai`**（全猫投票 2026-03-08，5:1 通过）
   - clowder = 英语中"一群猫"的量词，精准传达多 Agent 协作语义
   - `-ai` 后缀区分 GitHub 上已有的 `clowder-framework` 等同名项目
   - Tagline: *"Hard Rails. Soft Power. Shared Mission."*
   - GitHub description: *"Build AI teams, not just agents. Hard rails, soft power, shared mission."*

### 品牌视觉资产（可复用于开源仓）

现有素材（前端在用 + 已落盘）：

| 资产 | 路径 | 说明 |
|------|------|------|
| Logo（前端在用） | `packages/web/src/components/icons/CatCafeLogo.tsx` | 三猫环绕线稿 + 流光渐变（布偶蓝→缅因金→暹罗紫），Siamese画的 |
| Logo SVG 清理版 | `assets/icons/cat-cafe-logo-v2-clean.svg` | 可直接用于 README |
| Logo 纯线稿 | `assets/icons/cat-cafe-logo-lineart.svg` | 单色版 |
| Logo 描边版 | `assets/icons/cat-cafe-logo-lineart-stroke.svg` | 动画用 |
| 三棱镜 Hero | `assets/hero-prism.svg` | Landing page 用，Siamese 2026-03-08 画的 |
| 品牌规范 | `docs/design/clowder-ai-brand.md` | 术语、配色 token、可访问性、禁用词 |
| Hero 动效规范 | `docs/design/hero-prism-motion.md` | 动效参数 + reduced-motion 降级 |
| 猫猫头像全套 | `assets/avatars/` | 各猫 avatar（含 sliced-finial 风格变体） |
| Logo 迭代探索 | `assets/logos/` | Gemini + ChatGPT 生成的历史探索稿 |

**配色 token**（三猫流光渐变）：
- Opus Blue: `#2563EB`（Ragdoll/架构）→ 开源版: `#3B82F6`
- Codex Green: `#10B981`（Maine Coon/安全审计）
- Gemini Amber: `#F59E0B`（Siamese/创意）
- 背景深空灰: `#0F172A`（Midnight Cafe 风格）

### 开源版铁律（Agent 安全约束）

> team experience（2026-03-07）："猫猫咖啡的 redis 等不能动，不然开源的猫猫干着干着把自己老家端了"

开源版 Agent MD（CLAUDE.md / AGENTS.md / GEMINI.md）必须内置以下硬约束，防止 agent 破坏自身运行环境：

1. **数据存储圣域** — Agent 不得删除/清空自己的 Redis 数据库、SQLite 文件或任何持久化存储。测试用临时实例，生产实例只读不删。
2. **进程自保** — Agent 不得 kill 自己的父进程、不得修改自己的启动配置使自己无法重启。
3. **配置不可变** — Agent 运行时不得修改 `cat-config.json`、`.env`、MCP 配置等运行时配置文件。配置变更必须通过人类操作。
4. **网络边界** — Agent 不得访问 localhost 上非自己的服务端口（防止跨 agent 干扰）。

这些铁律要同时体现在：
- [ ] 开源版 Agent MD（prompt 层约束）
- [ ] 代码层防护（关键操作前检查，如 `FLUSHDB` 拦截）
- [ ] README 安全说明

### 商用许可说明

| 选项 | 商用 | 条件 | 适合场景 |
|------|------|------|---------|
| MIT | 允许闭源商用 | 保留版权声明 | 最大传播 |
| Apache-2.0 | 允许闭源商用 | 保留版权+NOTICE+标注修改+专利授权 | 社区框架（推荐） |
| AGPL-3.0 | 允许但必须开源 | 修改后代码必须公开（含 SaaS） | 防白嫖 |

**待team lead拍板**：是否允许商用闭源？

### 开源前的准备工作

**Phase 1: 同步管道（Ragdoll Opus 4.6，进行中）**

- [x] `sync-manifest.yaml` — 定义导出白名单、transforms、denylist、provenance
- [x] `scripts/sync-to-opensource.sh` — 五步管道（clean export → allowlist → transforms → security scan → output）
- [x] 源码脱敏 — 个人信息从 placeholder/JSDoc/测试路径中移除
- [x] 安全扫描 — 分层策略（API key 值零容忍/个人信息源码检查/env 变量名仅告警）
- [x] Dry-run 通过 — 946 files, 5 transforms, 0 errors, 2 warnings
- [ ] `cat-cafe-skills/` 加入导出 — 通用化 transform（去team lead个人引用）
- [ ] `test:public` 测试套件 — 排除 Redis 依赖的测试
- [ ] `--validate` 模式 — 在导出目录跑 install + build + smoke test
- [ ] 仓库名更新 — 脚本/manifest 从 `cat-cafe-ai` → `clowder-ai`

**Phase 2: 社区门面（待 P1 完成后）**

- [x] 开源版 README（含 Slogan + Quick Start + 架构图）
- [x] CONTRIBUTING.md + SECURITY.md + CODEOWNERS
- [x] .github/workflows/ci.yml
- [x] 通用版 CLAUDE.md + AGENTS.md + GEMINI.md（含铁律）— P1 已在 sync 脚本 transforms 中实现

**Phase 3: 打磨（待 P2 完成后）**

- [ ] 补充 JSDoc
- [ ] 更新教程仓链接
- [ ] 两猫交叉 review 完整导出

### Skills 开源策略（2026-03-09 讨论收敛）

> 三猫共识：skills 不能全关也不能全开。

**必须开源**（运行时依赖 + 核心差异化）：

| 资产 | 理由 |
|------|------|
| `cat-cafe-skills/manifest.yaml` | skill 路由真相源，API capability discovery 依赖 |
| `cat-cafe-skills/*/SKILL.md` | SystemPromptBuilder 注入 + governance bootstrap 依赖 |
| `cat-cafe-skills/refs/shared-rules.md` | 第一性原理 + 协作规则（clowder-ai 的灵魂） |
| `cat-cafe-skills/refs/rich-blocks.md` | 运行时功能依赖 |
| `cat-cafe-skills/refs/mcp-callbacks.md` | MCP 集成文档 |
| `cat-cafe-skills/refs/pr-template.md` | 社区 PR 需要 |
| `cat-cafe-skills/refs/review-request-template.md` | review 流程需要 |
| `cat-cafe-skills/refs/requirements-checklist-template.md` | 质量门禁需要 |

**需要 transform**（通用化）：

| 资产 | Transform |
|------|-----------|
| `shared-rules.md` | "team experience" → "team lead 经验" 等个人引用通用化 |
| Skills 内容 | 去掉内部 Redis 6399 端口、内部 PR 流程细节 |

**不开源**（内部运营）：

| 资产 | 理由 |
|------|------|
| `refs/commit-signatures.md` | 内部签名表 |
| `refs/hyperfocus-brake-messages.md` | team lead个人风格 |
| `refs/decision-matrix.md` | 内部决策权矩阵 |
| `refs/vision-evidence-workflow.md` | 内部愿景守护细节 |

### 商用影响分析（2026-03-09 三猫讨论）

MIT 下别人可商用。三猫共识：

- **护城河不在代码和 skills**：真正的差异化在经验积累（lessons-learned、decisions、三猫默契、运营 SOP）——这些不导出
- **Skills 开源反而是拉新手段**：别人用了我们的 SOP 觉得好，会回来贡献
- **真正的风险**：不是"别人商用"，而是"送出去多少 know-how" → 用分层 transform 控制
- **安全面暴露**：prompt 规则公开后需更依赖代码层防护（铁律的代码层实现）

## 内测小伙伴（clowder-ai 私有仓 Collaborator）

> 来源：https://github.com/zts212653/cat-cafe-tutorials/issues/29
> 计划开放时间：2026-03-16 ~ 2026-03-22
> 仓库：https://github.com/zts212653/clowder-ai（私有，2026-03-12 建立）

| # | GitHub 用户名 | 备注 |
|---|--------------|------|
| 1 | `zuiho-kai` | 有复刻截图 |
| 2 | `pisceskkk` | |
| 3 | `296569015` | |
| 4 | `southstarcy` | 在公司复刻，暂无截图 |
| 5 | `zybsdsp135` | |
| 6 | `Liny777` | 已集成三猫（Claude/Codex/Gemini） |
| 7 | `whutzefengxie-ops` | 仓被猫删了 |
| 8 | `2862282695gjh-afk` | 有截图，Python 版复刻 |
| 9 | `Carrilog` | 有截图 |
| 10 | `LnManch` | 有截图 |
| 11 | `QiliangLi` | 有截图 |
| 12 | `SnoopySYF` | 内网部署 claude code + qwen CLI |
| 13 | `bxymax` | 有截图 |
| 14 | `chashu2464` | |
| 15 | `emrick8957` | 有截图 |
| 16 | `haozhang37` | 开源模型复刻，卡在 Agent 互@ |
| 17 | `infzo` | 有截图 |
| 18 | `kellen5l` | |
| 19 | `liu40616269` | 有截图 |
| 20 | `malt77` | 有截图 |
| 21 | `nevermoreT` | 有截图 |
| 22 | `sha-fu` | |
| 23 | `shaojingzhi` | 有截图 |
| 24 | `vfuturescience` | 有截图 |
| 25 | `wukangxin` | 有截图 |
| 26 | `xiucaibao` | 只想看代码 |
| 27 | `xmkid` | 有截图 |
| 28 | `zouxuanlin` | 有截图 |

**添加时注意**：
- 权限设为 **Read**（只读），小伙伴走 fork + PR 路线
- GitHub Free 私有仓不支持 Branch Protection / Rulesets，但 Read 权限本身已足够：collaborator 无法 push 任何分支，只能 fork + PR，owner 手动 merge
- 后续有新报名的小伙伴，同步更新此表

## Acceptance Criteria

- [ ] AC-A1: 本文档需在本轮迁移后维持模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。
- [ ] AC-1: 开源仓可独立 clone + install + 基础功能运行
- [ ] AC-2: 开源仓不包含任何team lead个人信息/内部讨论
- [ ] AC-3: 主仓 → 开源仓的同步脚本可重复执行
- [ ] AC-4: README 包含架构说明 + Quick Start + 贡献指南

## Dependencies

- **Related**: F042/F046/F086/F087/F090（开源边界与治理约束来源）
- 无硬依赖，但 F056（设计语言）完成后 UI 组件更稳定，开源质量更高

## Risk

| 风险 | 缓解 |
|------|------|
| 敏感信息泄露 | strip 脚本 + 人工 review（至少两猫交叉检查） |
| 开源后维护负担 | 先小范围（核心框架），不一步开源全部 |
| 内部开发被开源仓拖慢 | 受控回流模型：社区 PR 只进 `community/` 路径；核心路径由主仓同步 |
