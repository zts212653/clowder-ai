---
feature_ids: [F070]
related_features: [F038, F041, F042, F046, F049, F050, F058]
topics: [knowledge-engineering, governance, dispatch, cross-project, skills, bootstrap]
doc_kind: spec
created: 2026-03-06
---

# F070: Portable Governance — 猫咖方法论的可复制输出

> **Status**: done | **Owner**: Ragdoll
> **Completed**: 2026-03-08
> **Evolved from**: F041（能力Hub）+ F042（三层架构）+ F046（愿景守护）

## Why

猫咖的猫被派遣到外部项目（如 studio-flow）工作时，完全"失忆"——不知道 3001 端口是猫咖的、不知道 Redis production Redis (sacred)、不知道 SOP，甚至把 dev server 起在 3001 上导致猫咖前端 404。

根因不是"某个配置没带过去"，而是**能力注入 ≠ 治理继承**：现有能力 Hub（F041）已经能跨项目同步 MCP 配置，但 Skills、SOP、铁律、文档架构、Backlog 治理方法论——这些猫咖知识工程的核心——完全没有跨项目携带机制。

team lead的愿景：**猫咖不只是一个项目，是共创工作站。猫是team lead的永久团队，无论出征哪个项目，都带着完整的知识工程方法论。不需要打开其他 coding agent，不需要从零教规则。**

## What

在现有能力 Hub 基础上，扩展"治理层同步"能力：当猫首次被派遣到外部项目时，自动 bootstrap 猫咖的知识工程骨架，让派遣猫带着完整方法论工作。

### 定位

- Cat Cafe = **方法论中枢**（methodology hub）：SOP/Skills/协作规范/愿景守护的真相源
- 外部项目 = **独立执行面**（independent execution plane）：用猫咖方法论模板，但拥有自己的 BACKLOG/Feature/ADR
- **分区控制模型**：猫咖治理的是"怎么做"（方法论），外部项目治理的是"做什么"（自己的 backlog/feature）
- 猫咖不是外部项目的 BACKLOG 真相源——猫咖只输出方法论模板和工作流规范

## Scope: 携带什么

### 必携带（治理操作系统）

| 层 | 内容 | 形式 |
|----|------|------|
| 硬约束 | 端口保留表（3001=猫咖前端）、Redis production Redis (sacred)、禁止 self-review、身份不可冒充 | managed block in CLAUDE.md/AGENTS.md/GEMINI.md |
| 文档架构 | 三层信息架构（CLAUDE.md/Skills/refs）、frontmatter 契约、归档规则 | 模板 + 规范文档 |
| Backlog 治理 | Feature lifecycle 方法论（立项→讨论→开发→review→完成）、热/温/冷层 | ROADMAP.md 模板 + Feature 聚合文件模板 |
| SOP 工作流 | 6 步流程导航 + Skills 路由表 | SOP 模板 + manifest |
| Skills + 路由 | cat-cafe-skills symlink + manifest.yaml | project-level `.claude/skills/` symlink bootstrap |
| 协作规范 | A2A 交接五件套、愿景守护协议、review 流程 | shared-rules.md |
| 任务态上下文 | 当前 feat 的 AC、链接、phase | 派遣 thread 首条消息注入 |

### 不携带（各项目独立 or 猫咖私有）

- MEMORY.md 项目细节（猫咖私有上下文）
- 猫咖自己的 ROADMAP.md 条目（猫咖自己的功能规划）
- 猫咖自己的 Feature 聚合文件（猫咖自己的 spec）
- 猫咖自己的 ADR/lessons-learned 条目（但方法论模板会输出）
- SystemPromptBuilder 实现细节

注：外部项目会有**自己独立的** ROADMAP.md / Feature 文件 / ADR，由外部项目的猫独立管理。猫咖输出的是方法论模板（"怎么写"），不是具体条目（"写什么"）。

## Non-goals

- 不做整仓镜像（不把 `docs/` 全部 symlink 过去）
- 不做 BACKLOG 双向同步（外部项目用猫咖方法论但独立管理自己的 backlog）
- 不新建并行配置系统（复用现有 capability-orchestrator）
- 不强制外部项目改变已有的 build/test/style 规则

