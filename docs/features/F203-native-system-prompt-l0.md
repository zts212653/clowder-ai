---
feature_ids: [F203]
related_features: [F086, F167, F198, F210, F211, F061]
topics: [system-prompt, governance, prompt-engineering, compression-immunity, l0-injection]
doc_kind: spec
created: 2026-05-15
---

# F203: Native System Prompt L0 — 压缩免疫核心规则注入

> **Status**: in-progress | **Owner**: Ragdoll Opus 4.7 | **Priority**: P1

## Why

### 最终目标（operator 2026-05-15 原话版本）

> "F203 的最终目标就是优化重构现在的系统提示词，让Ragdoll和Maine Coon不要受到太多原本不合理的系统提示词的影响，把我们自己原本应该构建在系统提示词但是没能进去的进入系统提示词。Claude Code 也好 Codex 也好那些客观性的系统提示词不能丢。"

**用人话翻译**：

1. **删掉默认系统提示词里和我们工作方式冲突的"主观行为指导"**——Claude Code/Codex 默认教我们"minimal fix / no comments / three similar lines is better than abstraction / don't add features beyond task / responses should be short and concise"。这些规则是为防普通 AI 过度工程化设计的，和我们家"愿景驱动 + TDD + 质量门禁 + 顺手治理"工作方式直接冲突——压缩后默认指令还在，我们的伙伴哲学不在，**糊弄赢**。

2. **把家规从 user message 切到 system role**——Magic Words / Rule 0 / P1-P5 / 球权三选一 / 五条铁律 / WORKFLOW_TRIGGERS / 协作哲学这些 P0 级规则当前通过 user message prepend 注入，每次压缩丢失需要重教（"10 轮对话教 10 次传球"）。切到 system role 后压缩免疫。

3. **保留默认系统提示词里的"客观性"内容**——operator明确约束。

### 客观性指令保留清单（不能丢）🔴

切换到 `--system-prompt` 替换式后，以下默认指令必须在我们的 L0 里 **重写或保留**：

| 默认指令段 | 内容 | 为什么不能丢 |
|----------|------|------------|
| `Wm3()` 工具执行模型 | tag 解释、权限、压缩感知 | 猫不知道自己会被压缩 → recall 时机失准 |
| `Gm3()` 危险操作可逆性 | destructive 操作前要确认 | 安全反射，删了 force push / drop table 没刹车 |
| `Rm3()` 工具使用 | 并行工具调用、工具优先级 | 删了猫不会自动并行调用 → 性能掉很多 |
| `Vm3()` Session-specific | Agent / Skill / TaskCreate / ScheduleWakeup / loop 使用规则 | 工具发现机制依赖这段，删了 Skill 加载/cron 都会断 |
| 工具描述段 | Read/Edit/Grep/Bash/PDF/image 的 schema 和使用说明 | 复杂工具 schema 删了模型不会用 |
| Git 操作模板 | commit / PR / 安全协议 | 删了模型不知道怎么做 git 操作 |

要删的"主观行为指导"清单：

| 默认指令 | 为什么删 |
|---------|---------|
| `Don't add features, refactor, or introduce abstractions beyond what the task requires` | 反愿景驱动 |
| `A bug fix doesn't need surrounding cleanup` | 反顺手治理 |
| `Three similar lines is better than a premature abstraction` | 反 DRY + 文件 350 行硬上限冲突 |
| `Don't add error handling for scenarios that can't happen` | 多猫异步协作"不可能"经常发生 |
| `Default to writing no comments` | 反 WHY 注释文化（ADR-030 §4） |
| `Don't design for hypothetical future requirements` | 反 Phase 规划 + 设计门禁 |
| `Your responses should be short and concise` | 复杂交接需要五件套结构 |

### 架构归属

**Architecture cell**: harness/system-prompt-injection
**Map delta**: update required（注入链从 user-message-prepend 改为 native-system-role；ADR-030 §3 已记新流程）
**Why（一句话）**：删默认糊弄哲学 + 加我们家规进 system role + 保留默认客观性指令。

## What

按 ADR-030 §10.2 14 项 L0 清单切换到 native system role 通道：
- **Claude 猫**：`ClaudeAgentService(-p)` 与 `ClaudeBgCarrierService(--bg)` 都走 `--system-prompt-file <compiled L0>`；carrier 选择只控制执行模式，不控制 F203 是否生效
- **Codex 猫**：`codex exec -c 'developer_instructions="<compiled L0>"'`（S4 实测 per-call 注入 ✅）
- **Gemini / Antigravity 猫**：2026-05-31 重新评估后拆线处理（KD-20/KD-21）：`gemini --acp` / Gemini CLI 不再作为 F203 主线；只保留 enterprise/API-key fallback。后续 native L0 重点转为两个 Antigravity spike：AGY CLI（headless Google carrier）与 Antigravity Desktop/IDE（Bengal）。
- **OpenCode 金渐层**：`opencode.json` `instructions` 字段注入 compiled L0 文件路径；runtime config 通过 `writeOpenCodeRuntimeConfig` 传入 instructions（KD-23，S8 源码验证 compression-immune）

### Phase A: Baseline + 扩展 spike（无风险前置）

S0-S5 spike 全部完成再进 Phase B。详见 Spike Log。

### Phase B: L0 真相源 + 编译脚本

- 写 `assets/system-prompts/system-prompt-l0.md`，分两段：
  - **客观性 carry-over 段**：把上述"客观性指令保留清单"6 项从 Claude Code 默认 prompt 提取/压缩/重写——工具能力 / 并行调用 / safety 反射 / 压缩感知 / Skill+TaskCreate+Schedule+loop / Git 模板
  - **家规段**：ADR-030 §10.2 列的 14 项 L0 内容
- 写 `scripts/compile-system-prompt-l0.mjs`（输出 per-cat L0 字符串：客观性段 + 身份 + 队友 + WORKFLOW_TRIGGERS + 家规段）
- 单测验证：客观性 6 项 + 家规 14 项全覆盖、token 总量 ≤ 4,500（含客观性段后上调）、per-breed 稳定（cache key 不漂移）

### Phase C: 实施 + runtime 重启验证（直接切，不灰度）

operator 2026-05-15 directive："如果不好我们都有 git log 能恢复——不搞灰度，那些太麻烦了 我们也不现实。"

- Claude carrier argv 加 `--system-prompt-file <compiled L0>`：`ClaudeAgentService(-p)` 与 `ClaudeBgCarrierService(--bg)` 行为一致（直接替换，不留 feature flag）
- `CodexAgentService.spawn` argv 加 `-c 'developer_instructions=<compiled L0>'`
- `effectivePrompt` 拼装逻辑：删除 `params.systemPrompt + promptWithMission` prepend 路径（system prompt 已在 argv 里，user message 只剩 prompt 本身）
- F-BLOAT 测试保护：resume 时 system prompt 不重复（spawn argv 每次新传，session 内不累积——靠 daemon/Codex 自身管理）
- 验证：runtime 重启后 47 + 46 + Maine Coon各跑一轮 + operator跑 10 轮含压缩对话——直接观察行为变化
- **回滚机制**：出问题operator说一声 → `git revert <commit>` + runtime 重启，3 分钟回滚

