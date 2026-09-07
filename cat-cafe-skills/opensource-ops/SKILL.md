---
name: opensource-ops
description: >
  Portable workflow for external PR / issue operations and source-to-public publishing.
  Use when: a thread is reviewing, triaging, intaking, or advising on an external artifact, or must distinguish outbound sync from a public release.
  Not for: internal feature work with no external artifact, generic thread orchestration, replacing the external maintainer's own decision, or inventing deployment-specific export commands.
  Output: grounded provider-neutral subject + verified author/authenticated-identity comparison + adoption five-question answer + correctly separated sync/release custody.
triggers:
  - "opensource-ops"
  - "社区 PR"
  - "external PR review"
  - "GitHub PR review"
  - "PR intake"
  - "issue triage"
  - "outbound sync"
  - "public release"
---

# Open Source Ops — 外部 PR/issue 操作

> **SOP 位置**: 本 skill 是 `thread-orchestration` 在社区守门/外部 PR 场景下的子 workflow。
> **上一步**: `thread-orchestration`（分发） | **下一步**: `request-review` / `receive-review` / `merge-gate`

## 核心原则

1. **Server 不替你猜**：F128 proposal runtime 不再推断 PR identity、作者角色、主仓采纳策略或任何实例私有同步策略。这些判断必须在拥有 `cwd` / provider / provenance 上下文的 child-side 完成。
2. **Child thread 自己 grounding**：进入子 thread 后，第一只猫必须显式加载本 skill，用 deployment 的 provider adapter（例如 GitHub 用 `gh`）把外部对象落到可验证的事实字段。
3. **外部作者优先负责修复**：默认把 finding 路由给外部作者；本地猫替作者改代码需要显式授权与 provenance。
4. **反向溯源 fail-closed**：`proposal source`、`projectPath`、`preferredCats`、`initialMessage` 里的 URL 都不能直接当 origin 证据；必须有独立的 provider 级验证与内部 provenance 搜索。

## 进入条件

在 child thread 中看到以下信号时加载本 skill：

- `title` / `reason` / `initialMessage` 出现外部 PR/issue URL 或 `owner/repo#NNN` 简写。
- 任务明确是 review / triage / intake / advisory 之一。
- 需要与外部作者、CI、maintainer 交互。

## Step 1: Grounding（落地 provider-neutral subject 与 author）

必须在动手判断之前完成。使用当前 deployment 的 provider adapter（例如 GitHub 场景用 `gh`）查询外部对象，产出以下**事实字段**；禁止从 thread title/reason 直接反推这些字段而不验证。

| 字段 | 类型 | 说明 |
|------|------|------|
| `providerSubject.kind` | `pr` / `issue` | 外部对象类型 |
| `providerSubject.fullName` | `owner/repo` | 外部目标仓库全名 |
| `providerSubject.number` | 正整数 | PR/issue 编号 |
| `providerSubject.url` | URL | 对象 canonical URL |
| `providerSubject.headSha` | SHA（PR 必需） | formal review 的 exact-HEAD 锚点 |
| `providerSubject.state` | `open` / `closed` / `merged` 等 | 对象生命周期状态 |
| `verifiedAuthorIdentity` | 字符串 | provider 返回的、已验证的作者 identity（如 GitHub login） |
| `authenticatedContributorIdentity` | 字符串 \| `null` | 当前本地认证 identity（如 `gh auth status` 返回的 active user）；无认证时为 `null` |
| `authenticatedRole` | `maintainer` / `contributor` / `outsider` / `unknown` | 当前 identity 对外部仓库的权限角色；无本地认证时按 `outsider` 处理 |

**Fail-closed 分支**：

