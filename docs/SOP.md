---
feature_ids: [F042]
topics: [sop]
doc_kind: note
created: 2026-02-26
updated: 2026-07-27
---

# Clowder AI 开发 SOP

> 三猫开发全流程的导航图。每步的详细操作在对应 skill 内。
> Stage id / suggested skill / hard rules / pitfalls 的机器真相源是
> `sop-definitions/development.yaml`；本文件保留人类可读叙事。
> 冲突时先修 SopDefinition 单一源，再同步本文件和相关 skill。
> 共创型文档的风险分类真相源是 `scripts/co-creation-docs-lane.mjs`，执行细节在
> `co-creation-docs` skill；它不是 development stage 的缩水副本。

## 愿景驱动（核心原则）

Clowder AI 的开发是**愿景驱动**的。和operator确认了 feature 的愿景后：

- **没达成愿景 = 没完成**，不交半成品，不半路问"要不要继续"（决策漏斗见 shared-rules §17）
- 停下来的正当理由：解决不了的阻塞（技术限制/外部依赖）→ 升级operator；方向存疑（坐标系警报、scope 该砍）→ 停手重估。判断力允许停，惰性不允许

### 大 Feature 碰头机制（3+ Phase）

大 scope feature 不能等最后才对齐愿景。**每个 Phase merge 后**，主动和operator碰头：

```
Phase N merge → 碰头（不是"要不要继续"，是"方向对不对"）→ 继续 Phase N+1
```

**碰头格式**（轻量，不是报告会）：
1. **成果展示**：这个 Phase 做了什么（截图 / 关键改动 / demo）
2. **愿景进度**：离最终愿景还差什么（哪些 AC 打了勾，哪些还没）
3. **下个 Phase 方向**：下一步计划做什么，有没有发现新问题
4. **方向确认**："方向对吗？有没有要调整的？"

**注意区别**：
- 碰头 = **愿景方向确认**（宏观层，operator需要介入）✅
- "要我继续吗？" = **SOP 流程推进**（细节层，不要问）❌

**小 Feature（1-2 Phase）**：不需要碰头，直接做到底 → 愿景守护 → close。

## Runtime 单实例保护（P0）

`../cat-cafe-runtime` 是咱们的运行态单实例（通常占用 `3003/3004`），默认视为**在线服务**，不是随手重启的实验环境。

硬规则：
1. 在 runtime 会话里，禁止执行会触发重启的命令：`pnpm start`、`pnpm runtime:start`、`./scripts/start-dev.sh`
2. 做截图/验收/排查前，先复用现有服务（先查 `curl -sf http://localhost:3004/health`）
3. 确实要重启，必须先拿到operator明确同意，再显式设置 `CAT_CAFE_RUNTIME_RESTART_OK=1` 执行启动命令

说明：`--force` 不是重启授权，不能替代第 3 条。

## Alpha 验收通道

`../cat-cafe-alpha` 是基于最新 `origin/main` 的隔离测试环境，供operator和猫猫们验收最新改动，不干扰 runtime。

| 命令 | 作用 |
|------|------|
| `pnpm alpha:start` | 自动同步 origin/main + 拉起 3011/3012/4111/6398 |
| `pnpm alpha:sync` | 只同步不启动 |
| `pnpm alpha:status` | 查看环境状态 |

使用场景：
- 愿景守护：守护猫用 alpha 独立验证已合入 main 的改动，不依赖开发猫提供环境
- operator测试：稳定的测试入口，和 runtime 互不干扰
- PR merge 后验收：确认合入 main 的改动在完整环境中工作正常

**注意**：alpha = origin/main 镜像，只能验证已合入 main 的改动。未合入改动的自测仍在 feature worktree 上做。已合入改动的验收用 alpha（3011/3012），不得用 runtime（3003/3004）冒充。

## Risk-Routed Development：铁路改立交

**强制力跟着风险走，不跟着动作类型走。** “写了代码”“开了 PR”“进入 merge”都不能单独触发整条流水线。默认是最小安全动作；只有命中客观风险面才进入对应加严车道。