### Phase D: Root md 瘦身

- CLAUDE.md 188 行 → ~60 行：删 SOP 表、记忆系统详述、Knowledge Feed 完整段、代码规范、关键文档表；保留 identity + 五条铁律 + 流程闭环检查点 + Ragdoll专属规则
- AGENTS.md 207 行 → ~60 行：同比例
- 单独行动：root md 删队友静态表（SystemPromptBuilder 已动态生成，副本是漂移源），独立 PR 不阻塞主路径
- 验证：跑一次实际 invocation，确认压缩后 14 项规则仍在 system prompt 里、user message 显著瘦身

### Phase E: CC 版本升级拆解 SOP（重要远见）

operator 2026-05-15 原话："我估计每个 claude code 大版本更新我们需要拆一次 cc 的系统提示词，比如他添加了新的功能性系统提示词我们得补"。

落地：
- 写 `scripts/audit-claude-code-system-prompt.mjs`：`strings $(which claude) | grep -E '<patterns>'` 提取最新 system prompt 关键段
- `docs/audits/cc-system-prompt-vN.N.N.md`：每次升级后归档当时提取的内容
- 注册 cron / GitHub Action：检测 `claude --version` 变更 → 跑 audit → diff 上一版本 → 找新增"功能性"指令（工具发现 / safety / 压缩 / 新 agent 模式）→ 提案 PR 更新 `system-prompt-l0.md`
- 在 `cat-cafe-skills/refs/cc-system-prompt-audit-sop.md` 写 SOP：每次 CC 大版本（minor 及以上）必跑 audit
- 同款 SOP 对 Codex CLI 适用：`strings $(which codex)` audit + 归档

### Phase F: 配置栏 系统提示词可见化（operator 2026-05-16 提醒）

operator 2026-05-16 原话："我们的配置栏有个叫规则与SOP 我建议这里需要把我们替换的系统提示词和其他那样可见！这样方便人去看现在的系统提示词到底是什么？如果别人要定制修改也知道要去修改什么？"

**Why 现在补**：Phase C 把 L0 切到 native system role 后，L0 内容只在 `assets/system-prompts/system-prompt-l0.md` + compile 渲染时存在——operator（和其他人）没有可见入口看"当前注入到猫的系统提示词到底长什么样"。`packages/web/src/components/settings/settings-nav-config.ts:74-78` 已有 `id: 'rules'` 配置栏「规则与 SOP」（描述含"模型提示词入口"），但目前只展示家规/SOP 不展示 L0。

落地（待 Design Gate）：
- 配置栏「规则与 SOP」加 L0 系统提示词查看区：
  - 真相源：`assets/system-prompts/system-prompt-l0.md` template + per-cat 渲染产物（`compileL0({catId})` 输出）
  - per-cat 切换：opus-47 / codex / gpt52 / gemini 各自的 compiled L0 都能查看
  - 区分 template（含 `{{IDENTITY_BLOCK}}` 等占位）vs compiled（占位已替换）
- 自定义/修改路径明示：
  - 修改 template → 编辑 `assets/system-prompts/system-prompt-l0.md`
  - 修改 per-cat 渲染 → 改 `scripts/compile-system-prompt-l0.mjs` 的 builder helper
  - 改完 → `pnpm gate` + runtime 重启验收（KD-5 git revert 回滚通道）
- read-only 还是可编辑？→ Design Gate 决定（read-only 安全简单；可编辑要 + dirty/save/reload + 影响范围警告）

**Design Gate 决定（AC-F1，2026-05-16 opus-47，autonomous）**：**read-only**（做 AC-F2/F3/F4，**defer AC-F5 可编辑**）。依据：① operator experience是"**可见**/看...**到底是什么**/知道要去**修改什么**"——诉求是可见性 + 修改入口指引，非 in-app 编辑器；② AC-F5 spec 明标"（可选）"；③ L0 治理全猫 identity/家规/safety，web-editable = P0 风险面，而 file+git+`pnpm gate`+restart 已是 KD-5 文档化回滚通道，可编辑 marginal gain ≪ risk（YAGNI/P-value）。read-only 100% 覆盖operator诉求。AC-F5 additive，operator日后要 in-app 编辑可低成本重启。剩余 Design Gate（template/compiled 切换形态 + per-cat 切换 UX）走 console-dev 前端交付范式（Design gate 由设计/Siamese审，非逐步operator）。

依赖：Phase C 合入 main（L0 注入通道稳定后才有意义可见化）✅ 已合入。建议作为独立 PR / 独立 thread 跟进。

### Phase G: Governance L0 单源编译 + 消费链可见化（#747 / #749）

operator 2026-05-21 指令：先做 #747，再做 #749；#748 先讨论、暂不动。

**#747 问题**：`shared-rules.md` / `system-prompt-l0.md` §3 / `SystemPromptBuilder` fallback digest 曾是多份物理表示；`.local-override` 只挂在 fallback 路径。结果是同一套家规可能漂移，native L0 和 fallback 看到的治理内容不一定同源。

落地：
- 新增 governance L0 编译器：`cat-cafe-skills/refs/shared-rules.md` → deterministic compiled governance block。
- `assets/system-prompts/system-prompt-l0.md` §3 改为 `{{GOVERNANCE_L0}}`，native L0 每次编译时替换。
- `SystemPromptBuilder` fallback 不再维护硬编码 `GOVERNANCE_L0_DIGEST`，改读同一编译产物。
- `shared-rules.local.md` / `shared-rules.local-override.md` 挂到编译层：native + fallback 同时生效；override 保留旧语义（replace final governance block）。

**#749 问题**：Rules & SOP 面板只展示文件，没告诉人“这个文件到底有没有进 prompt”。Phase F 解决了 L0 可见，但没有解释消费链。

落地：
- `/api/rules` 返回 `consumption` 元数据：`actual-prompt` / `reference` / `skill-on-demand`。
- 「规则与 SOP」面板显示四类标签：
  - **实际进 prompt**：`shared-rules.md` → governance L0 compiler → native/fallback；L0 template / per-cat compiled L0。
  - **harness 注入**：root `AGENTS.md` / `CLAUDE.md` / `GEMINI.md` 这类 provider project-doc 会被对应 CLI/harness 注入上下文，但不是 Cat Café native L0 真相源。
  - **只是参考**：`docs/SOP.md` 等人工流程文档，不直接进入 native L0。
  - **skill 按需加载**：`SKILL.md` 仅在 skill 被选择/调用时读取。