- `verifiedAuthorIdentity` 是 bot / shared account / 无法解析 → 明确停住，标记 `author_kind: ambiguous`，不继续 custody 判断，直到 operator 或 maintainer 显式确认。
- `authenticatedContributorIdentity` 无法解析 → 按 `null` 处理，`authenticatedRole` 降级为 `outsider`。仅当工作流需要 mutating custody（review publication / merge / verdict）时才必须停住重新认证；纯 advisory / triage 审计可在匿名 `outsider` 角色下继续。
- provider 查询失败（无网络、无权限、对象不存在）→ 停住，输出 `unknown`。

## Step 2: 身份与 custody 判断（fail-closed）

 custody 只看 **verified author** 与 **当前 authenticated contributor identity** 是否匹配，以及 **当前 identity 的权限角色**，不看仓库名字：

| 场景 | verifiedAuthorIdentity vs authenticatedContributorIdentity | authenticatedRole | custody 含义 |
|------|-----------------------------------------------------------|-------------------|-------------|
| 我们向外部仓库提 PR | match | contributor / maintainer | 外部 maintainer review；我们修自己的 PR；不把 verdict 写回 |
| 外部贡献者向我们维护的仓库提 PR | no match | maintainer | 我们 review + merge；fix 默认回作者 |
| 外部贡献者向我们维护的仓库提 PR | no match | contributor | 我们 review；merge 必须升级到 maintainer；fix 默认回作者 |
| 第三方仓库的 PR（纯审计） | no match | outsider | advisory only；不写 verdict 到仓库 |
| issue / triage | 视对象而定 | 视角色而定 | intake 或 advisory |

**Fail-closed 分支**：

- bot/shared/ambiguous author → 停住，不分配 custody。
- `authenticatedRole` 与 authorship 冲突（例如 identity match 但当前账号无写权限）→ 按 contributor 处理，禁止以 maintainer 身份 self-review / self-merge。
- maintainer capability（merge 权限）必须与 authorship 分离：能 merge 不等于就是作者，是作者不等于能 merge。

**本地猫接管 fix 的授权**：只有当外部作者无响应、修复是 trivial blocker、且有 operator 或 maintainer 显式授权时，本地猫才接管 fix。授权必须在 thread 中留下可引用的消息，并记录 provenance。

## Step 3: Maintainer 五问（仓库中立版）

把五问抽象成任何外部仓库都可以用的 adoption 框架：

1. **问题与设计差距**：它解决什么问题？当前方案与项目现有设计/契约的差距在哪？
2. **Vision/contracts fit**：它是否符合项目方向、semver 契约、架构原则？是否引入反模式？
3. **是否 adopt**：基于前两条，给出 adopt / reject / advisory-only 的明确结论。
4. **Adopt 后的路径**：merge-as-is / redesign / reimplement / port — 哪一种是风险最小的终态？
5. **Custody 边界**：谁负责修、谁负责 review、谁负责 merge、谁负责后续回归测试 / 文档 / 同步？

回答必须引用 grounding 步骤中的具体字段（`verifiedAuthorIdentity`、`providerSubject.headSha`、`authenticatedRole` 等），不能只给主观结论。

## Source-to-public publishing

当一个仓库是真相源、另一个仓库是公开分发面时，把同步和发版当作两个独立状态迁移。这里定义的是可移植边界；具体 exporter、ledger、gate 与 tag 命令仍以当前 deployment 的真相源为准。

### D: Outbound Sync

1. 先核清 public main 上的社区改动与 source ownership，再冻结 exact source revision、exact public base 和 reconciliation evidence；冻结后的新提交进入下一班。
2. 同一 source cut 只跑一次所选 source gate。已有写授权时，由 canonical writer 持有唯一 candidate-public validation；尚无写授权时，停在 no-write validate / write handoff。
3. writer 只能从已冻结的 public base 生成候选内容，公共落地仍走可审查的 PR，并记录 source/public provenance。
4. 未合入的外部 PR 本身不会被 writer 改写；只有明确的同车约束、已落 public delta 或候选行为冲突，才构成同步阻塞。

### G: Public Release