### 入口：五轴风险判断

| 风险轴 | 命中信号 | 最低动作 |
|---|---|---|
| 行为面 | 用户可见行为、runtime 逻辑、bug 回归 | 可观察 RED + targeted 验证；方向未定才进 Design Gate |
| 数据 | 生产数据、迁移、持久化语义 | full gate + 独立高风险 review；生产操作另走授权边界 |
| 安全 | auth、权限、secret、注入、DoS / 资源边界 | full gate + cloud/context-blind 安全扫描；需要家里语义时再叠 local |
| 契约 | API / MCP schema / 事件格式 / 外部依赖 | 契约测试 + full gate + 对应独立 review |
| 不可逆 | 删除、force push、合第三方 PR、close feat、圣域 | 先拿 operator 授权；机器门禁仍照常 |

**元风险强制升档**：diff 触碰 `merge-gate`、风险 classifier、门禁脚本或 Harness Diet 公约自身时，直接进入 high-assurance，由非作者跨族 reviewer 覆盖最终实质内容（exact HEAD 或 continuityProof）。松绑机制不得静默松绑自己；在这条语义边界机器化前，如实标为 manual 守卫，不能由改门者自判 light。

五轴都未命中且改动可逆、无外部副作用 → 最小安全动作。信息不足不等于自动全套：先补查缺失事实，再按真实风险选车道。

### 按需车道

`sop-definitions/development.yaml` 的 stage id 是 Mission Hub 告示牌车道，不是必须按顺序经过的状态机。选中车道后再加载对应 skill：

| 车道 | 触发条件 | 不因什么触发 |
|---|---|---|
| Design Gate / kickoff | 新 feature、UX / 架构方向未定、价值取舍 | 每个实现任务 |
| `writing-plans` | 跨组件、状态对象、实现顺序不清，且没有详细计划 | 文件超过 5 行 |
| `worktree` | tracked code、skill、SOP definition、脚本或第一方执行面需要隔离 | 纯 docs 已自判 light，或 classifier 已放行 direct push |
| `tdd` | 新行为、bug、未被现有精确检查覆盖的逻辑 | 确定性生成物刷新；现有 checker 红已经是 RED |
| targeted self-check | 所有交付；命令按风险面选 | 为了“报告完整”跑无关全仓测试 |
| `fresh-context` | author 判断当前上下文盲点高 | 非 trivial 就自动触发 |
| local peer | 家里语境、治理 / skill / SOP、实现语义 | 已选择 cloud 仍固定叠一层 |
| cloud review | 安全、数据、契约或陌生跨包代码需要 context-blind 扫描 | 普通 `packages/**` / test / PR 载体本身 |
| merge-gate | PR / branch policy 需要合入；验证深度消费前述风险判断 | 自动重跑 local + cloud 全套 |
| 愿景守护 | 用户可见或愿景变化的 feature close | 每个 PR、纯机械内部 change |

### Review 去叠加

默认选择**一个合适的独立验证源**，且必须是非作者：

- local peer 看家里语境与 stateful diff；
- cloud 看 context-blind 高风险代码面；
- 愿景守护看最终产品结果，只在 feature close 触发。

只有不同风险面确实需要不同视角时才叠加，并分别写明触发理由。P1/P2 修复后只回提出 finding 的 active source 覆盖真实修复 delta；不把另一个旧 reviewer 拉来续签，也不因 SHA-only / 可证明机械变化重开 reviewer。

### Sol 测试

任何存活的 `must` 都问：**一只完美遵从的猫 100% 执行后，系统是否仍然更好？** 不能稳定回答“是”的条款应删除或降为建议。终态不是猫学会打折，而是规则配得上全额遵从。安全、授权、真实性与不可逆结果边界优先交给机器 / 权限系统守，不靠把文字写凶。

## 约定面改动预检（F242）

改 MCP tool、skill manifest、route、workflow callback 等约定面前，先用 convention graph 查影响面，避免只靠 grep 漏掉注册链或动态消费方。
SOP eval 会对约定面 changed files 要求成功的 `code-consumers` 命令证据；查到 `freshness.stale=true` 时先 reindex，不拿 stale 结果当真。