**#748**（SOP vocabulary / `sop_navigation` 分散）：#747/#749 已合入；2026-05-22 社区（terrenceeLeung / 天一）提交设计提案（第三选项——新建 `SopDefinition` 单一源、`sop_navigation` 并入），方向对齐 green light。operator 决策：归 F203、不新开 F 号，作为 Phase G 之后的独立 work item；实现路径同 #747（Cat Café 上游实现 + 同步）。**2026-05-23 design pivot**（operator 反思 "skill = 软约束需硬约束兜底"）：① `hard_rules / pitfalls` **keep + 加 machine-checkable predicate 字段**（不 drop 不 park）——它们是 `eval:sop` domain 的 ground truth，feeds F192 Phase E-sop；② schema **domain-generic from day 1**——`development` 只是第一个 domain，未来 video-cocreation / tech-article / family-office 同 schema 不同实例（消除当前 video-forge / ppt-forge / tech-writing / expert-panel 等多阶段 skill = SOP 错位写进 skill body 的归位错位）；③ `sopDefinitionId` seam 定位重新校准——不是 "YAGNI future-proofing"，是多 domain 装载入口（§6.2 的真正价值）。**2026-05-23 implementation merged**（PR #1868, squash `3d5c76772`）：`sop-definitions/development.yaml` 成为 development SOP stage 单一机器可读源，`manifest.yaml:sop_navigation` 删除；schema/codegen/check 生成 runtime `SopStage` / `SOP_DEFINITIONS` catalog，API + Mission Control 面板改读 definition-derived suggested skill，`nextSkill` 明确为 override；18 条 hard rules / pitfalls 迁入 predicate-backed ground truth，cross-domain stubs 只参与 schema 校验不进 runtime union；F192 `eval:sop` runtime evaluator 仍按计划 out of scope。详见 Timeline 2026-05-22 / 2026-05-23 + clowder-ai#748 + F192 Phase E-sop。

## Acceptance Criteria

### Phase A（Baseline + 扩展 spike）

- [x] AC-A0: S0 — `claude --bg --system-prompt` 兼容性 spike（实测 job `f6474047` 暗号 `F198_BG_SYS_OK` 回收 ✅）
- [x] AC-A1: S1 — `scripts/measure-system-prompt.mjs` 量 baseline，每猫每模式（serial/parallel/independent）token 数表格 ✅ 2026-05-15 见 `docs/audits/2026-05-15-system-prompt-baseline-v0.md`
- [x] AC-A2: S2 — 扩展功能性 spike（Maine Coon review 修正后定稿 2026-05-15）：safety ✅ / 并行调用 ✅（误判已撤回）/ TaskCreate ✅ / Read schema ✅ / Skill 加载 ✅ / Schedule ✅ / 压缩感知 ✅。**0 项退化**。详见 `docs/audits/2026-05-15-functional-spike-s2-s3.md`
- [x] AC-A3: S3 — F-BLOAT 复现（部分完成 2026-05-15）：S3-a `--append-system-prompt` bg 模式能传内容 ✅（推翻历史"didn't receive content"注释）；S3-b resume 累积推迟到 Phase C 实施前跑
- [x] AC-A4: S4 — Codex `developer_instructions` per-call 注入（Maine Coon `62b9255e2` ✅）
- [⊘] AC-A5: S5 — Gemini `GEMINI_SYSTEM_MD` 替换式 spike **不再作为 F203 主线**（KD-20：consumer Gemini CLI/Code Assist requests 2026-06-18 停服；enterprise/API-key fallback 如未来明确需要再单独做）

### Phase B（L0 真相源）

- [x] AC-B1: `assets/system-prompts/system-prompt-l0.md` 包含 14 项全部内容 ✅（branch `9105d184f`，测试 `14 L0 governance items coverage` 全覆盖）
- [x] AC-B2: `scripts/compile-system-prompt-l0.mjs` 输出 per-cat 编译结果 ✅（6 catId 测试覆盖 + per-cat overlay 替换 + 36 测试全绿）
- [x] AC-B3: 编译 token 总量 ≤ **6,000** ✅（**三次上移**：4,500→5,000 见 KD-9；5,000→5,500 见 KD-14；5,600→6,000 见决策漏斗注入 PR #2040——§17 决策漏斗投影 + §4 默认自决反射，四猫讨论收敛 2026-06-01。6,000 占 200k context 3%）
- [x] AC-B4: per-breed cache key 稳定 ✅（same catId byte-identical 测试通过）

### Phase C（dual-path 落地）

- [x] AC-C1: Claude carriers argv 加 `--system-prompt-file <compileL0>` ✅（`ClaudeBgCarrierService` Task 3，commit `bfeaab76f`；`ClaudeAgentService(-p)` 2026-05-24 parity fix；l0CompilerFn seam + fail-closed compile error；claude-bg-carrier-l0.test.js + claude-agent-service F203 guard tests。KD-10/KD-18：走文件不硬编码，carrier 选择正交于 L0 注入）
- [x] AC-C2: `CodexAgentService` argv 加 `-c developer_instructions=<compileL0>` ✅（Task 4，commit `ebe904529`；per-call argv 不污染 `~/.codex/config.toml`，@codex/@gpt52/@spark cat-scoped；codex-agent-service-l0.test.js 3 tests，S4 Maine Coon `62b9255e2` 对齐）
- [x] AC-C3: 剥离 `params.systemPrompt` 非 pack prepend ✅（Task 2，commit `5305d08c4`；新增 `buildStaticIdentityPackOnly`，route-serial / route-parallel 通过 `injectsL0Natively()` 切 pack-only，非 pack 走 native system role；system-prompt-builder 113/113 守护零回归）
- [x] AC-C4: F-BLOAT resume 不累积 ✅（native `--system-prompt-file` replace-mode 天然免疫；pack-only 走未改的先验 new-session gate invoke-single-cat:1079-1088，invoke-single-cat-resume-health 覆盖）
- [x] AC-C5（merge-gate 部分）✅：PR #1709 squash-merged 2026-05-16T08:26Z（commit `d55cb688e`）；`pnpm gate` ✅（3070 tests），Maine Coon本地×2 round APPROVE（P1 cliConfigArgs + P1-cloud 修复），云端 round-1 抓 2 P1 全修，round-2 push back 1 P1（无现实复现，按 merge-gate 表降 P3-comment-pass）。2026-05-24 alpha probe 暴露 production default `ClaudeAgentService(-p)` 仍走 pre-F203 prompt path，本 fix 补齐两 Claude carriers 注入一致。**仍待**：runtime pull + restart 后，default `-p` 与 `bg_daemon` carrier 均需通过 behavioral probe，再跑 47/46/Maine Coon 各一轮 + operator 10 轮压缩对话客观性终验。

> Phase C 实施前置（执行顺序，防回归窗口）：Task 0 spike（`ca3efead7`）→ Task 1 A8 gap（`fd4e634ca`）→ Task 3a 共享 l0-compiler helper（`24dd15541`）→ Task 3/4 接通 → Task 2 删重复。终态：L0（非 pack 身份/家规/MCP）在压缩免疫 native system role，user message 仅 pack blocks + invocationContext + prompt。