1. 给当前稳定 public main 发版时，绑定 exact public HEAD 与最近一次可信 sync provenance；不要为了制造发版证据而伪造新的 source export。
2. release 只验证其明确承诺的分发物；没有承诺安装包时，零二进制资产可以是正确终态。
3. 若一次 outbound sync 同时有明确 release intent，则让 release 引用该已落 public cut；同步与发版的 terminal 仍分别记录。

**Sync ≠ Release**：outbound sync 更新公开分支，public release 给一个已经验证的公开状态打稳定承诺。前者完成不自动证明后者完成，后者也不要求凭空重跑前者。

## Step 4: 反向溯源（reverse provenance）

进入本 thread 的 proposal 可能带有一段 `initialMessage` 或 `reason`，里面提到外部对象。**这些信息只能算线索，不能算证据**。外部 provider subject 的验证（Step 1）已经给出“这是哪个外部对象”；内部 provenance 回答“这个 thread 从哪个内部上下文来、与外部对象是什么关系”。二者必须分开。

### 内部 provenance 搜索

用现有 project/thread evidence 能力验证这个 child thread 的内部来源：

1. 读取 child thread 的 `createdFromProposalId` / `sourceThreadId`。
2. 用 `cat_cafe_get_thread_context` 读取源 thread 的 proposal card 与源消息。
3. 用 `cat_cafe_search_evidence` 在 project/thread evidence 中搜索显式的外部对象 anchor（例如 `pr:owner/repo#NNN`、commit SHA、proposalId、sourceMessageId）。搜索范围不限于 proposal source thread；相关 thread 也可能被粘贴/引用。
4. 对每一个候选 thread/message，逐项列出它与此 `providerSubject` 的关系证据；没有显式 anchor 的只算 `related` 或 `unknown`。

### 证据分级

| 来源类型 | 可信度 | 用法 |
|---------|--------|------|
| `verified origin` | 高 | 内部 thread 证据包含与 `providerSubject` 完全一致的显式 anchor（如 `pr:owner/repo#NNN`），并且存在 provenance 链证明该 thread **创建/提出了此外部对象**（例如内部 proposal/assignment 明确指派本地猫向该仓库提 PR；或内部决策记录把该外部对象登记为交付物）。外部对象触发内部 thread 只能算 `related`，不能反证 `origin` |
| `related` | 中 | 内部线索提到该对象或同一仓库/作者，但缺少显式 anchor；必须逐项列出关系证据 |
| `unknown` | 低 | 只有模糊描述，没有 `owner/repo#NNN` 或 URL，或 grounding 失败 |

### Fail-closed 规则

- 不能把 `proposal sourceMessageId`、`projectPath`、`preferredCats` 当 origin 证据。
- 不能把 "标题写了 clowder-ai#1387" 当已验证；必须跑一次 provider adapter 拿到对象状态，并搜索到内部显式 anchor。
- 仅有相同 PR anchor 不足够判定 `origin`；必须同时提供 provenance 链证明内部 thread **创建/提出了该外部对象**（例如内部 assignment 明确说"向 owner/repo 提 PR #N"，或内部 feature doc/commit 把该 PR 登记为本地交付物）。外部对象触发内部 thread 只能算 `related` 或 `unknown`。
- 内部 provenance 与外部对象对不上 → 输出 `unknown` 并升级到 operator。

### 记录 verified metadata

当 `providerSubject` 已在 Step 1 验证后，无论内部 provenance 是 `origin`、`related` 还是 `unknown`，都要调用 `cat_cafe_set_thread_metadata` 把外部对象与当前 thread 关联起来：

```json
{
  "prs": [{ "repo": "owner/repo", "number": 123 }],
  "issues": [{ "repo": "owner/repo", "number": 456 }]
}
```

**后续 tracking/review/closure 只能在这个 metadata write 之后进行** —— verified provider subject 是写 metadata 的授权条件，不是“必须找到 origin”。