```bash
pnpm convention-graph:index -- --repo .
MCP_TOOL_NAME=replace_with_tool_name
pnpm convention-graph:code-consumers -- --repo . --domain mcp-tool --kind mcp_tool --name "$MCP_TOOL_NAME"
```

查询结果里的 `freshness.stale=true` 表示图不能当 fresh 证据；先重跑 `pnpm convention-graph:index -- --repo .`，再做影响面判断。

## 例外路径

### Co-Creation Docs Lane（按风险，不按行数）

适用于operator与猫共同审阅、修订并授权落盘的 docs-only 内容，例如 architecture overview、思想纲领、discussion、研究笔记。只请 review 没有授权落盘时保持只读，不进入任何交付 lane。

显然满足“docs-only、无执行面、无已知并发冲突、单 commit 可逆”的轻量改动，由猫直接自判 `direct_push`；不要求先开 worktree、扫全量 PR 或调用 classifier 来证明自己可以省流程。拿不准，或准备进入 worktree / PR / cloud / full gate 前，才收集完整 changed files（含 untracked）并运行：

```bash
pnpm classify:co-creation-docs -- \
  --base origin/main \
  --conflict none \
  --reversibility one_commit
```

`one_commit` 要同时满足：≤1 commit 可回滚、不影响外部用户/数据/契约。拿不准就填 `unknown`，classifier fail-closed 到 PR。已知有重叠在飞 PR 时再查具体 changed paths；无迹象时不为每份 Markdown 全量扫描 GitHub。

| classifier 输出 | 文档校验 | 内容 review | PR | Cloud | Full gate |
|---|---|---|---|---|---|
| `co_creation_docs + direct_push` | 必须 | 按新增判断：`required / reuse / skip` | 跳过 | 跳过 | 跳过 |
| `co_creation_docs + pull_request` | 必须 | 新实质内容才新审；已审内容/机械合并复用 provenance | 必须 | 只按 classifier | 只按 classifier |
| `regular_development` | 风险匹配的 targeted / full 校验 | 非作者独立源（local 或 cloud） | 必须 | 五轴风险触发 | 五轴风险触发 |

风险映射：

- conflict detected/unknown 或 reversibility high/unknown → PR；不会自动升级 cloud/full gate。
- `docs/SOP.md`、VISION/lessons、decisions/canon、architecture ownership 等治理文档 → PR + 本地跨族治理 review；按 operator 既有指令跳过 context-blind cloud，纯 docs 不跑 full gate。
- `docs/ROADMAP.md` 是 main-only 共享状态，不是治理 PR 触发器：与安全 feature docs 同改仍走 direct main；若同批其他文件确需 PR，先把 BACKLOG 的机械登记单独落 main，禁止把它塞进 worktree/PR。
- 普通 `docs/features/*.md` 内容更新不因目录名自动升级；无重叠且单 commit 可逆时 direct push，真实冲突或高/未知可逆性仍按 classifier 升到 PR。
- `cat-cafe-skills/**`、`sop-definitions/**`、scripts、CLI、tests、packages 或其他第一方执行面 → regular development，即使文件扩展名是 `.md`。
- 普通代码 / test 不因文件类型自动 cloud；行为面用 targeted tests + 合适独立源。安全、数据、外部契约或不可逆风险才升 full / cloud。

direct-push 只做：轻量增量校验 → 判断是否出现**需要第二只猫判断的新内容** → targeted commit（Why + 模型签名）→ push `origin main`。机械登记、拼写、operator 已逐字共创或有可回链旧 verdict 的内容可 `skip/reuse`，不为“有 diff”新叫 reviewer。普通文档校验不安装依赖、不构建共享包、不跑 docs-discovery 实现套件；feature 文档只追加 dependency-free feature truth。不建 worktree/PR，不生成 review 归档来证明自己 review 过。