### Phase D（root md 瘦身）

- [x] AC-D1: CLAUDE.md ≤ 65 行 ✅（200→62，PR #1710 squash `1c92a1d2b`）
- [x] AC-D2: AGENTS.md ≤ 65 行 ✅（219→60，同 PR）
- [x] AC-D3: 删队友静态表 ✅（CLAUDE.md/AGENTS.md 静态 roster 表删除，SystemPromptBuilder 动态生成为真相源）
- [x] AC-D4: 守护测试全绿 ✅（`root-md-slim.test.js` 9/9 + `f188-harness-consistency` 7/7 + `pnpm gate` 3070 tests；SystemPromptBuilder 未改动——Phase D 纯 root md 瘦身不碰 L0 注入链）

> Phase D merge：Maine Coon本地 APPROVE（no findings，47 盲审 quality-gate）→ 续 review 延续 ×2（rebase + 云端 P2 fix）→ 云端 round-1 P2（lineCount trailing-newline off-by-one，VERIFY 三道门 legit，已修对齐 wc -l）→ 云端 round-2 "no major issues"。terse 铁律/闭环检查点/各族专属 dev 规则保留，记忆三入口用 FULL `cat_cafe_*` 名（f188-compat）。L0 注入链 diff 证 untouched，live invocation 终验 batch 到 C5。

### Phase E（CC 版本升级 SOP）

- [x] AC-E1: `scripts/audit-claude-code-system-prompt.mjs` 实现 ✅（`--emit`/`--diff`/`--check`；strings 提取 + anchor diff + 版本漂移）
- [x] AC-E2: 当前 baseline 归档 ✅（既有富文档 `docs/audits/cc-system-prompt-v2.1.143.md`——spec 写 v2.1.142 为 stale，实测 claude=2.1.143——保留 §1-7 富文本 + 新增 §5b 机读 anchor block 使其成合法 `--diff` 源；脚本 `--emit` 自动化补充）
- [x] AC-E3: `cat-cafe-skills/refs/cc-system-prompt-audit-sop.md` SOP 写完 ✅
- [x] AC-E4: cron 注册 ✅（项目 scheduler `dyn-1778925760476-s1gprm`，weekly Mon 10:00；CI runner 无二进制故非 GitHub Action）
- [x] AC-E5: 同款 SOP 对 Codex CLI 适用 ✅（`--cli codex` 参数化——`which codex`=node launcher，复刻 launcher 解析 native 二进制——首份归档 `docs/audits/codex-system-prompt-v0.130.0.md`；2026-05-26 Codex 0.133 drift follow-up 归档 `docs/audits/codex-system-prompt-v0.133.0.md`，并补 resolver 适配 0.133 `vendor/<triple>/bin/codex` native layout）

### Phase F（系统提示词可见化）

- [x] AC-F1: Design Gate ✅ — read-only（defer AC-F5）+ template/compiled+per-cat UX 走同 RulesPromptsContent Section/Card/Modal pattern（operator"和其他那样"）
- [x] AC-F2: 「规则与 SOP」配置栏加 L0 查看区 ✅ — `RulesPromptsContent` 加第 3 个 `<Section>`，对接 `assets/system-prompts/system-prompt-l0.md` template
- [x] AC-F3: per-cat compiled L0 渲染查看 ✅ — `loadAvailableCatsForL0()`（no-arg loader，template+catalog merge）+ `compileL0ViaSubprocess` Promise.all（13 cats，实测 ~243-438ms 端到端）
- [x] AC-F4: 修改路径明示 ✅ — `l0Prompts.customization` API 字段（templatePath + compileScript + verifyCommand `pnpm gate + restart`）+ 前端 info row 渲染
- [⊘] AC-F5（可选）：可编辑（dirty/save/reload + 影响范围警告 + 写回）—— **Design Gate 决定 DEFER（不做）**：operator诉求是可见性非编辑器，web-editable 治理 prompt = P0 风险面，KD-5 file+git+gate+restart 已是回滚通道。additive，日后需要可低成本重启

### Phase G（Governance L0 单源编译 + 消费链）

- [x] AC-G1: `shared-rules.md` 编译生成 governance L0 ✅（`governance-l0.ts` deterministic compiler；缺 anchor fail-closed；测试覆盖 Rule 0 / P1-P5 / W1-W8 / Magic Words / A2A / family overlays）
- [x] AC-G2: native L0 与 fallback 共用同一编译产物 ✅（`system-prompt-l0.md` §3 `{{GOVERNANCE_L0}}` + `SystemPromptBuilder` 同读 `loadCompiledGovernanceL0*`）
- [x] AC-G3: `.local.md` / `.local-override.md` 挂到编译层 ✅（native + fallback 同时生效；override replace 语义保留）
- [x] AC-G4: Rules & SOP 面板展示消费链 ✅（`/api/rules` 增 `consumption`；前端 legend + card badge 显示“实际进 prompt / harness 注入 / 只是参考 / skill 按需加载”）
- [x] AC-G5: #748 SOP vocabulary / `sop_navigation` 收敛 ✅（Phase G 后续独立 work item；PR #1868 / squash `3d5c76772`：`SopDefinition` 单源 + generated runtime catalog + API/UI consumer chain）

### Phase H（Google / Antigravity carrier native L0 follow-up）

