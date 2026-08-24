---
feature_ids: [F302]
related_features: [F070, F203, F228, F249, F251, F289, F293, F301]
topics: [portable-governance, external-workspace, bootstrap, project-hygiene, skills]
doc_kind: spec
created: 2026-08-21
description: "让猫通过 runtime 带着身份、协作与安全契约进入外部项目，并把项目治理收敛为零写入默认、可预览选择、可撤销的一键安装产品。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-08-22T03:50:00Z
cvo_signoff: "2026-08-21 — sourceMessageId 0001787329489768-000393-2f9188ad：完成立项；保留一键治理价值，但默认不要向用户项目制造大量文件，docs 等规范应可选。"
tips_exempt: "Kickoff-only architecture/spec；尚无可使用的新 surface，实现 Project Setup 可选治理时必须补真实操作 tip 后才能 close。"
---

# F302: Runtime-First Portable Governance — 零写入出征与可选项目治理

> **Status**: spec | **Owner**: 小太阳·Maine Coon (@codex-sol, GPT-5.6 Sol) | **Priority**: P1

Architecture cell: `portable-governance`

Map delta: `new cell required`

Why: 沿用 F070 Portable Governance 产品域，只拥有 opt-in bootstrap 的 preview / execute / undo 与 legacy cleanup。prompt/L0 delivery 归 F203，Skill mount 归 F228/F301，MCP resolution 归 F249，dispatch/routing 归 F293；F302 不拥有第二份规则发现、capability resolution 或 readiness 系统。

## Why

猫进入外部项目时，身份、协作和家庭安全边界应由 Clowder AI runtime 携带；项目自己的规则与命令应由目标 repo 提供。两者都不要求把 Clowder AI 的 BACKLOG、SOP、Feature/ADR 模板、四家 provider 文件和全量 Skills 复制进目标仓。

2026-08-21 的真实出征中，旧 F070 bootstrap 为 `clowder-ai-plugins` 计划了 **235 个文件动作，其中 225 个是 Skill symlink**，还生成了目标项目不存在的 `pnpm check`。operator要保留“一键安装治理”的价值，但默认不要制造这些文件，docs 等治理模块应可选择。

> **终态一句话：猫带脑子出门，仓提供项目真相；不点安装就零写入，点了才按 preview 写所选内容。**

## 第一性原理压缩

F302 不建新平台，只对 F070 做六个动作：

| 动作 | 改什么 | 复用什么 |
|------|--------|----------|
| 搬 | frontend/API 当前保留端口从 external managed block 搬到 Clowder AI 单一 L0 规则源 | F203 L4；端口值继续读 `FRONTEND_PORT` / `API_SERVER_PORT` |
| 删 | 外部派遣不再因 registry、provider file 或 managed marker 缺失而 `governance_blocked` | 删除 `checkGovernancePreflight` 的 dispatch readiness 职责；路径、权限、sandbox 各守现有 owner |
| 删 | `/api/projects/setup` 不再无条件执行全量 governance bootstrap | 只有用户确认过的 `BootstrapReport` selection 才 execute；代码中不存在的 dispatch auto-resync 不列工作项 |
| 改 | F070 bootstrap 从“全量写”改为“先 dry-run，再写所选组” | 扩展既有 `BootstrapOptions` / `BootstrapReport` / `BootstrapAction` |
| 清 | 旧 report 圈出 legacy 候选，只撤销仍与 F070 生成形式一致的 file/symlink | F070 report + 当前正文或 symlink target；不建 provenance 状态机 |
| 约定 | 生成文案和随身 Skill 只引用目标 repo 真实命令；共享 refs 使用既有 alias | `package.json.scripts` + ADR-025/F301 `.cat-cafe-shared-refs` |

## 启动时到底读谁的规则

从 Clowder AI 启动时，Clowder AI 层和项目层同时存在但各有唯一 owner：

| 入口 | Clowder AI 层 | 项目层 | 是否写目标仓 |
|------|-------------|--------|----------------|
| Clowder AI 派遣 | runtime 注入猫身份、家规、协作、安全边界和 mission | carrier 在目标 cwd 按自身原生机制读取该仓 `AGENTS.md`，以及需要时的 `CLAUDE.md` / `GEMINI.md` 薄入口 | 否 |
| bare CLI | 没有 Clowder AI runtime L0，也不能声称拥有家里的完整协作能力 | CLI 按自己的 HOME 配置与目标仓规则工作 | 否 |
| 用户选择安装治理 | runtime 层不复制 | F070 bootstrap 只 materialize preview 中选中的项目产物 | 是，确认后才写 |

当前 carrier 事实直接记录在这里，不另立 provider-matrix AC：