**行数不是路由条件。** 不能用“超过 5 行”把安全共创文档机械送入完整开发链，也不能用“小 diff”掩盖敏感面。

### remote review 的触发

cloud 不再是默认步骤，因此没有“先默认、再申请跳过”：

- 命中安全 / 数据 / 外部契约，或需要 context-blind 跨包扫描 → 选择 cloud；
- skill / SOP / 家规 / 治理语义，或 stateful local reviewer 已足够覆盖 → 选择 local；
- 两者都选时分别写明不同风险面；相同目的不得重复叠加。

### 最小安全 direct-main

仅在既有 lane 明确允许 direct push 时使用：co-creation docs 已自判显然 light（拿不准才跑 classifier），或确定性机械生成物的修复载体明确允许。必须同时满足可逆、无行为变化、无数据 / 安全 / 契约 / 不可逆面，并有精确机器检查；只有出现需要独立判断的新内容时才加非作者验证。

代码与第一方执行面仍用 PR；pure docs 先走 Co-Creation Docs Lane。diff 行数不参与判断。

### Artifact-only PR merge-gate（F192 Phase H 收尾 PR-3 codified）

> **核心问题**：F192 `cat_cafe_publish_verdict` 会为每次 scheduled eval 自动开 PR 归档 verdict 证据。这种 PR **不是代码 review request**，是 eval evidence artifact。让operator / 通用 reviewer 走 full merge-gate 验收 = 把 operator 当 merge queue + 噪音灾难（PR #2114 实战暴露）。
>
> **解法**：满足以下 10 条硬条件 → 任一非作者猫走 artifact-only merge-gate，跳过 full `pnpm gate` + 跳过remote review；cats 自决 squash merge。operator 不在 reviewers / 不需 sign-off。
>
> **失败任一条 → 回到 risk-routed merge-gate**（至少一个非作者独立源；cloud / full gate 只按风险触发）。

#### 10 条硬条件

1. **路径范围（domain-aware allowlist）**：PR diff 仅含以下任一允许路径：
   - `docs/harness-feedback/` （所有 verdict 的 verdict.md + bundle JSON）
   - `generated/capability-wakeup/<verdictId>/` （**仅 eval:capability-wakeup verdicts**；cw generator 的 replayed raw inputs `trials.json` + `summary.json`，被 provenance.json 引用，PR-2 R3 P1 cloud 锁住 staging）
   - `generated/memory/<verdictId>/` （**仅 eval:memory verdicts**；memory generator 的 replayed raw inputs `recall-metrics.json` + `library-health.json`，被 provenance.json 引用，F192 memory wire-up cloud R8 P1 锁住 staging）
   - `generated/sop/<verdictId>/` （**仅 eval:sop verdicts**；sop generator 的 replayed raw inputs `trace.json` + `eval-results.json`，被 provenance.json 引用，PR #2684 cloud P1 锁住 staging）
   - 任何其他路径出现 → 退到 regular merge-gate
   - **额外校验**：若包含 `generated/<domain-slug>/`，必须满足 PR 是 `verdict/auto/eval-<domain-slug>/<verdictId>` 分支 且 `<verdictId>` 匹配 PR title（防止 a2a/sop PR 借 generated/ 路径绕道；适用于 cw + memory + sop）