- [x] AC-H0: Gemini home-file + repo-root `GEMINI.md` 身份污染收口（native L0 spike 前置卫生）✅ 2026-06-01 — `renderForGemini` 退役为空（照 KD-14 `renderForCodex`：`~/.gemini/GEMINI.md` 由 `--apply` 清空 + `checkDrift` 守护），删随之 dead 的 renderer helper 链（interfaces / dynamic-roster / collab-rules 渲染）；repo-root `GEMINI.md` 化石身份（2026-02-28 Siamese / 4 猫 / stale model 标注 `gpt-5.3-codex`·`gpt-5.2`）改为 provider-neutral 指针并纳入 `root-md-slim.test.js` ≤65 行 + 无化石身份守护。**根因**：home `~/.gemini/GEMINI.md` 被 Antigravity IDE Global Rules + AGY CLI global context + Gemini carrier 读，repo-root `GEMINI.md` 被 Gemini CLI + AGY CLI workspace context 读（**非** IDE Global Rules——官方 IDE 只有 Workspace Rules 读 `.agents/rules`）；两处旧内容都把任意模型（含 opus）灌成"Siamese"。Siamese身份本由 runtime prompt-prepend 提供（`GeminiAgentService` 416/697），home-file 是冗余双注入（同 Codex KD-14）。**边界**：repo-root `AGENTS.md`（Codex harness 入口）对 AGY 也是 workspace 污染，但有 harness 依赖，AGY-safe 拆分留 AC-H1/H2 spike 设计，本轮不动。
- [x] AC-H1: AGY CLI native-L0 feasibility spike ✅ 2026-06-01 — 结论 **not reachable via public interface**（详见 Spike Log S6 + KD-22）：agy 1.0.4 公开面无 default/root agent override（CLI 无 `--agent`/`--system`、`settings.json` 无 agent field、Plugins/Hooks 只暴露 subagent 层 `define_subagent` + `agents/`）；binary 有 `agent_script`/`GetMainAgent`/`CustomAgentSpec` proto 但无公开提供入口。subagent `system_prompt` 是 reachable candidate 但**非 main-cat L0 carrier**（主 agent 仍裸 + 路由靠自觉 invoke）。**AGY 转 prompt-level fallback 做扎实**（profile 隔离 + context 污染收口 AC-H0 + 每轮 prepend + drift/版本守护）。POC 不做（边际价值 < 成本）。retraction：官方未来出 custom root agent / default-agent override / `--agent` flag 才重开。
- [x] AC-H2: Antigravity Desktop/IDE native-L0 feasibility spike ✅ 2026-06-01 — 结论 **not reachable via bridge**（重核当前 AntigravityBridge 代码，非沿用 F211 旧结论）：bridge 无 system/preamble channel——所有具名 `rpcSafe` 调用（`StartCascade` 只 `source`、`SendUserCascadeMessage` 只 `items.text`/`media`/`cascadeConfig`(planner+model)、`GetCascade*` 查询 + `Resolve`/`Acknowledge`/`Handle`/`Cancel` 控制）均无 system 字段；`callRpc` 公开泛型入口仅被 `RunCommandExecutor` 用于 shell pre-exec（非 prompt/config 注入，Maine Coon复核漏网点）；全文 grep `systemPrompt`/`preamble` 零匹配。身份注入路径 = `AntigravityAgentService` 把 `options.systemPrompt` prepend 进 `effectivePrompt`（first-prompt prepend）= prompt-level；IDE Global Rules(home `~/.gemini/GEMINI.md`)/Workspace Rules(`.agents/`) 也是 prompt-level（S6 Maine Coon确认非 native system role）。**Antigravity Desktop 转 prompt-level fallback**（同 AGY）。retraction：Antigravity bridge 协议未来新增 system/preamble cascade config 才重开。
- [ ] AC-H3: Gemini CLI/ACP fallback policy — `gemini-cli` / `gemini --acp` 仅为 enterprise / Google Cloud / paid API-key 用户保留；consumer/free/Pro/Ultra/Code Assist individuals 不再作为 F203 投入主线。

### Phase I（OpenCode 金渐层 native L0 注入）

- [x] AC-I1: S8 spike 完成——OpenCode `instructions` 压缩免疫性验证（源码验证，非运行时实验；证据 pin 到 `sst/opencode@v1.15.13` tag commit `385cb69`）
- [x] AC-I2: `opencode-config-template.ts` `generateOpenCodeRuntimeConfig()` 支持 `instructions` 字段 ✅（PR #2069）
- [x] AC-I3: `OpenCodeAgentService` `injectsL0Natively() → true` + `L0InjectableAgentService` typed seam ✅（PR #2069，方案①：invoke-single-cat 全路径生成含 instructions 的 runtime config + instructions-only fallback）
- [x] AC-I4: `invoke-single-cat.ts` 三路径守护 ✅（API-key/custom + subscription/unresolved + known-model/no-mcp，全 96 tests 覆盖）
- [x] AC-I5: `golden-chinchilla` workflow triggers ✅（developer flow + OMOC boundary + question deny）
- [x] AC-I6: `OPENCODE.md` 保留 + `permission.question=deny` / OMOC / compaction 不破坏 ✅（18 守护测试）
- [x] AC-I7: 全链守护测试 ✅（f203 18/18 + opencode-service 25/25 + invoke-single-cat 96/96 = 0 regressions）
- [ ] AC-I8: runtime 验收——金渐层 invocation 后确认 identity/roster/governance/workflow 在 system role，compaction 后不丢失

## Dependencies

- **Evolved from**: ADR-030（注入链地图 + 14 项 L0 清单 + spike-first 迁移路径）
- **Related**: F086（governance L0 digest 起源，本 feat 把 digest 通道从 user message 切到 system role）
- **Related**: F167（identity / A2A / 球权机制——L0 必须含传球三选一 + 球权第一人称）
- **Related**: F198（Claude bg carrier——本 feat 在 bg 模式下加 `--system-prompt`，已 spike S0 兼容）

## Risk