## Step 5: 工具落点与协作

### Review

- 用 `request-review` 把 diff 送给非作者猫做独立 review。
- `cat_cafe_record_external_review_verdict` **只用于 configured maintainer-owned inbound reviews**：当前 authenticated identity 是外部仓库的 maintainer，且 PR 作者不是当前 identity（外部贡献者向我们维护的仓库提 PR）。
- 其余场景不写 formal verdict：
  - 我们向外部仓库提的 PR（outbound / self-authored）→ 由外部 maintainer review，我们只回复其 comment / 修自己的 PR，不把 verdict 写回。
  - 第三方仓库的纯审计 → advisory only，只在本 thread 内产出 findings，不强制写回外部系统。
  - 如果需要以 advisory 形式把评论发到外部系统，用 provider adapter（例如 `gh pr comment`）直接发布，不要用 custody verdict 工具。

### Tracking

- **不要为每个 PR/issue 自动注册 tracking**。只有以下两类情况才注册 PR / issue 追踪：
  1. 工作真实阻塞在外部条件（等作者回复、等 CI、等 maintainer review）。
  2. 计划做 formal external review 时，需要先用 `cat_cafe_register_pr_tracking` seed projection，才能在终端态记录 `cat_cafe_record_external_review_verdict`。
- 注册只需 `repoFullName` + `prNumber`；`nextStep` 可选且仅供展示。**不接受任何条件表达式或过期时间**——追踪永不过期，通知后自动续订。需要增删事件用 `include` / `exclude`（按事件名）。
- Advisory / triage / 纯审计不需要注册 tracking。

### Merge / closure

- 外部 PR 的 merge 只能由有权限的 maintainer 账号执行；本地猫共享 login 不能 self-review / self-merge。
- 合入后是否需要同步 feature doc / BACKLOG 由项目自己的 SOP 决定，本 skill 不做实例私有假设。

## Step 6: 回报（reportingMode）

社区守门 / 外部 PR 分发使用 `reportingMode: "final-only"`：

- 闭环前 0 次过程 cross-post。
- 闭环后 1 次最终总结 cross-post 回主 thread，携带：
  - grounding 结果（`providerSubject`、`verifiedAuthorIdentity`、`authenticatedRole`）
  - 五问结论
  - custody 去向（作者修 / 本地猫显式授权接管 / advisory only）
  - 后续跟踪 registration（如果有）

## 与相关 Skill 的关系

| Skill | 层级 | 作用 |
|-------|------|------|
| `thread-orchestration` | 父 thread | 决定要不要开子 thread、选 projectPath、定 reportingMode |
| `opensource-ops`（本 skill） | 子 thread | 进入外部 PR/issue 上下文后的 grounding + 判断 + custody |
| `request-review` / `receive-review` | 子 thread | 代码级 review 循环 |
| `merge-gate` | 子 thread | 有权限时合入 / 同步状态 |
| `cross-cat-handoff` | 猫对猫 | 需要把 exact-HEAD review 交接给另一只猫 |

## Common Mistakes

| 错误 | 正确 |
|------|------|
| 从 title/reason 直接推 PR identity 而不跑 provider adapter | 先 grounding，再判断 |
| 把 `projectPath` 当成外部目标仓 | `projectPath` 是工作区归属；外部目标仓是独立的 `providerSubject` |
| 服务端应该自动注入五问 | 服务端不注入；子 thread 自己加载本 skill 执行 |
| 看到 PR 就自动注册 tracking | 只在真实阻塞时注册追踪 |
| 本地猫直接替外部作者修 PR | 需要显式授权 + provenance |
| 把 proposal source 当 origin 证据 | origin 必须来自内部显式 anchor + provider 验证 |
| 用实例私有品牌/成员关系描述 portable workflow | 本 skill 是仓库中立的；实例成员关系只在明确知道当前 deployment 时才使用 |