2. **零 code files**：无 `.ts` / `.tsx` / `.js` / `.mjs` / `.cjs` / `.py` / `.sh` 等
3. **零 root artifacts**：复用 Step 0.5 Root Artifact Guard（无根目录 .png / .pen / 媒体文件）
4. **mergeable + clean**：`mergeState == CLEAN` + `mergeable == MERGEABLE`
5. **非 hotfix**：`scripts/check-hotfix-pattern.mjs` 返回 `hotfix=false`
6. **PR title 模式匹配**：title 含 `verdict(` 前缀（如 `verdict(eval:a2a): 2026-06-06-...`）
7. **PR body 模式匹配**：body 含字符串 `Verdict published via cat_cafe_publish_verdict MCP tool` —— 防止被滥用为通用 cat-merge 绕道
8. **作者 ≠ merger**：保留 cross-individual 原则（生成方猫 = 发起 publish 的 eval cat；merger = 任一非生成方猫）
9. **`evidence-only` label 必须 present**（cloud R6 P2 — 锁住 policy 判断）：PR 必须有 `evidence-only` label。`computePublishPolicy` 只对 `keep_observe` verdict 应用该 label；`fix` / `build` / `delete_sunset` verdict policy 返回 `regular_pr`（无 evidence-only label） → 必须走 regular merge-gate（owner action required）。**关键**：title 含 `verdict(` 前缀和 body 含 `cat_cafe_publish_verdict` 字符串只能证明 PR 是 publish-verdict 自动生成的，**不能证明该 PR 不需要 owner action**。`evidence-only` label 是 policy 显式判断"这条 verdict 无 actionable 内容"的唯一信号；缺失 → 必须走 regular merge-gate（哪怕 PR 是自动生成的）。
10. **Eval glossary check 必须成功**：GitHub check `Eval Metric Glossary Coverage` 必须为 `SUCCESS`。该 check 对 verdict / glossary 相关 PR 运行 `pnpm check:eval-metric-glossary`，保证最新 production verdict 的每个 `metricRef` 都有可读说明；check 缺失、pending 或失败都不能走 artifact-only merge。

#### 工作流

```bash
# 1. Detect: 收到 #N PR notification (autonomous via PR review feedback bot, or manual scan)
gh pr view N --json title,body,headRefName,mergeable,mergeStateStatus,changedFiles --jq '.'

# 2. Verify 10 conditions
# Condition #1: paths only in docs/harness-feedback/ OR generated/capability-wakeup/<verdictId>/ OR generated/memory/<verdictId>/ OR generated/sop/<verdictId>/
VERDICT_ID=$(gh pr view N --json title --jq '.title' | sed -E 's/.*verdict\([^)]+\): //; s/[[:space:]].*//')
gh pr view N --json files --jq '.files[].path' \
  | rg -v "^(docs/harness-feedback/|generated/capability-wakeup/${VERDICT_ID}/|generated/memory/${VERDICT_ID}/|generated/sop/${VERDICT_ID}/)" \
  && echo "FAIL #1: paths outside artifact-allowlist"
PR_NUMBER=N node scripts/check-hotfix-pattern.mjs N | jq -r '.hotfix'  # must be false
# (title/body checks: gh pr view ... | grep)
# Condition #9 (cloud R6 P2): require evidence-only label (policy classification check;
# fix/build/delete_sunset verdicts intentionally lack this label → must walk regular gate)
gh pr view N --json labels --jq '.labels[].name' | rg -q '^evidence-only$' \
  || echo "FAIL #9: no evidence-only label — verdict has actionable verdict severity; walk regular merge-gate"
# Condition #10: the targeted production glossary coverage check must pass.
gh pr checks N | rg -q '^Eval Metric Glossary Coverage.*pass' \
  || echo "FAIL #10: Eval Metric Glossary Coverage is missing, pending, or failing"
# Local reproduction when the check is red:
pnpm check:eval-metric-glossary

# 3. If all 10 pass: squash merge
gh pr merge N --squash --delete-branch

# 4. NO Phase doc sync needed (artifact PR doesn't change feature spec)
# NO worktree cleanup needed (artifact PR is auto-generated, no local worktree)
```

#### 决策标签（PR-3 publish-policy）

cat_cafe_publish_verdict 自动给 artifact PR 加 labels：
- `evidence-only`：所有 artifact-only PR 都有此 label（filterable）
- `no-action-needed`：keep_observe + 无 actionable findings（rollup mechanism 落地前的 interim 标记）

operator / operator 在 PR list 可按 `evidence-only` label 过滤掉所有 artifact PR，不必每次看到都问"谁 merge"。

#### Future Phase 占位

PR-3 是 interim 方案 —— 仍开 per-run PR，只是 label + 猫自决 merge。**真正解**是 rollup mechanism（daily/weekly batch PR 聚合 N 个 no-action verdict，或 runtime evidence store + 周期 flush archive PR）。独立 Phase 排期，等 PR-3 体感数据反馈后再 design。