| Carrier | Clowder AI 规则载体 | 项目规则载体 |
|---------|-------------------|----------------|
| Claude | compiled L0 → `--system-prompt-file` | 原生读取 `CLAUDE.md`；需要共享指南时由薄文件 `@AGENTS.md` 导入 |
| Codex | compiled L0 → `developer_instructions` | 原生读取 cwd 向上的 `AGENTS.md` 链 |
| Gemini | 现有 route `systemPrompt` prompt channel | 默认读取 `GEMINI.md`；薄文件用 `@AGENTS.md` 导入，或由用户自行配置 `context.fileName` |
| Kimi | compiled L0 → `--agent-file`；legacy CLI 走既有 prompt prepend | 原生读取项目 `AGENTS.md` 链；F302 不生成非原生 `KIMI.md` |

Skills 继续由 F228/F301 的 HOME/project mount 决定，MCP 继续由 F249 在 invocation 时解析；F302 不复制它们的配置或状态。

## Product Contract

### 1. 默认零写入

- 外部项目 dispatch 不再调用 governance marker readiness；缺 Clowder AI 文档、registry entry 或 provider managed block 都不阻断。
- `resolvePersistentProjectPath` / external path allowlist、CLI sandbox、共享状态 preflight 等现有边界保持原 owner，不塞进 `PreflightResult` 换名续命。
- frontend/API 端口占用是单一 L0 协调规则，不扩展 `.claude/hooks/runtime-sanctuary-guard.sh`。该 hook 继续只保护其现有的 destructive runtime/worktree/Redis kill 边界。
- Redis 6399 保留现有 L0 铁律；F302 不再复制一条“Redis L0 + governance managed block”规则。

### 2. 一键治理变为显式选择

`BootstrapOptions` 在现有 `dryRun` 之外只增加 selection；空 selection 等于零写入。Project Setup 提供三个可选组，推荐 preset 只是这三个组的预选，不产生第四套含义：

| 组 | 内容 | 默认 |
|----|------|------|
| Project guide | 从目标 repo 真实 README / manifests / scripts 生成 canonical `AGENTS.md`；选 Claude/Gemini 时只加导入该文件的薄入口 | 空项目可推荐，已有项目关闭 |
| Project Skills | 只安装用户选择的 Skill 到用户选择的 provider surface；共享 refs 走既有 alias | 关闭 |
| Docs lifecycle | BACKLOG / ADR / Feature / SOP 模板与目录 | 关闭 |

preview 和 execute 必须消费同一 selection、返回同一 action 形状；现有文件不覆盖。`/api/projects/setup` 只负责 clone/init/skip 与项目状态，不再隐式 bootstrap。interactive `isEmptyDir=true` 可提示一次；非空项目只能由用户主动打开治理设置。`-p` / headless / bg-cron 没有携带精确 preview confirmation 时恒为零写入。

`AGENTS.md` 是 Project guide 的唯一正文。Codex 与 Kimi 直接消费它；Claude/Gemini 仅在对应 provider 被选择且目标文件不存在时生成 `@AGENTS.md` 薄入口。薄入口使用普通文本文件而非 symlink，避免 Windows 权限差异；已有 `CLAUDE.md` / `GEMINI.md` 一律保留并在 preview 中标为 skipped。F302 不自动修改 Gemini 的项目 settings，也不创造 `KIMI.md`。

### 3. 不建新的隐藏垃圾抽屉

- 新 F302 execution report 存回 Clowder AI 现有 `GovernanceRegistry`，不在目标仓新建 F302 `.cat-cafe/` report/ledger，也不新建第二个 data root；F289 将来只负责搬现有 registry 的根。
- provider 若原生要求项目文件，所选薄入口作为 preview 中可见的项目产物写入；不额外制造 ignored sidecar 来藏状态。
- `.cat-cafe/capabilities.json` 是 F228/F249 的共享配置。F070 bootstrap 历史上确实写过其中的 sync/mount 字段，但 F302 legacy cleanup **一律不修改它**；删除旧 symlink 后的 mount 健康由现有 `CapabilitySkillMountHealth` 呈现。

### 4. Legacy cleanup 只删能证明的旧生成物

- 旧 `governance-bootstrap-report.json` 的 `created` / `symlinked` action 只用于圈定候选，不单独构成删除授权。
- 普通文件只有当前正文仍等于对应 F070 pack/version 生成内容时可撤销；symlink 只有当前 target 仍等于旧 Clowder AI target 时可撤销。
- 不匹配、缺证据、已移动或被用户修改的候选沿用 `BootstrapAction.action=skipped` + `reason`，不建 generated/adopted/conflict enum。
- cleanup 不递归删除 `.cat-cafe/` 或 provider 目录；旧 report 本身仅在其候选全部处置且用户确认后列为最后一个可见 action。