## Design: 三阶段 + 后续路线图

### Phase 1: 治理骨架 + 门禁 ✅（PR #265, 2026-03-07）

**已落地**：

| 组件 | 实现 | 文件 |
|------|------|------|
| Governance Pack | versioned managed block + checksum | `governance-pack.ts` |
| Bootstrap Engine | managed blocks + skills symlinks + methodology skeleton (no-overwrite) | `governance-bootstrap.ts` |
| Registry | 派遣审计注册表 | `governance-registry.ts` |
| Preflight Gate | per-provider fail-closed（anthropic→CLAUDE.md, openai→AGENTS.md, google→GEMINI.md） | `governance-preflight.ts` |
| Auto-sync | invoke-single-cat 派遣前自动重同步 confirmed 项目 | `invoke-single-cat.ts` + `capability-orchestrator.ts` |
| API | confirm + health + discover endpoints | `capabilities.ts` |
| Hub UI | 治理看板 + 历史项目发现 + ThreadSidebar 状态 badge | `HubGovernanceTab.tsx` + `SectionGroup.tsx` |
| Tests | 47 tests across 7 test files, 0 failures | `test/governance/` |

**Phase 1 已覆盖 AC**：AC-2, AC-3, AC-4, AC-5, AC-6, AC-7, AC-8, AC-9, AC-12, AC-13, AC-14, AC-15, AC-16, AC-18(部分), AC-19

**Phase 1 未覆盖（Phase 2 已补完）**：AC-1(hooks ✅), AC-10(协作规范 ✅), AC-11(任务包 ✅, 验证待 P3b), AC-17(回流, 待 P3a)

**Review 历程**：
- 本地 codex: R1(3P1+1P2) → R2(2P1) → R3(0P1/0P2 放行)
- 云端 codex: 0 P1/P2

### Phase 2: 任务包 + 运行时反射 ✅（PR #274, 2026-03-07）

**已落地**：

| 组件 | 实现 | 文件 |
|------|------|------|
| DispatchMissionPack | 5 字段结构化类型 (mission/work_item/phase/done_when/links) | `shared/types/capability.ts` |
| Mission Pack Builder | 从 thread metadata 构建任务包 | `mission-pack.ts` |
| Prompt Injection | 外部项目派遣时注入 system prompt | `invoke-single-cat.ts:326` |
| Hooks Symlink | Provider-agnostic hooks 软链（可选，源不存在跳过） | `governance-bootstrap.ts:76` |
| Managed Block v1.1.0 | 协作规范扩充 (shared-rules + skills 引用) | `governance-pack.ts` |
| Tests | 55 tests across 8 test files, 0 failures | `test/governance/` |

**Phase 2 新增覆盖 AC**：AC-1(hooks ✅), AC-10(协作规范 ✅), AC-11(任务包 ✅, 验证待 P3b)

**Review 历程**：
- 本地 codex: R4 放行 (0 P1/P2)
- 云端 codex: R1(1P2 frontmatter) → R2(0 P1/P2)

> **一句话**：让出征的猫不只"会守规矩"，还"知道自己来干嘛"。
>
> 三猫讨论共识（2026-03-07, opus + gpt52）

~~**2a. 派遣任务包注入**（AC-11 部分）~~ ✅ PR #274

猫被派遣到外部项目时，system prompt 注入结构化任务包：

```
mission:    1-3 句，这次去干嘛
work_item:  外部项目自己的任务标识（没有则退化成 thread title）
phase:      当前阶段（讨论中 / 实现中 / 待 review）
done_when:  最多 3 条完成标准
links:      相关入口链接
```

原则：**带方法，不带猫咖私有账本；带这次任务包，不灌整份 spec**。
技术路径：invoke-single-cat 从 thread metadata 提取 → system prompt injection。

~~**2b. Provider-agnostic Hooks 契约**（AC-1 完整版, TD099）~~ ✅ PR #274

- **目标层**：定义一套 provider-agnostic 的"猫咖标准 hooks 契约"（commit guard、quality gate pre-check）
- **适配层**：按 provider 做 adapter（`.claude/hooks/` / `.codex/hooks/` / `.gemini/hooks/`）
- **交付层**：实现可以分批，但 spec 目标是三家一致，不降级为 claude-only