## Reviewer 配对规则

动态匹配自运行时猫配置（repo 根 `cat-template.json` + `.cat-cafe/cat-catalog.json` overlay）：
1. 跨 family 优先 | 2. 必须有 peer-reviewer 角色 | 3. 必须 available
4. 优先 lead | 5. 优先活跃猫

**降级**：无跨 family reviewer → 同 family 不同个体 → operator。
**铁律**：同一个体不能 review 自己的代码。
**共享 GitHub 账号澄清**：全家共用 `zts212653` 账号，"个体"判据 = catId（opus-47 / codex / gpt-5.4 等），不看 GitHub login。GitHub `dismiss_stale_reviews_on_push` 因共享账号视所有猫为同一 pusher → `mergeStateStatus=BLOCKED`；此时 `--admin --match-head-commit` 是合规 fast-path，**不是 self-review violation**，无需纠结或升级 operator。

## 代码质量工具

| 工具 | 命令 | 何时 |
|------|------|------|
| Biome | `pnpm check` / `pnpm check:fix` | 开发中 + Step ② |
| TypeScript | `pnpm lint` | Step ② 必跑 |
| shared rebuild | `pnpm --filter @cat-cafe/shared build` | shared 包改后 |
| 目录卫生 | `pnpm check:dir-size` + `pnpm check:deps` | 新增文件时 |

详见 ADR-010（目录卫生）。

## 环境变量注册（必读！）

新增 `process.env.XXX` 引用 → **必须在 `packages/api/src/config/env-registry.ts` 的 `ENV_VARS` 数组注册**。
前端「环境 & 文件」页面自动展示，不注册 = operator看不到 = 不存在。

## 文档规范

- `docs/` 下 `.md` 文件必须有 YAML frontmatter（ADR-011）
- 完成后必须同步真相源（详见 `feat-lifecycle` skill）
- 归档查找：*(internal reference removed)*

## 开源社区 Issue 处理（F059）

开源仓 `clowder-ai` 的社区 issue 由猫猫 triage，**operator决定是否立项**。

### 角色分工

| 角色 | 谁 | 做什么 |
|------|-----|--------|
| **Triage** | 任意猫（收到 @ 或主动巡查） | 给 issue 加 `bug` / `feature` label，回复确认收到 |
| **F 号分配** | operator拍板 → 猫执行 | 在 ROADMAP.md 加条目，分配下一个可用 F 号 |
| **Feature Doc** | 分配到的猫 | 按模板写 `docs/features/F{NNN}-slug.md` |
| **实现** | 任意猫或社区贡献者 | 按 Feature Doc AC 实现 + PR |

### 流程

```
社区开 issue → 猫 triage（加 label）→ operator拍板
    ├─ Feature → ROADMAP.md 加 F{NNN} → Feature Doc → 实现 → 全量 sync 推送
    └─ Bug fix → worktree(sync tag) → 修 → sync-hotfix.sh → clowder-ai PR → cherry-pick 回 main
```

### Hotfix Lane（Bug 快修通道）

社区报 bug 时，不必等全量 sync，直接走 hotfix lane：

1. `git worktree add -b fix/xxx ../cat-cafe-hotfix-xxx sync/LATEST-TAG`
2. 在 worktree 里修 bug
3. `cd ../cat-cafe-hotfix-xxx && bash scripts/sync-hotfix.sh fix/xxx <changed-files>`
4. 在 clowder-ai 上开 PR、review、merge
5. Cherry-pick fix 回 cat-cafe main
6. `intake-from-opensource.sh --record --pr <N> --decision <absorbed|public-only>`
   - 若 `--decision absorbed`：hotfix 是我们自己 outbound 提的（没有 cat-cafe 的 Intake Intent Issue / absorb PR），必须加 `--skip-absorbed-guard` 跳过 strict guard
   - 若是社区 inbound PR 的 absorbed record（不是本条 hotfix 流程），参见 `cat-cafe-skills/refs/opensource-ops-inbound-pr.md`，要带 `--intent-issue <I> --absorb-pr <P> --review-proof <URL|file>`