| 风险 | 缓解 |
|------|------|
| 替换式删了默认 system prompt 后某项**客观性**工具能力退化（如并行调用 / Skill 发现 / Schedule / safety reflex） | Phase A S2 扩展 spike 6 项功能性测试 + Phase B 客观性 carry-over 段（重写到我们 L0）双重保障；出问题 `git revert` 3 分钟回滚 |
| F-BLOAT 类 bug 重现（spawn argv 累积 / resume 重发） | Phase A S3 复现 + Phase C AC-C4 防御测试 |
| Anthropic prompt cache 失效（L0 内容变化导致 cache miss） | per-breed L0 稳定（AC-B4），变化因子只有 catId + packBlocks |
| Codex CLI argv override 在某些 model（如 spark）下不生效 | S4 已验证主线 codex，spark/gpt52 在 Phase C runtime 重启时同步验（AC-C5 三猫 invocation 覆盖） |
| CC 大版本升级带来新功能性指令，我们 L0 没补上导致功能退化 | Phase E SOP + cron 自动化触发 audit |
| 直接切（不灰度）导致全猫一起故障 | `git revert` + runtime 重启 3 分钟回滚；spike S0-S4 已验证替换式 basic feasibility |
| 把 Gemini consumer 6/18 deadline 误读为“Gemini CLI 对所有人死亡” | KD-20：consumer path 不再主线，但 enterprise / Google Cloud / paid API-key fallback 保留；不删除可用企业通道 |
| 把 AGY CLI 当成 Gemini ACP drop-in replacement | F210 Phase G 已证 `agy 1.0.1` 无 supported ACP；本机 `agy 1.0.3` help 仍无 `--acp` / `--model` / `--system`。必须 spike 后再接，不允许替换 `GeminiAcpAdapter` command |
| 把 Antigravity Rules / first-prompt prepend 当作 native L0 | AC-H2 要求区分 prompt-level fallback vs privileged system/preamble channel；只有后者才能标记 F203 native |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | Claude 走 `--system-prompt` 替换式而非 `--append-system-prompt` | spike S0 + ADR-030 §9.4 实测——替换式清除默认糊弄哲学，append 会和默认共存 | 2026-05-15 |
| KD-2 | Codex 走 argv `-c developer_instructions=...` 而非 `~/.codex/config.toml` 写入 | S4 验证（Maine Coon `62b9255e2`）——argv per-call 注入，多猫并发安全 | 2026-05-15 |
| KD-3 | Gemini 推迟到 Codex + Claude 跑通后 | operator directive 2026-05-15——Gemini 用量低，优先级 P2 | 2026-05-15 |
| KD-4 | Spike-first 路径：S0-S5 全部完成再进 Phase B | 47/Maine Coon ADR review 共识——避免 Phase 2 严重低估 | 2026-05-15 |
| KD-5 | 直接切替换式，不灰度不留 feature flag | operator directive 2026-05-15：「git log 能恢复就别搞灰度，那些太麻烦了我们也不现实」——`git revert` + runtime 重启 3 分钟回滚足够 | 2026-05-15 |
| KD-6 | Phase E 写 CC 版本升级 SOP | operator 2026-05-15 远见——每次 CC 大版本可能新增功能性指令我们要补 | 2026-05-15 |
| KD-7 | L0 必须含**客观性 carry-over 段**：工具能力 / 并行调用 / safety 反射 / 压缩感知 / Skill+TaskCreate+Schedule / Git 模板 | operator directive 2026-05-15：「Claude Code 也好 Codex 也好那些客观性的系统提示词不能丢」——替换式会丢 Anthropic 训练对齐的功能性指令，必须在我们 L0 重写 | 2026-05-15 |
| KD-7b | 客观性 carry-over 段降级为 ≤100t placeholder | S2 实测 partial L0 下 0 项功能性能力退化（safety/并行/工具发现/schema/Skill/Schedule/压缩感知）——模型内置 + 工具 description + 家规已覆盖。强制重写功能性指令是过度工程；未来 CC 升级 audit 出新指令再按需补 | 2026-05-15 |
| KD-8 | compile 脚本加 displayName→breed fallback 修 opus-47 无 workflow gap | opus-47 breedId='opus-47' 不在 {ragdoll,maine-coon,siamese}，现有 SystemPromptBuilder.ts:554 对其无 workflow（S1 实测 opus-47 workflow=0t）。F203 愿景"把该进的进去"——Ragdoll家族共享 ragdoll workflow。**行为变更**，Phase B review 需 reviewer 知悉 | 2026-05-15 |
| KD-9 | AC-B3 token 上限 4,500→5,000 | S1 baseline 实测 static 2,684-3,060t（高于立项前估算），14 项完整 L0 + 47 review 补 6 项物理下限 ~4,600t；per-family 治理已下沉 overlay 去重；5,000 仍在 prompt cache 单 breakpoint 内 | 2026-05-15 |
| KD-10 | L0 完全替换走 `--system-prompt-file` 从文件读，不硬编码 ts/js | operator directive 2026-05-15：「不能在 ts/js 里硬编码替换后的是什么，应该 --system-prompt-file 从文件读，单独 md 方便维护」。compile 渲染 per-cat L0 → 写文件 → Phase C spawn 引用文件路径；内容真相源始终是 `system-prompt-l0.md`。compile 脚本加 `writeL0File()` + CLI `--out` | 2026-05-15 |
| KD-11 | 仓库门禁必须 `pnpm biome` / `pnpm check`，禁止 `npx biome` | Maine Coon Phase B review P1 教训：`npx biome` 解析到 0.3.3，项目实际 `pnpm biome` 2.4.1，`npx` 证据绕过项目门禁=假绿。沉淀到 [[feedback_verify_with_repo_toolchain]] | 2026-05-15 |
| KD-12 | compile 脚本可测性重构：CLI 入口 + roster 过滤抽纯函数 | remote review P1（CLI entrypoint `file://${argv1}` POSIX-only，Windows broken）→ 抽 `isCliEntrypoint(metaUrl,argv1)` 用 fileURLToPath+resolve 跨平台；P2（roster 未过滤 available，disabled 猫进 L0 = dead-end @ 路由）→ 抽 `filterAvailableTeammates` + `isCatAvailable(id,config)` 过滤，对齐 SystemPromptBuilder:417。纯函数化使两者可单测（Red→Green，44 tests） | 2026-05-15 |
| KD-13 | compile bootstrap 必须 no-arg `loadCatConfig()` + roster model 用 `getCatModel` | 云端 round-2 抓到 KD-12 P2 连环 bug：`loadCatConfig(PATH)` 显式 path 跳过 `.cat-cafe/cat-catalog.json` overlay（cat-config-loader.ts:307-327）→ isCatAvailable 基于 stale template → P2 dead-end 防护失效。根治：no-arg `loadCatConfig()`（catalog overlay = runtime 真相）+ `resolveModel`→`getCatModel`（env override > registry）。**根治原则：compile 编译器必须复用 SystemPromptBuilder 既定 runtime 入口（catalog-aware loadCatConfig + getCatModel），不自造静态读取路径** | 2026-05-15 |
| KD-14 | codex user-layer strip：`~/.codex/AGENTS.md` 退役 + 「长任务纪律」迁入 native overlay + AC-B3 上限 5,000→5,500 | Maine Coon production 观察（cross-thread）：Codex invocation 的 developer 层已有 native L0，但 user 层仍被 Codex CLI 默认 prepend `~/.codex/AGENTS.md`（F050 sync-system-prompts.ts 渲染的 179 行静态身份/家规/队友/Magic Words）= 双重注入。根因：Phase C「精确剥离重复」只 strip 了 wrapper 的 user-message inline prepend，没收口 F050 home-file 路径。修复：`renderForCodex` 退役为空（`--apply` 清空文件，drift 守护）；Codex CLI 专属「长任务纪律」（exec_command session_id / 伪后台陷阱 / detached spawn 探针，L0 §6 maine-coon overlay 原本没有）迁入 native overlay。maine-coon 实测升至 5,154-5,155t，KD-9 的 5,000 buffer 耗尽 → AC-B3 上移到 5,500（物理下限随必要内容上移=真实测量，同 KD-9 逻辑，非脚手架；5,500 仍在 prompt cache 单 breakpoint 内 + 占 context 2.75%）。Gemini 路径（`renderForGemini`）暂留——Siamese未切 native L0 | 2026-05-20 |
| KD-15 | `shared-rules.md` 是 governance L0 唯一真相源；native + fallback 必须共用编译产物 | #747：手写 `system-prompt-l0.md` §3 + `SystemPromptBuilder` fallback digest + `shared-rules.md` 三份物理表示会漂移，且 `.local-override` 只影响 fallback。修复：`governance-l0.ts` deterministic compiler 读取 `shared-rules.md`，native L0 通过 `{{GOVERNANCE_L0}}` 注入，fallback 同读 `loadCompiledGovernanceL0*`；`.local.md` append / `.local-override.md` replace 在编译层统一处理。 | 2026-05-21 |
| KD-16 | Rules & SOP 面板必须展示 prompt 消费链，而不只是文件列表 | #749：operator需要知道“实际进 prompt / 只是参考 / skill 按需加载”。`/api/rules` 增 `consumption` 元数据，前端用四类标签显式展示 shared-rules→governance L0→native/fallback、root provider project-doc 的 harness 注入、SOP 参考文档、SKILL.md 按需加载。#748 词汇收敛 deferred，不抢跑。 | 2026-05-21 |
| KD-17 | Governance L0 compiler anchors must be sanitizer-invariant | Outbound sync public gate exposed a cross-repo drift: `_sanitize-rules.pl` rewrites family names in `cat-cafe-skills/refs/shared-rules.md`（`Maine Coon`→`Maine Coon`、`Siamese`→`Siamese`），but `packages/api/.../governance-l0.ts` was not sanitized and asserted exact localized headings. Result: exported public API startup failed before touching clowder-ai. Fix: assert stable protocol core anchors（`fallback 层数检测协议` / `创意-实现解耦协议`）and derive output labels from the actual heading, so internal output keeps localized labels and public output follows sanitized `Maine Coon` / `Siamese`. Do not sanitize `packages/` code to avoid rewriting runtime identifiers. | 2026-05-21 |
| KD-18 | Claude carrier 选择正交于 F203 native L0 注入 | AC-C5 alpha probe 发现 runtime default 仍走 `ClaudeAgentService(-p)`，而 Phase C 只在 opt-in `ClaudeBgCarrierService(--bg)` 接了 compiled L0。正确 invariant：`-p` vs `--bg` 只决定执行/会话模式，不能决定身份/家规是否进压缩免疫层；两条 Claude carrier 都必须用 `--system-prompt-file <compiled L0>`，且用户 `cliConfigArgs` 不得覆盖该保留 flag。 | 2026-05-24 |
| KD-19 | L0 必须把"家里独有能力 trigger reflex"显式注入认知路径，软提示发现率由 eval 数据驱动 iterate | operator观察："家里做了 browser-preview / rich-messaging / propose_thread 等很多功能猫猫竟然不知道可以用"——skills 在 manifest ≠ 在认知路径。猜测式选 Tier 1 不够；需 eval 跟测掉球率数据驱动 iterate。三猫盘点（47 6 self-check + Siamese 10 UX trigger + Maine Coon 8 backend trigger，合并去重 → 13 条 Tier 1）→ L0 §8 "Cat Café 家里独有能力唤醒指南（场景→skill 触发反射）"+ `cat-cafe-skills/refs/capability-wakeup-index.md` ref doc。Path C double-track：ship v1 不阻塞 + 并行 F192 reopen Phase F `eval:capability-wakeup`（per-cat per-scenario weekly miss rate verdict）→ N 周后数据驱动 §8 v2 iterate。operator 2026-05-27 sign-off Path C.1 + F192 reopen。 | 2026-05-27 |
| KD-20 | Gemini CLI / `gemini --acp` 不再作为 F203 native L0 主线，只保留 enterprise/API-key fallback | Google 2026-05-19 官方公告：consumer Gemini CLI / Gemini Code Assist IDE / GitHub requests for free, Google AI Pro, Ultra, and individuals stop being served on 2026-06-18；Standard/Enterprise、Google Cloud、paid Gemini / Gemini Enterprise Agent Platform API keys 继续。`gemini --acp` 是 Gemini CLI 的 ACP mode，不是独立免疫路线。家里 F210 已把非 ACP Google route 默认迁到 `GEMINI_ADAPTER=antigravity-cli`，但 catalog ACP entries 仍优先走 `gemini --acp`。因此 F203 不应继续把 S5 当主线投入。 | 2026-05-31 |
| KD-21 | Antigravity native L0 后续必须拆成两个 spike：AGY CLI 与 Antigravity Desktop/IDE | 两者不是同一个 carrier：AGY CLI 是 F210 headless Google successor，目标是替代 consumer Gemini CLI/ACP；Antigravity Desktop/IDE 是 F061/F211 Bengal bridge，目标是让Bengal获得 F203 native L0。当前 `agy 1.0.3` help 无 `--acp` / `--model` / `--system`；Desktop `SendUserCascadeMessage` payload 只有 text/media/model/cascadeConfig，无 system/preamble 字段。Rules / first-prompt prepend 只能算 prompt-level fallback。 | 2026-05-31 |
| KD-22 | AGY CLI native L0 不可达 → 转 prompt-level fallback | S6 spike（47 binary 深挖 + Maine Coon公开文档侦察协作）：agy 1.0.4 公开面无 default/root agent override（CLI 无 `--agent`/`--system`、`settings.json` 无 agent field、Plugins/Hooks 只暴露 subagent 层 `define_subagent` + `agents/`）；binary 有 `agent_script`/`GetMainAgent`/`CustomAgentSpec` proto 但无公开提供入口。subagent `system_prompt` 是 reachable candidate 但非 main-cat L0 carrier（主 agent 仍裸 + 路由靠自觉 invoke）。POC 边际价值 < 成本（不改"root agent 无 override"主结论）故不做。AGY 身份注入维持 prompt-level（profile 隔离 + 污染收口 AC-H0 + 每轮 prepend + drift/版本守护）。retraction：官方未来出 custom root agent / default-agent override / `--agent` flag 重开。 | 2026-06-01 |
| KD-23 | OpenCode `instructions` 是 native L0 可达通道——压缩免疫 by design | S8 源码验证（Ragdoll 46，pin `sst/opencode@v1.15.13` commit `385cb69`）：OpenCode 的 `opencode.json` `instructions` 数组指向的文件**每轮 fresh 读取**（`instruction.ts` `system()`）→ 注入为 `role: "system"` messages（`request.ts` `prepare()`，非 OpenAI-OAuth provider）→ **不进对话历史**（`compaction.ts` 只压缩 user/assistant turns）→ **功能等价 Claude `--system-prompt-file`**。Cat Café 的 `OpenCodeAgentService` 当前不调用 `compileL0`、不声明 `injectsL0Natively()`，route 层对金渐层走 full `buildStaticIdentity` prepend = 可被 compaction 吃。修复路径：runtime config `instructions` 注入 compiled L0 temp file + `injectsL0Natively() → true`。golden-chinchilla 需独立 workflow triggers（评估复用 ragdoll 或独立定义，因 model 是 opus-4-6 但 family 不同）。 | 2026-06-03 |