~~**2c. 协作规范显式注入**（AC-10 完整版）~~ ✅ PR #274

managed block 扩充协作方法论段落：
- A2A 交接五件套引用
- 愿景守护协议引用
- Review 流程引用（不是全文搬入，而是指向 shared-rules.md 和 skills 路由）

### Phase 3: 回流 + 闭环验证

> **一句话**：让猫咖不只"知道同步过没有"，还"知道这次出征带回了什么"。

**3a. 执行结果最小回流** ✅（AC-17）

| 组件 | 实现 | 文件 |
|------|------|------|
| DispatchExecutionDigest | 结构化执行摘要类型 (status/doneWhenResults/filesChanged) | `shared/types/capability.ts` |
| ExecutionDigestStore | 内存存储 + CRUD | `execution-digest-store.ts` |
| captureExecutionDigest | 纯函数：mission pack + completion → digest | `execution-digest-capture.ts` |
| Backflow Hook | invoke-single-cat done handler → best-effort digest capture | `invoke-single-cat.ts` |
| API Routes | GET /api/execution-digests (?projectPath=, ?threadId=, /:id) | `execution-digests.ts` |
| Tests | 16 tests (5 store + 5 capture + 6 routes) | `test/execution-digest-*.test.js` |

**3b. 真实出征闭环验证**（AC-11 完整版）— 待出征后验证

- 选一个真实外部项目，刻意按猫咖 SOP 跑完整闭环
- 验证：feat 立项 → 讨论 → worktree → TDD → quality gate → review → merge
- 记录卡点，作为后续迭代输入
- 这是验证任务，不是代码任务

**3c. Mission Hub 跨项目推进** ✅

| 组件 | 实现 | 文件 |
|------|------|------|
| DispatchProgress | 派遣进展列表 (status badge/doneWhen checklist/files) | `DispatchProgress.tsx` |
| GovernanceHealth 增强 | 派遣统计 (次数/完成率/标准达成率) | `GovernanceHealth.tsx` |
| ExternalProjectTab | "派遣进展" sub-tab + digest loading | `ExternalProjectTab.tsx` |
| Zustand Store | executionDigests + setExecutionDigests | `externalProjectStore.ts` |

### 原始设计参考（Phase A/B/C → Phase 1/2/3 映射）

原始三阶段设计（Phase A/B/C）已重构为上述三阶段。映射关系：
- Phase A（定义带什么）→ Phase 1 ✅
- Phase B（怎么带）→ Phase 1 ✅ + Phase 2（任务包 + hooks）
- Phase C（确认带了 + 持续同步）→ Phase 1 ✅（preflight） + Phase 3（回流）

## Conflict Contract（冲突规则）

| 类别 | 优先级 |
|------|--------|
| 猫咖安全铁律（端口/Redis/身份） | 不可覆盖 |
| 猫咖协作规范（A2A/review/愿景守护） | 不可覆盖 |
| 猫咖 SOP 工作流 | 安全/协作底线不可替换，执行流程可由外部项目映射/裁剪 |
| 外部项目 build/test/style/架构约束 | 外部项目优先 |
| 任务态上下文 | 仅对当次派遣生效 |

## Acceptance Criteria

- [x] AC-A1: 本文档需在本轮迁移后维持模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。

### 核心 AC
- [x] AC-1: 空白外部项目首次派遣，自动 bootstrap 完整治理骨架（managed block + skills + hooks + 方法论模板）— **Phase 1 + Phase 2 ✅**
- [x] AC-2: 已有自己 CLAUDE.md/docs/ROADMAP.md 的外部项目，managed block 共存不冲突，已有文件不被覆盖 — **Phase 1 ✅**
- [x] AC-3: 重复派遣幂等（版本戳 + checksum）— **Phase 1 ✅**
- [x] AC-4: 缺失治理文件时 Preflight Gate 阻断生效（fail-closed，per-provider）— **Phase 1 ✅**
- [x] AC-5: 回滚后可再同步（版本漂移检测 + 修复）— **Phase 1 ✅**
- [x] AC-6: Mission Hub 可见同步健康状态（哪个项目裸奔、版本、最近校验）— **Phase 1 ✅**