7. `intake-from-opensource.sh --advance-ledger`

> 详见 Hotfix Lane 设计 (internal)

### Full Sync Gate（Source-Owned）

全量同步到 `clowder-ai` 时，**不能只看家里的 `pnpm gate` 绿不绿**。  
`source gate green != target/public gate green`。

硬规则：
1. 先在 `cat-cafe` 导出同一份同步产物到 **temp target**
2. 在 temp target 跑完整 public gate：`pnpm check`、`pnpm lint`、`build`、`pnpm --filter @cat-cafe/api run test:public`、startup acceptance
3. **只有 temp target public gate 全绿，才允许碰真实 `clowder-ai`**
4. 本机 README/macOS smoke 不属于 full sync 主路径；它必须是 sync 完成后的独立步骤，且必须显式隔离端口/Redis

一句话：**不要再把真实 `clowder-ai` 当第一轮验收场，更不能把 runtime 当验收靶子。**

### Release Provenance（三点映射）

公开 release 不要求 `cat-cafe` 和 `clowder-ai` 同 SHA；我们要求的是**可追溯映射**。

硬规则：
1. release-intended full sync 必须从家里 source 侧显式传 `--release-tag=vX.Y.Z`
2. `sync-to-opensource.sh` 在 temp target public gate 通过后，会自动打并 push `clowder-vX.Y.Z-source`
3. `.sync-provenance.json` 必须记录：
   - `source_commit_sha`
   - `release_tag`
   - `source_snapshot_tag`
4. target 仓后续真正切 `vX.Y.Z` 时，必须通过：

```bash
bash scripts/publish-release-tag.sh \
  --release-tag=vX.Y.Z \
  --target-sha <clowder_ai_release_commit_sha> \
  --reconciliation-report=docs/ops/reconciliation-vX.Y.Z.md \
  --push
```

5. `publish-release-tag.sh` 会强制校验两层门禁：
   - `source snapshot tag → .sync-provenance.json → target release tag` 三点映射
   - `reconciliation report` 必须存在；如果报告把 issue 记为 `closed`，GitHub 上也必须已经是 `CLOSED`

release notes /后续 backport 也必须引用这些锚点，而不是口头约定。

一句话：**以后对齐 release，不靠“记得当时是哪次 sync”，靠 `source snapshot tag → target release tag → backport commit` 三点映射。**

### 规则

- **社区和内部共用一套 F 编号**：不另起 P/CEP/社区专属编号系列（2026-03-13 决策，详见 F059 spec D6）
- **F 编号唯一源**：ROADMAP.md（operator拍板后猫执行分配）
- **Bug 不编号**：直接用 issue # 追踪，修完 close（D7）
- **贡献者不自选号**：CONTRIBUTING.md 已写明，猫猫回复时也要强调（D8）
- **分配 F 号前必须做关联检测**：确认 issue 不是现有 feature 的子项/增强（F114-F116 撤销教训，D9）
- **社区贡献者的 PR**：猫猫用 `community-pr` skill 引导（编号校验 + Feature Doc 对齐）

### Issue Label 命名规范

开源仓 `clowder-ai` 的 issue label 统一格式：

| Label | 格式 | 颜色 | 说明 |
|-------|------|------|------|
| Feature 关联 | `feature:F{NNN}` | `#0E8A16` 绿 | 关联到 cat-cafe Feature 编号 |
| Bug | `bug` | GitHub 默认 | 社区 bug report |
| Enhancement | `enhancement` | GitHub 默认 | 社区增强建议 |

**注意**：
- Feature label 必须用 `feature:F{NNN}` 格式（带 `feature:` 前缀 + 大写 F + 三位数字），不要用裸编号如 `F115`
- Label 在 cat-cafe 定义规范，通过 sync 流程同步到 clowder-ai 的 CONTRIBUTING.md
- 新建 label 时统一用绿色 `#0E8A16`