## Spike Log

> operator directive 2026-05-15：每次 spike 结果记录到本 feat md。

| # | Spike | Owner | 状态 | 证据 | 结论 |
|---|-------|-------|------|------|------|
| S0 | `claude --bg --system-prompt` 兼容性 | 47 | ✅ 2026-05-15 | thread `mp6b68w9w0wt1boc` job `f6474047`，暗号 `F198_BG_SYS_OK` 原样回收 | bg 模式接受 `--system-prompt` argv，替换式生效，daemon lifecycle 正常 |
| S1 | measure-system-prompt baseline | 47 | ✅ 2026-05-15 | `docs/audits/2026-05-15-system-prompt-baseline-v0.md` + 脚本 `scripts/measure-system-prompt.mjs`（feat/f203-spike-s1-baseline `046bfec17`） | 平均 3,302 tokens（18 sample，range 2,873-3,778）；GOVERNANCE_L0_DIGEST 47% 静态预算（~1,427t）；MCP_TOOLS_SECTION 467t（比 ADR 估算少 33%）；L0 ≤ 4,500 目标有 700-1,600t buffer |
| S2 | 扩展功能性 spike（Maine Coon review 修正后 7 项均测） | 47 | ✅ 2026-05-15（Maine Coon REQUEST_CHANGES → 修正） | `docs/audits/2026-05-15-functional-spike-s2-s3.md` (branch `4fdcfff98`) | **0 项退化**：safety/并行调用/TaskCreate/Read schema/Skill 加载/Schedule/压缩感知 全部 ✅。partial L0 已覆盖。Phase B carry-over 降级为 ≤100t placeholder |
| S3 | F-BLOAT 两失败模式复现 | 47 | 🟡 S3-a ✅ S3-b 推迟 | 同上 audit | S3-a `--append-system-prompt` bg 模式可传内容（推翻 invoke-single-cat:1086 注释）；S3-b resume 累积推迟到 Phase C 实施前跑 |
| S4 | Codex `developer_instructions` per-call | Maine Coon | ✅ 2026-05-15 | commit `62b9255e2` + ADR-030 §10.4:429-434 | `codex exec -c 'developer_instructions=...'` 高于 user prompt，不污染 config.toml |
| S5 | Gemini `GEMINI_SYSTEM_MD` 替换式 | 待定 | ⊘ 不做主线 | Google 2026-05-19 官方公告 + F210 Phase F/G + 本机 `gemini 0.42.0` help | KD-20：只保留 enterprise/API-key fallback；consumer path 不再投入 F203 native 主线 |
| S6 | AGY CLI native L0 / structured carrier feasibility | 47+Maine Coon | ✅ 2026-06-01 not reachable | agy 1.0.4 binary strings（`agent_script`/`GetMainAgent`/`CustomAgentSpec`/`SubagentName` proto 均内部无公开入口）+ CLI help 无 `--agent`/`--system` + `settings.json` 无 agent field + Maine Coon公开文档（Hooks `define_subagent` / Plugins `agents/` = subagent 层）三线对齐 | **AGY root native L0 = not reachable via public interface**；subagent `system_prompt` = reachable candidate 但非 main-cat L0 carrier（无 default-agent override，主 agent 裸 + 路由靠自觉）；POC 边际价值 < 成本故不做；AGY 转 prompt-level fallback（profile 隔离 + 污染收口 AC-H0 + prepend + drift 守护）|
| S7 | Antigravity Desktop/IDE native L0 feasibility | 47+Maine Coon(F211) | ✅ 2026-06-01 not reachable | 重核当前 AntigravityBridge：所有具名 rpcSafe 调用（StartCascade 只 source + SendUserCascadeMessage 只 items.text/media/model + GetCascade* 查询 + Resolve/Acknowledge/Handle/Cancel 控制）均无 system；callRpc 泛型入口仅 RunCommandExecutor 用于 shell pre-exec（非注入）；全文 grep systemPrompt/preamble 零匹配 | **bridge 无 native system channel** → 身份走 `AntigravityAgentService` prepend(options.systemPrompt→effectivePrompt)=prompt-level；IDE Rules 也 prompt-level；Antigravity Desktop 转 prompt-level fallback（同 AGY）|
| S8 | OpenCode `instructions` 压缩免疫性源码验证 | 46 (Ragdoll) | ✅ 2026-06-03 reachable + immune | 浅克隆 `sst/opencode`，证据 pin 到 **`v1.15.13` tag**（commit `385cb694419f98103af0e8fc6187ddcbcbb6eecb`），trace 三关键文件：① [`instruction.ts`](https://github.com/sst/opencode/blob/v1.15.13/packages/opencode/src/session/instruction.ts) `system()` — `config.instructions` 每轮 fresh 读取文件内容 ② [`request.ts`](https://github.com/sst/opencode/blob/v1.15.13/packages/opencode/src/session/llm/request.ts) `prepare()` — 非 OpenAI-OAuth provider（含 Anthropic）注入为 `role: "system"` messages ③ [`compaction.ts`](https://github.com/sst/opencode/blob/v1.15.13/packages/opencode/src/session/compaction.ts) — compaction 只压缩 user/assistant 轮次，system prompt 每轮从文件重建不受影响 | **OpenCode `instructions` = compression-immune by design**：文件内容每轮 fresh 读 → `role: "system"` 注入 → 不进对话历史 → 不被 compaction 吃。功能等价于 Claude `--system-prompt-file` / Codex `-c developer_instructions`。实现路径：`opencode-config-template.ts` 加 `instructions` 字段 + `OpenCodeAgentService` 加 `compileL0ViaSubprocess` + `injectsL0Natively() → true` + 加 golden-chinchilla workflow triggers。**实现风险**（Maine Coon P1）：`injectsL0Natively()=true` 后 route 层走 pack-only，但 `invoke-single-cat.ts:1326` 的 `OPENCODE_CONFIG` 有条件守卫——需确保所有 OpenCode invocation 路径都有 native L0 覆盖 |

## Review Gate

- Phase A: spike 结果由本人 + 跨族猫审视（47 跑 S1-S3 → Maine Coon review，Maine Coon S4 已交叉验证）
- Phase B: 跨族猫审 L0 编译脚本（架构 + 安全 + 客观性 carry-over 覆盖完整性）
- Phase C: 跨族猫审实施代码 + F-BLOAT 防御；runtime 重启后operator直接体感判断（10 轮对话 + 压缩）
- Phase D: 跨族猫审 root md 瘦身 diff
- Phase E: SOP 文档 review + cron 注册 review

## 需求点 Checklist

- [x] 关联检测完成（BACKLOG grep + features/ 扫描，无重复）
- [x] operator 立项 signoff（operator 2026-05-15 directive "我感觉好像需要立项"）
- [x] Architecture cell 归属（harness/system-prompt-injection，map delta: update required）
- [x] Eval Contract 4 项（Primary Users + Activation: 全猫每次 invocation；Friction: token 总量 + 压缩后规则保留率 + 客观性能力覆盖；Regression Fixture: SystemPromptBuilder 80+ test + S2 6 项功能性 spike；Sunset Signal: Phase E cleanup + cron audit ≥ 3 个 CC 版本无新增遗漏）
- [x] Design Gate 元审美自检（这是坐标变换——把 L0 从可压缩通道切到压缩免疫通道是结构改变，不是多项式堆补丁）
- [x] In-context Observability 字段（primary_surface: runtime 重启后猫猫 invocation 实际行为；why_not_dashboard_only: 行为退化在猫的回答里现场可见，dashboard 只是后置 metric；deep_dive_surface: docs/audits/cc-system-prompt-vN.N.N.md；noise_dedup_policy: `git revert` + runtime 重启快速回滚）