### 方法论输出 AC
- [x] AC-7: 外部项目获得文档架构模板（docs/ 目录结构 + frontmatter 契约）— **Phase 1 ✅**
- [x] AC-8: 外部项目获得 Backlog 治理模板（ROADMAP.md + Feature 聚合文件模板）— **Phase 1 ✅**
- [x] AC-9: 外部项目获得 SOP 工作流模板 + Skills 路由 — **Phase 1 ✅**
- [x] AC-10: 外部项目获得协作规范（shared-rules + A2A + 愿景守护）— **Phase 1 (skills symlink) + Phase 2c ✅ (managed block 显式引用)**
- [x] AC-11: 派遣猫能在外部项目按猫咖 feat/backlog/SOP 跑完整闭环 — **Phase 2a ✅ (任务包注入), Phase 3b 待验证**

### 审计 AC（codex 硬要求）
- [x] AC-12: Bootstrap 触发点双保险（dispatch + invoke 前校验）— **Phase 1 ✅**
- [x] AC-13: 复用现有 capability-orchestrator，不新建并行系统 — **Phase 1 ✅**
- [x] AC-14: 治理载体是 versioned portable pack（含 checksum + managed block），不是整仓镜像 — **Phase 1 ✅**
- [x] AC-15: 派遣注册表可审计（首次派遣时间、同步版本、校验时间、状态）— **Phase 1 ✅**
- [x] AC-16: Bootstrap 结果落盘可回放（做了什么、跳过什么、冲突什么）— **Phase 1 ✅**

### 回流与闭环 AC（gpt52 P1-3 修复）
- [x] AC-17: 外部项目执行结果可回流猫咖追踪（派遣任务状态在 Mission Hub 可见，不需要去外部项目找）— **Phase 3a ✅ + Phase 3c ✅**
- [x] AC-18: Bootstrap 支持 dry-run 模式 + 回滚清单（已有文件无损策略）— **Phase 1 ✅（dry-run + report 含清单）**

### 跨 provider AC（gpt52 P2-2 修复）
- [x] AC-19: Skills bootstrap 覆盖三家 provider（`.claude/skills/` + `.codex/skills/` + `.gemini/skills/`），不只 Claude — **Phase 1 ✅**

## Dependencies

- **Evolved from**: F041/F042（能力 Hub + 三层架构）
- **Related**: F046/F049/F058（愿景守护与 Mission Hub 基础设施）
| 依赖 | 关系 |
|------|------|
| F041 能力 Hub | Evolved from — 复用其跨项目 bootstrap 底座 |
| F042 三层信息架构 | Evolved from — 方法论的核心结构 |
| F046 愿景守护协议 | Related — 愿景守护是携带内容之一 |
| F038 Skills 发现机制 | Related — project-level skills workaround |
| F049/F058 Mission Hub | Related — 派遣触发点 + 状态显示 |
| F050 External Agent Onboarding | Related — A2A 接入契约 |
| TD099 Hook 归一化 | Blocked by — 并入 Phase A |

## Risk

1. **过度污染外部项目**：managed block + 版本戳确保可控，不做整仓镜像
2. **外部项目规则冲突**：Conflict Contract 显式定义优先级
3. **Skills symlink 不稳定**：F038 已证明 user-level symlink 有 bug，需要 project-level workaround
4. **方法论过重**：外部项目可能只需要轻量级治理，需要可选层级

## Review Gate

- R1: codex 审安全边界 + 回归矩阵
- R2: gpt52 审架构完整性 + 闭环验证
- 云端 review: PR 级

## 需求点 Checklist