### 5. 命令与 Skill 引用只认真实坐标

- bootstrap 直接读目标 repo 的 `package.json.scripts`；不存在的命令写 `unknown`，不得 fallback 到 Clowder AI 的 `pnpm gate` / `pnpm check`。
- 随身 Skill 中 Clowder AI 专属命令必须写明适用域；外部仓一律查该仓 scripts，没有就停在 unknown。
- ADR-025/F301 已定义 `.cat-cafe-shared-refs` alias，`sync-skills.sh --user` 也已有 HOME alias 写入逻辑。F302 只把仍裸写 `refs/*.md` 的 legacy Skill 引用统一到既有 `../.cat-cafe-shared-refs/*.md`，并验证 HOME mount 后可达。

## User Journey

### Primary Journey: 已有项目直接开工

- **Entry**: operator从 Clowder AI 选择一个已有 repo 并派遣猫。
- **Flow**:
  1. runtime 注入 Clowder AI L0 与 mission；carrier 从目标 cwd 读取项目自己的规则。
  2. 系统完成现有路径/权限边界检查后直接启动；不检查治理 marker，不写文件。
  3. 用户若想补治理，主动打开 Project Setup，选择组并查看 `BootstrapReport` exact actions/diff。
  4. 用户确认后才 execute；之后可从同一 action 账本 preview undo。
- **Success evidence**: 启动前后 `git status --porcelain` 完全一致；猫能复述 Clowder AI L0 与目标 repo 独有规则各自来自哪里。

### Supporting Journeys

| ID | Journey | Evidence |
|----|---------|----------|
| S1 | `isEmptyDir=true` 的 interactive 项目提示推荐最小治理 → 用户删减 selection → preview → confirm | empty-dir E2E + exact action snapshot |
| S2 | headless/cron 启动已有项目，没有精确 preview confirmation → 直接 zero-write dispatch | negative contract test |
| S3 | F070 legacy 项目 → report 圈候选 → dry-run cleanup → 只撤销当前仍匹配的 file/symlink，`capabilities.json` byte-for-byte 不变 | migration fixture + no-touch assertion |

## Acceptance Criteria

- [ ] **AC-1 Ownership**: `portable-governance` cell 只 owns bootstrap preview/execute/undo + legacy cleanup；does_not_own 明示 F203 prompt/L0、F228/F301 Skill mount、F249 MCP resolution、F293 dispatch/routing，ownership generator 通过。
- [ ] **AC-2 Single runtime rule**: 所有 Clowder AI managed carriers 的编译/注入测试证明当前 `FRONTEND_PORT` / `API_SERVER_PORT` 只从 L0 单一规则源到达 invocation；external managed block 不再承载该规则，F302 不新增 PreToolUse guard。
- [ ] **AC-3 Zero-write dispatch**: 外部 cwd 缺 registry、provider file、managed marker 时不产生 `governance_blocked`；dispatch fixture 前后 `git status --porcelain` byte-for-byte 一致。路径 allowlist、sandbox 与共享状态现有测试继续通过。
- [ ] **AC-4 Opt-in bootstrap**: `dryRun` preview 与 execute 接收同一 selection；未确认时零写入，确认后 action 只包含所选组；execute 重算出的 actions 若与已确认 preview 不同，则不写入并返回新 preview。`/api/projects/setup` 不再无条件 bootstrap，non-empty/headless/cron negative tests 通过。
- [ ] **AC-5 Repo truth**: 生成指南与 portable Skills 只引用目标 repo 真实 scripts 或 `unknown`；合并旧 B4/B7 为一组 fixture。全部 legacy `refs/*.md` 改用 ADR-025 alias，HOME/project mount reachability 通过。
- [ ] **AC-6 Minimal materialization**: canonical `AGENTS.md` + 用户所选的 `CLAUDE.md` / `GEMINI.md` 普通文本薄入口；不生成 `KIMI.md`，不覆盖已有入口；未选 provider/Skill/docs 不产生 action，不写 `.gitignore`，不新建 F302 `.cat-cafe/` state；`isEmptyDir` 仅在 `readdir` 成功且零条目时为 true。
- [ ] **AC-7 Safe legacy cleanup**: 旧 report 只圈 file/symlink 候选，当前内容/target 不匹配则 skipped；cleanup 后 `.cat-cafe/capabilities.json` byte-for-byte 不变，禁止递归删目录。
- [ ] **AC-8 Real expedition + public gate**: `clowder-ai-plugins` 完成 zero-write dispatch → minimal opt-in → undo；三阶段 exact diff、目标仓真实 test command、Hub evidence 可复核。随后在 disposable 目录导出 sanitized clowder-ai tree，运行目标仓 build/test 与同一旅程 fixture，证明公开版不解析 Clowder AI 私有 prompt、私有路径或未导出的 refs；公开行为变化附 F251 migration notes。