| # | 需求点 | AC 映射 | 状态 | Phase |
|---|--------|---------|------|-------|
| R1 | 空白项目 bootstrap | AC-1 | done | 1+2 ✅ |
| R2 | 已有规则项目共存 | AC-2 | done | 1 ✅ |
| R3 | 幂等同步 | AC-3 | done | 1 ✅ |
| R4 | Preflight Gate fail-closed | AC-4 | done | 1 ✅ |
| R5 | 版本漂移检测与修复 | AC-5 | done | 1 ✅ |
| R6 | Mission Hub 健康状态 | AC-6 | done | 1 ✅ |
| R7 | 文档架构模板输出 | AC-7 | done | 1 ✅ |
| R8 | Backlog 治理模板输出 | AC-8 | done | 1 ✅ |
| R9 | SOP + Skills 路由输出 | AC-9 | done | 1 ✅ |
| R10 | 协作规范输出 | AC-10 | done | 1(symlink) + P2c ✅ |
| R11 | 派遣猫完整闭环 | AC-11 | partial | P2a ✅ + P3b(验证) |
| R12 | 双保险触发点 | AC-12 | done | 1 ✅ |
| R13 | 复用 capability-orchestrator | AC-13 | done | 1 ✅ |
| R14 | versioned portable pack | AC-14 | done | 1 ✅ |
| R15 | 派遣注册表审计 | AC-15 | done | 1 ✅ |
| R16 | Bootstrap 结果落盘 | AC-16 | done | 1 ✅ |
| R17 | 回流路径（Mission Hub 追踪） | AC-17 | done | P3a+3c ✅ |
| R18 | dry-run + 回滚清单 | AC-18 | done | 1 ✅ |
| R19 | 跨 provider skills bootstrap | AC-19 | done | 1 ✅ |

## Post-Closure Gap Fixes

| Gap | Issue | Fix | PR |
|-----|-------|-----|-----|
| governance-pack.ts leaks internal ports (3001/6399) to open-source | clowder-ai#97 | Source keeps internal defaults; sync-to-opensource.sh transforms port lines to public defaults (Frontend=3003, API=3004). Redis ports stay as-is (6399/6398) — open-source uses same ports. Version bumped to 1.3.0. | #532 |
| Preflight gate blocks new projects without guidance | clowder-ai#123 | `PreflightResult` extended with `needsBootstrap`/`needsConfirmation`/`bootstrapCommand`; invoke-single-cat emits actionable instructions | #532 |
| setup.sh missing skills sync step | clowder-ai#21 | Added Step 5/6 to setup.sh: links cat-cafe-skills/* to ~/.{claude,codex,gemini}/skills (ADR-009 pattern) | #532 |
| Governance blocked shows raw text, no actionable UX | clowder-ai#154 | Structured `governance_blocked` event + `GovernanceBlockedCard` with one-click bootstrap+retry button. All 4 routeExecution consumer paths capture `errorCode`. Inspired by community PR clowder-ai#154. | #602 |
| New project opens without setup guidance | clowder-ai#321 | `ProjectSetupCard`: thread-open-time clone/init/skip setup flow with anime cat illustrations, `useGovernanceStatus` hook, 3 API endpoints (mkdir/status/setup). Design: `designs/f070-project-setup-card.pen` | clowder-ai#299 |

## Key Decisions

| 决策 | 理由 | 来源 |
|------|------|------|
| 能力注入 ≠ 治理继承 | MCP 同步不等于方法论同步 | 三猫讨论 2026-03-06 |
| methodology hub 留猫咖（分区控制模型） | 避免真相源分裂 | gpt52 建议 |
| 复用 capability-orchestrator | 不新建并行系统 | codex 硬约束 |
| TD099 并入 Phase A | hook 归一化是闭环关键 | codex 建议 |
| 分区控制模型 | 猫咖管"怎么做"（方法论），外部项目管"做什么"（自己的 backlog） | gpt52 P1-1 修复 |
| 无损 bootstrap | 已有文件不覆盖，支持 dry-run + 回滚 | gpt52 P1-2 修复 |
| 回流路径验收化 | 外部执行结果必须在 Mission Hub 可追踪 | gpt52 P1-3 修复 |
| 能力 Hub 集成方法论更新 | 复用现有多项目管理 UI | team lead指出 |
| 首次确认后自动写入 | 第一次友好问确认，之后同项目自动同步 | team lead拍板 2026-03-06 |
| 任务包结构化 5 字段 | mission/work_item/phase/done_when/links — 带方法不带私有账本 | opus+gpt52 共识 2026-03-07 |
| Hooks spec 目标三家一致 | 实现可分批，但 spec 不降级为 claude-only | gpt52 建议 2026-03-07 |
| 回流最小可交付 | 做了什么/改了哪些文件/当前状态/是否需要决策 — Hub 可见 | gpt52 建议 2026-03-07 |