## 需求覆盖

| operator需求 | AC |
|------------|----|
| 复杂协作 harness 出门带什么 | AC-1, AC-2, AC-3, AC-5 |
| 已有项目默认不要制造大量垃圾 | AC-3, AC-4, AC-6 |
| `.xxxx` 不能只是把污染藏起来 | AC-6, AC-7 |
| docs 规范可以有但不默认生成 | AC-4, AC-6 |
| 没治理过的项目保留一键安装 | AC-4, AC-6 |
| 旧全量 bootstrap 安全收口 | AC-7, AC-8 |

## Public Impact / Outbound Sync

- clowder-ai 已有 F070 preflight、confirm 与 Project Setup surface。删除 marker dispatch gate、取消 setup 隐式全量 bootstrap、改为 selection preview 都是公开行为变化，必须按 F251 生成 migration notes。
- migration notes 说明新 zero-write 默认、用户如何主动安装最小治理、旧项目如何 preview cleanup 与 rollback。
- F302 不改 F228/F249 `capabilities.json` schema/priority；因此 legacy cleanup 不需要为 shared JSON 发明迁移协议。
- 开源包只消费 `sync-manifest.yaml` 导出的 runtime/templates/Skills 与 sanitizer 产物；测试不得借用 source-only HOME mount、私有 profile 或 Clowder AI 工作区绝对路径。source green 之后仍须在 disposable public tree 重新 build/test。
- F302 只交付“runtime 随身 + 默认零写入 + 可选最小 materialization”。外部团队治理仓的 discovery、信任、版本与分发模型不在本 feature 内，不能以 F302 完成名义关闭该社区需求。

Provider 文件契约以各 CLI 的公开文档为准，不复制成 Clowder AI 自有解释层：Claude 官方建议已有 `AGENTS.md` 的仓用 `CLAUDE.md` 导入；Codex 原生读取 `AGENTS.md`；Gemini 默认 `GEMINI.md` 且支持 `@file.md`；Kimi 项目指令使用 `AGENTS.md`。实现前若 carrier 版本事实变化，只更新本节与对应 fixture，不增设第二份 provider registry。

## Risk

| 风险 | 缓解 |
|------|------|
| 删 marker gate 时误删真实安全边界 | 只删 governance readiness；path allowlist、sandbox、shared-state 与 destructive sanctuary guard 各留原 owner |
| L0 端口值与 runtime 漂移 | 编译测试注入非默认 env 值，证明 emitted L0 使用当前 `FRONTEND_PORT` / `API_SERVER_PORT` |
| preview 与 execute selection 漂移 | 同一 `BootstrapOptions` + action snapshot；execute 前重算并显示冲突 |
| legacy cleanup 误删用户内容 | report 只圈候选，当前 content/target 必须匹配；配置 JSON 与目录递归删除硬禁止 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 新立 F302，不 reopen F070 | F070 是历史实现真相；F302 是其 zero-write / opt-in 产品演进 | 2026-08-21 |
| KD-2 | runtime-first、repo-owned、capability-on-demand | 身份/协作不靠复制，项目事实不靠 Clowder AI 模板伪造 | 2026-08-21 |
| KD-3 | 已有项目默认 zero-write，治理不是 dispatch readiness | 能安全开工与是否采用 Clowder AI docs lifecycle 是两个决定 | 2026-08-21 |
| KD-4 | 端口保留只进单一 L0 规则源，不造跨 carrier guard | 普通端口占用是协调约定；现有 sanctuary hook 保护的是不同的 destructive 边界 | 2026-08-22 |
| KD-5 | legacy cleanup 永不碰 `capabilities.json` | 它已是 F228/F249 活跃共享配置；health 可以暴露失效 mount，删除用户配置不可逆 | 2026-08-22 |
| KD-6 | 不依赖 F242 读取 repo scripts | `package.json.scripts` 是直接事实，不需要 convention-graph spike | 2026-08-22 |
| KD-7 | Project guide 正文只写 `AGENTS.md` | Codex/Kimi 原生消费；Claude/Gemini 用薄入口导入，减少重复正文并避免不存在的 `KIMI.md` 契约 | 2026-08-22 |

## Review Gate

- Kickoff 稀缺席位为 @fable5 `one_shot_calibration`；本次是该 verdict 的 docs-only 收敛，不复入原 reviewer。
- 实现 Project Setup selection UI 前，operator只签 preview → selection → confirm → undo 用户旅程；不另签 provider 研究矩阵。
- 触碰 clowder-ai 公开 surface 时走 F251 migration notes；实现阶段按实际行为/安全/契约风险选择一个匹配的非作者验证源。
