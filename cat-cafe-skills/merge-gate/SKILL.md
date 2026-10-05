---
name: merge-gate
description: >
  合入 main，消费风险匹配的验证与适用的 review 证据。Use when: 准备合入 PR。
  Not for: 未完成作者自检、处理 review findings 或 Feature 终态验收。
  Output: 产品快车道的作者自验或风险要求的独立 review，加受影响检查支撑的合入证据与结果。
tips_exempt: "2026-09-27：F323 deployment wait 只把猫猫已有的合入后续办责任持久接回，不新增 operator 可直接操作的产品入口；既有浏览器验证、targeted 终态、Gate W 与 F314 review/source provenance 也均为治理契约。"
triggers:
  - "合入 main"
  - "merge"
  - "准备合入"
  - "开 PR"
  - "cloud review"
  - "gh pr create"
---

# Merge Gate

> **SOP definition**: `sop-definitions/development.yaml` stage `merge`。

合入 main 的流程：先按 `docs/SOP.md` 风险入口判断是否适用产品快车道，再选验证命令与必要的独立 review。快车道由作者完成真实入口核对和受影响检查即可合入；其他改动消费风险要求的 review source。PR 是载体，不是自动触发 local + cloud + guardian 三连的理由。

## Lane 0：Co-Creation Docs PR

先检查是否已有成功的 `pnpm classify:co-creation-docs` 证据，且输出同时满足：

- `lane=co_creation_docs`
- `delivery=pull_request`
- changed files 与 PR diff 完全一致

满足时，直接消费 classifier 的 `validation` / `cloudReview` / `fullGate` 结论：

1. 跑 classifier 返回的全部 `validation` 命令 + `git diff --check`。
2. 新实质内容需要非作者内容 review；已有内容 verdict 或可证明机械合并用 continuityProof 复用，不为 SHA 字符串变化重开 reviewer。
3. `cloudReview=required` 才触发 cloud；`skip` 时在 PR 留 classifier 原因。家规 / SOP / skill 纯文字通常由有状态 local reviewer 覆盖治理语义，不把“免 cloud”当需要申请的特权。
4. `fullGate=required` 才跑 `pnpm gate`；`skip` 时 evidence manifest 记录 docs validation 命令。
5. evidence 闭合后由在场 merge owner 执行 `gh pr merge --squash`；不再额外召唤一只猫只为按 merge 按钮。无 F 号时跳过 Feature Doc Truth post-merge sync。

任一 changed file 不匹配、classifier 缺失/失败或输出 `lane=regular_development` → 退出本节，走下方风险路由。行数不能作为 Lane 0 证据。

## 核心知识

### Risk-Routed Merge 门禁 5 条（全部满足才能合入）

1. PR body 写清五轴风险判断：行为面 / 数据 / 安全 / 契约 / 不可逆；默认最小安全动作，升档理由可查。
2. 符合 SOP 产品快车道时，用作者真实入口、截图/交互核对与受影响检查，不默认选 review；其他改动至少一个非作者独立 review source（local 或 cloud）有明确 verdict。已选择的 review 不因等候而撤销；hotfix、共享底座和硬边界不借快车道跳审。愿景守护另按 feature-close 触发。
3. **所有 P1/P2** 已修复，并由提出 finding 的活跃 source 覆盖当前 HEAD（含 Harness Diet Rebase Continuity 的 continuityProof 桥接）。
4. 适用的 feature / BACKLOG 真相源没有过度声称，PR 载体与 changed files 匹配。
5. 与影响范围匹配的验证全绿：作者负责选择并证明足够的覆盖，纯文档做文档校验，窄改跑受影响检查，targeted 无法覆盖的风险才跑 full。机器的 full 是默认覆盖建议，作者可按下方「Gate 选择」有据改选 targeted；按风险要求的独立审查和硬授权边界不随之省略。**`pnpm gate` 的 targeted 退出码 3 只表示分类完成**，仍需实际检查结果（见「targeted 终态语义」）。

需要 review 时默认只选一个合适的独立 source：家里语境与治理语义优先 local；context-blind 安全 / 契约代码扫描优先 cloud。**动作类型（“开了 PR”“改了代码”）不是选择或叠加理由。**

合入者要理解 review 批准的究竟是什么。来源/head 正确、测试通过或上一轮 findings 清零，并不能自行证明原约定已兑现。结合现有 review 与仍有效的前轮判断，确认本次交付的实际结果被检查过；只有局部修复结论而原目标尚未判断时，把缺失的具体判断交回已选 source，不能用“整个 Feature 还没 close”绕过。这里是猫的语义判断，不新增 E 项、typed 字段或自动意图 checker；可证明连续的既有判断直接复用。

### Review Continuity Guard（review 是否真的覆盖当前 HEAD）

本节与 Review Provenance Matrix 只适用于已选择 review 的改动；产品快车道未选 review 时，不制造 reviewer、APPROVE 或 continuityProof，直接按下方 Evidence Validation 的适用性核验。

`pnpm gate`、rebase、fixup、biome 格式化刷新等都可能让 HEAD 变化。**HEAD 变化只触发 provenance 判定，不自动等于 re-review**：先分清 review 后是否真的改了本 PR 的内容、base 前进是否与本 PR 有逻辑关联；两者都没有，或只有可机械证明的派生物重建 / 规范化，旧 review 用 continuityProof 桥接。只有真实的作者 delta 或相关 base delta 回 active source，而且只看那一小块。

**昂贵 gate 连续性（ROI 硬边界）**：一次 full gate 绑定作者 patch 与冻结 base。经 rebase、普通 merge 或 no-op 同步后，作者 patch 等价且 C2 证明 base 增量无关时，只补风险匹配的 targeted continuity checks，**禁止仅因 main 前进重跑 full gate 或召回 reviewer 续签**。旧 full 未通过只使其绿色收据不可复用，不自动要求再次 full。真实作者 delta、相关 base 或冲突取舍重新判断影响范围；机器无法证明连续性时，作者仍按「Gate 选择」判断足够的验证，不把 classifier 的保守范围当作需要 operator 批准才能调整的边界。历史失败保持失败，新的 targeted 通过不改写旧 full 结果。

机器看不见的语义风险用 `pnpm gate -- --risk <behavior|data|security|contract|irreversible>` 声明审查强度；`assuranceLevel` 与覆盖范围 `route` 分开。该参数本身不改变 route；作者改选 targeted 通过已有验证命令与 evidence manifest 表达，不改 classifier、历史状态或失败相关性，也不伪造 full-green。不要直接调用内部 `scripts/classify-gate-route.mjs`。

**Report 载体铁则（斩断 SHA 自噬环，operator 2026-07-15 投诉②修复）**：**review verdict 之后、merge 之前，不得再向被审分支 commit 任何 review report / handoff 信 / evidence 说明类文档**——这类内容的合法载体只有 PR comment、thread 消息、tracking 系统。被审分支的 HEAD 只应因代码内容（含 rebase）变化。病灶机制：report 进分支 → SHA 变 → 旧 APPROVE 失效 → re-review → 新 report → SHA 又变（round-10 自噬环）。review **请求**信（mailbox，reviewer 开审前已在 HEAD 内）不受此限。

但 continuity 不是一个布尔 `reviewer`。进入 merge-gate 后必须维护 **Review Provenance Matrix**，先判当前 HEAD 变化由谁产生，再决定下一步 gate owner，避免把 cloud / CI / PR check 的外部 gate 投射成本地旧 reviewer。

**Intake admission guard**：inbound intake 已携带有效、覆盖当前 HEAD 的 durable local review fact 时，它就是 `already-consumed exact-HEAD review`；merge-gate 直接消费消息上的 reviewer identity、typed `localReviewVerdict`、`reviewedHeadSha`、`reviewSubjectRef`、`acceptedSourceRef`、`acceptedRevision` 与 findings/evidence refs，`nextGateOwner=author|merge_owner`，不能把原 reviewer 当每个 callback 的固定下一棒。缺 exact HEAD、accepted-source anchor、reviewer 与 author 同一 cat、结论不明确，或仍有未解决 P1/P2 时 fail closed。旧 HEAD verdict 可保留为历史证据，但不能批准新 HEAD；有实质新内容时用普通 A2A 发起新 review，不使用 review lease、generation 或复入字段。纯 ACK、状态复述、cloud finding 或其他 `no new information` 的消息必须 clean-stop。

**Accepted-source fence（procedural）**：对 local review fact，author 在 E3 前用下述仓库命令解析当前 accepted source revision 并与 artifact 精确比较；当前没有 runtime classifier 或 sidecar 代替这次 gate-time 对账。相同则零提示通过；不同则只接受 author 在现有 PR/evidence packet 写入的
`Accepted-Source-Reack: <acceptedSourceRef>@<currentRevision>`，且 ref/revision 必须与当前 truth 完全一致。缺失、旧 revision、source ref 改名或不可解析一律 BLOCKED。re-ack 不替代 exact-HEAD review，也不创建 lease、generation、reentry、replacement、第二份 source 正文或新的 verdict 类型。
Feature 文档的 current revision 必须取当前 integration cut 上
`git log -1 --format=%H -- <acceptedSourceRef>` 的最后内容变更 commit，不能用无关 main 提交也会推动的裸 `HEAD`；
source message 的 current revision 是 ref 中同一个不可变 `messageId`。

| 字段 | 记录内容 |
|------|----------|
| `localPeerReviewSha` | Stage ③ local peer reviewer 放行覆盖的 SHA |
| `cloudReviewSha` | 最新 cloud Codex review 明确覆盖的 SHA |
| `currentHead` | PR 当前 `headRefOid` |
| `headChangeCause` | `local-gate` / `cloud-finding` / `ci-fix` / `rebase` / `merge` / `pr-meta` |
| `nextGateOwner` | `local-peer` / `cloud` / `ci` / `author` / `guardian` |

**判定规则**：
- `headChangeCause = cloud-finding`（cloud P1/P2/COMMENTED 修复后 push 新 SHA）→ `nextGateOwner = cloud`：只重新触发 cloud review + 等 PR tracking；**禁止为了 cloud P1/P2 修复 @ 本地旧 reviewer**。
- `headChangeCause = ci-fix` / `local-gate` 且声称只是非行为性 delta（import order、formatter）→ 先按 C1 证明 reviewed patch 的语义内容没变；证明成立则 author 留痕桥接，不请求 approval。仅凭“formatter / import order”标签或“命令 exit 0”不算证明；证明不了才把实际 delta 交 local peer。
- `headChangeCause = ci-fix` / `local-gate` 且是非 cloud 的行为性 delta（代码、测试、配置、接口变化）→ local peer delta review；若超出原 review scope，按完整 local review 处理。
- `headChangeCause = pr-meta`（只改 PR body/comment，不改 commit SHA）→ 不影响 local/cloud review coverage。
- `pnpm gate` 冻结 main 后按 Git 祖先判定同步方式：main 已在 HEAD 历史中则 no-op；本地已知发布 tip 是 HEAD 祖先、尚未进入 main 时普通 merge，保留发布历史；缺 tracking ref、已分叉或 tip 已进入 main 时沿用 rebase。tracking ref 是正向证据，不声明远端状态实时完整；核验错误或 merge 冲突会停止，不能回退重放。
- owned feature branch 的普通 merge 保留远端发布 tip 时，先核对 local/remote 方向，再用 `git push origin {branch}` 发布；不要因 gate 改了 SHA 就改用 force。实际 rebase 改写发布历史时，只有已有授权覆盖该 owned 分支 rewrite，才能用 `git push --force-with-lease origin {branch}`；lease 保护不是授权，不扩大到共享分支或 main。发布后按 Matrix `rebase` / `merge` 行检查“作者 delta + base 关联 + gate”：满足则 continuity 默认有效，author 留痕 `skip=rebase-rereview` 或 `skip=merge-rereview`；否则只让 active review source 覆盖真实变化部分。
- cloud 额度/权限不可用时，才降级为另一只合格本地猫做**完整 PR review**；这不是把旧 reviewer 拉回来续签。

**封板协议（LL-072，cloud re-review 循环的硬上限）**：

"cloud-finding 修复 → 重新触发 cloud review" 没有自然终点——cloud reviewer 是**无状态抽样信号源**（每轮重放全部历史 inline comments、不能分辨 stale/fresh、不读 pushback），在多 commit 累积 diff 上"0 P1/P2"这个条件**没有不动点**，等它说零等于无限循环（F168 PR #2214 实测 21 轮，R19 单轮 22 findings 中 21 个假阳性）。因此：

1. **循环检测阈值（机械判定，无弹性）**：同一 PR cloud review 达到 **5 轮**，或单轮假阳性（stale 重放/已修重报）比例 **>50%** → 当轮处理完**强制进入封板**，不是继续修-触发循环。
2. **封板动作**：处理完当前轮全部 finding（真 P1/P2 修复 + 红绿测试；假阳性在 PR comment 有据 pushback）→ **不再 re-trigger cloud review，无论结果**。终局确权交给**本地有状态 reviewer** 对最终 SHA 做 final review（核 pushback 成立性 + 全 diff continuity），放行即 merge。cloud 的角色定位：有贡献预算的辅助信号源，不是终局确权者。
3. **介入循环时必须改写驱动循环的持久化指令**：tracking instructions / hold 文案里若写有 "0 P1/P2 → merge" 类无不动点条件，拉闸者第一动作是改写它——只改修法不拆循环指令，执行猫会被旧指令拖回循环（F168 R16→R17 复活实证）。
4. 同类 finding ≥3 轮（同一 stateful 对象/同一 fallback 族）→ 停手回 plan 层补状态契约（转移表+不变量），不是补第 4 个锅（LL/F229）。

进入 Step 7 之前，author 必须核对：

```bash
CURRENT_HEAD="$(gh pr view {PR_NUMBER} --json headRefOid --jq '.headRefOid')"
echo "$CURRENT_HEAD"
```

- local/cloud 对应 source 的 review SHA = `CURRENT_HEAD` → 通过
- local/cloud 对应 source 的 review SHA ≠ `CURRENT_HEAD` → **停止 merge-gate，先按 Review Provenance Matrix 判定 nextGateOwner**
  - **纯 rebase / 普通 merge / 可证明的机械 delta（Matrix `rebase` / `merge` 行 C1–C3 满足）**：`old review APPROVE + continuityProof(C1,C2,C3) ⇒ provenance 合法桥接 reviewedHead → CURRENT_HEAD` = **通过**，author 自决 + 留痕，无需 reviewer 任何表态。
  - 其他声称非行为性的 delta（biome 格式化刷新、import order）：先做 C1 的 reviewed-patch 对照；可证明没有作者语义 delta 就桥接，证明不了才做 scoped delta review。
  - 行为性 delta（代码、测试、配置、接口变化）：
    按 source 重新 review；cloud finding 修复走 cloud re-review，非 cloud 行为 delta 走 local peer re-review
- 只改 PR body / comment 不改 commit SHA → 不影响 review 覆盖范围

**作者交接格式**（ping reviewer / 汇报 merge-gate 时必须带）：
- 当前 HEAD：`{short_sha}`
- localPeerReviewSha：`{short_sha|none}`
- cloudReviewSha：`{short_sha|none}`
- headChangeCause：`{local-gate|cloud-finding|ci-fix|rebase|merge|pr-meta}`
- nextGateOwner：`{local-peer|cloud|ci|author|guardian}`

### Evidence Manifest（F253 Phase A — Review Provenance Matrix 超集）

merge-gate 执行时，在 Step 7（squash merge）**之前**，猫必须**组装并验证** evidence manifest。evidence manifest 是 Review Provenance Matrix 的超集，从 PR metadata + gate 输出实时组装——**不是独立存储的文件**。

**字段定义**：

| 字段 | 来源 | 说明 |
|------|------|------|
| `head` | `git rev-parse HEAD`（当前 worktree） | 当前 HEAD SHA |
| `localPeerReviewSha` | Review Provenance Matrix 已有 | 本地跨猫 review 覆盖的 SHA |
| `cloudReviewSha` | Review Provenance Matrix 已有 | remote review 覆盖的 SHA |
| `headChangeCause` | Review Provenance Matrix 已有 | HEAD 变化原因 |
| `nextGateOwner` | Review Provenance Matrix 已有 | 下一步门禁所有者 |
| `gate_passed` | 适用 gate 的退出码 | 选定的 targeted 或 full gate 是否通过；不是由“regular PR”自动决定 |
| `gate_commands` | 实际执行的命令 | 逐条记录真实命令；按影响范围记录文档 / 受影响检查或 `["pnpm gate"]`，附 `git diff --check` |
| `trigger_reason` | 猫判断 | 五轴风险快照 + 为什么选择这些 gate / review source；动作类型不能单独充当理由 |
| `stale` | `head` vs **headChangeCause 决定的活跃 review 源** | 按 `headChangeCause`（不是 `nextGateOwner`）判定哪个 review 源必须覆盖 `head`：`cloud-finding` → 只看 `cloudReviewSha`；`local-gate` / `ci-fix` → 实际作者 delta 默认回 local，除非 C1 证明只是机械规范化；`rebase` / `merge` → **C1–C3 全满足时 continuity 默认有效，author 自决合入 + 留痕 `skip=rebase-rereview` 或 `skip=merge-rereview`，无需 reviewer pre-approval**。**条款归因**：operator directive（`[thread-id]` msg `private-source-id`）的原意是“diff 不涉及我们自己改的代码、没有相关联的逻辑关系 → 别 re-review”；C1 的证明方法与 C3 gate 是猫方实现，不得反过来静默加严原意。**C1（作者 delta）**：比较 review 时的 authored patch 与 current authored patch；逐 commit stable patch-id 全部相同只是零 delta 的**快路**。不相同时必须显式列 `postReviewDeltaPaths`，不能把它送进 C2 冒充 base 相关性：①仅 canonical 派生物路径可在运行生成器后、再次运行得到零工作树 diff 时桥接；②仅 canonical formatter / normalizer 造成的变化，必须证明“对 reviewed 内容运行该命令得到的输出 == current blob”，且 current tree 幂等重跑零 diff；③**机械三方合并**可在逐冲突路径证明 current blob 只是 reviewed authored 内容与新 base 内容的无损并集、没有改写观点或行为时桥接（记录 reviewed/base/current 三方 diff 或等价证据）；重叠处需要语义取舍就只审那个 hunk；④其余代码、测试、配置、接口或无法证明的 delta，只让 active source review 这些真实变化。**C2（base 相关性）**：`git diff --name-only <oldBase>..<newBase>`（base 前进）与本 PR 的非派生物路径无交集，并留痕 `baseDeltaDomains=<...> relation=none:<理由>`；共享契约 / schema / export / 构建配置等跨文件耦合拿不准就只审关联部分。**C3**：同步后风险匹配的 gate / targeted tests 绿。continuityProof 在同步前固定 `reviewedHead/oldBase/newBase`，同步后记录 `currentHead`；任一项不满足只使对应真实 delta stale，不让无关 commit 重审。`pr-meta` 不改 SHA；local-only / cloud-only 分别消费自己选择的 source。 |
| `continuityProof` | `reviewedHead/oldBase/newBase/currentHead` + C1 authored-patch 对照（快路 patch-id，或 `postReviewDeltaPaths` 与 canonical-output 等价证明）+ C2 base 交集与 `relation=` + C3 gate 结果 | review provenance 桥接凭证；证明“review 后没有相关作者变化”，不是要求 SHA / range-diff 字面全等 |
| `verdict` | 猫判断 | `passed`（适用的验证与审查通过；快车道为作者交付证据，已选 review 为 final HEAD APPROVE 或 continuityProof 桥接）/ `blocked` / `pending` |

**组装时机**：Step 6.9（Evidence Validation Checker）中组装，紧接在 Step 6.8 之后、Step 7 merge 之前。

**与 Review Provenance Matrix 的关系**：Evidence Manifest ⊇ Review Provenance Matrix。前 5 个字段 = Matrix 原有字段（改名 `currentHead` → `head`），其余为 F253 新增的 gate/evidence 字段与 continuityProof 桥接凭证（准确计数随字段演进，以表为准——不再硬编码数字）。猫不需要维护两份——执行 merge-gate 时按 Evidence Manifest 全量检查即可，Matrix 是其子集。

### Evidence Validation Checker（F253 Phase A — Step 6.9）🔴

**位置**：在 Step 6.8（Hotfix Cross-Cat Review Gate）之后、Step 7.5a（Feature Doc Truth 核对）之前执行。

**适用条件**：产品快车道未选 review 时，在已有 `trigger_reason` 写适用理由与真实入口自验引用，`localPeerReviewSha/cloudReviewSha=none`，`stale`、E2/E3 的 review provenance 标 `N/A`；E4 核作者自验证据和没有未解决的相关 P1/P2，`verdict=passed` 只指本次合入证据通过，不是作者给自己 APPROVE。E1、E5 照常成立；实际风险升档或已选 review 时，恢复下表完整审查条件。这里是人工 checklist 的适用性，不新增 runtime 字段或豁免接口。

**5 项硬条件**——任一适用项不满足 → **BLOCKED，不执行 merge**：

| # | 检查项 | 验证方式 | 失败动作 |
|---|--------|----------|----------|
| E1 | `head` === PR current HEAD | `git rev-parse HEAD` vs `gh pr view {PR_NUMBER} --json headRefOid --jq '.headRefOid'` | BLOCKED — HEAD 不一致，可能有 unpushed commit |
| E2 | `stale` === false | 按 `headChangeCause` 判定的活跃 review 源覆盖当前 `head`（见上方 `stale` 字段定义的完整映射表）。`nextGateOwner=author` 时（merge-ready 态），沿用最后一次 `headChangeCause` 确定的活跃源；`nextGateOwner=ci/guardian` 时，review 覆盖规则不变（CI/guardian 是额外 gate，不改变 review 覆盖链） | BLOCKED — 补 continuityProof；只有真实新内容才 re-review |
| E3 | reviewer provenance + accepted source 闭合 | 至少一个按风险选定的 review 源（local 或 cloud）非空且覆盖 `head`；local fact 还必须带完整 accepted-source anchor，并通过 unchanged/re-ack fence；仅校验本 PR 实际选择的 source。**「覆盖」三种合法形态**：① review SHA == `head` 直接覆盖；② `old review APPROVE + continuityProof(C1,C2,C3)` 桥接 reviewedHead → `head`（Matrix `rebase` / `merge` 行，桥凭证在 Evidence Manifest）；③ **对话内容审 + author 机械转录**（2026-07-16，operator 席位纠偏）：reviewer 已在 thread 对同一内容给出明确 verdict（含 message 锚点），PR diff 与已审内容一致由 **author 出机械证据**（`git diff <已审 ref>..HEAD` 为空 / patch-id 相同 / diff hash 对照）→ author 将 verdict 转录为 PR comment（带 thread 锚点 + 机械证据），**reviewer 零二次出场**。**席位原则：机械动作（对账/转录/落点确认）归 author 或机器，判断动作才归 reviewer——召唤 reviewer 的唯一合法理由是"存在需要判断力的新内容"，两个字符串的相等判断不配烧一只 reviewer invocation** | BLOCKED — 缺 review/source provenance |
| E4 | `verdict` !== "blocked" | review 结果为 APPROVE（非 BLOCK / CHANGES_REQUESTED） | BLOCKED — reviewer 未放行 |
| E5 | `gate_passed` === true | 作者选定的风险匹配 targeted / full 验证已通过；`gate_commands` 记录实跑命令，`trigger_reason` 说明覆盖选择。targeted 不要求 full-green 收据 | BLOCKED — 必需验证未通过、未跑或覆盖不足 |

**通过时输出**（cloud-finding 流程示例）：
```
✅ Evidence validation passed
  head: abc1234
  headChangeCause: cloud-finding → active review source: cloud
  review coverage: cloud=abc1234 ✓ (local=def5678, not active for this headChangeCause — ok)
  gate: passed (pnpm gate)
  stale: false
  verdict: passed
```

**通过时输出**（local-only SKILL.md PR 示例）：
```
✅ Evidence validation passed
  head: ghi9012
  headChangeCause: local-gate → active review source: local (risk-selected; no cloud)
  review coverage: local=ghi9012 ✓
  gate: passed (light path: biome + check:features + git diff --check)
  stale: false
  verdict: passed
```

**失败时输出示例**：
```
❌ Evidence validation BLOCKED
  E2 FAIL: headChangeCause=cloud-finding → active source=cloud
           cloudReviewSha=def5678 ≠ head=abc1234
  → 需要重新触发 cloud review 覆盖当前 HEAD
```

**不是脚本——是猫执行的 checklist**。Phase A 的 evidence validation 是猫在 merge-gate 流程中人工检查 + 报告的步骤。如果需要自动化，可在后续 Phase 写 `scripts/check-qc-evidence.mjs`，但 Phase A 不做。

**与已有 Review Continuity Guard 的关系**：Review Continuity Guard 定义了"HEAD 变了怎么判 nextGateOwner"的规则；Evidence Validation Checker 在 merge 前**执行**这些规则的最终验证。前者是政策，后者是门禁。

### Gate 选择 — targeted 默认，full 按影响范围

**作者有验证裁量，也承担结果责任。** 默认执行受影响检查 + `git diff --check`。即使机器已判 full，作者确认定向检查足以覆盖实际改动时，也可直接执行这些检查、记录依据并继续合入，无需另请 operator 豁免或先排一次 full 来取得选择权。用已有 PR 正文 / evidence manifest 写清改动与依赖、实际验证及为何足够、剩余风险与合入后检查；不新增审批表或判定器。共享文件名、风险标签和旧 full 红灯本身都不是再次全量的理由。

修复先重跑精准失败用例，再跑受影响检查；已证实无关的失败保留原始证据并交对应 owner，不要求自己的 PR 等对方修完。不能仅凭“不同包”或“可能是负载”宣布无关。按风险要求的独立 review、相关或未排除关联的 P1/P2、生产数据/持久化/迁移、鉴权/权限/secret、production data boundary及不可逆操作的既有验证与授权不在本裁量内。

合入后作者继续消费既有 Alpha / CI 验证结果；尚无实际运行的回路时主动补验，不把“以后有全量”当已获得的保证。回归由作者及时修复或在既有权限内回滚，超出权限或出现产品取舍才交 operator。依据：operator `[thread-id]#private-source-id`；本条调整验证范围选择，review 是否适用由 SOP 产品快车道与风险入口决定。

定向检查确实不足以覆盖合流风险时，再运行 full，并说明缺少哪项覆盖：

```bash
pnpm gate
# 等价于 bash scripts/pre-merge-check.sh
# targeted 退出 3，仅完成分类；作者另跑所需检查。full 才执行全量。
# 只为选定的验证申请资源；不用无关红灯拖住已充分验证的改动。
```

**full gate 三件套证据**（`pnpm gate` 通过后自动打印）：
1. 命令：`pnpm gate`（全量，不是 `--filter`）
2. SHA：本轮验证的 HEAD SHA 与 gate 开始时冻结的 base
3. 状态：冻结 base 为被测 HEAD 的祖先，该候选 full-green；rebase / merge / no-op 均按脚本实际结果记录，后续 main 前进按连续性判断，不自动作废

### targeted 终态语义 — 分类成功 ≠ 覆盖通过

`pnpm gate` 冻结 base 后由 classifier 选车道。判为 `targeted` 时，命令**在申请 full-gate 资源前退出**。终态形状（S1 #4651 起，main `1419b60a74`）：

- 退出码 **3**（脚本常量 `GATE_EXIT_UNVERIFIED`）——与已验证 / 复用的 0 和真失败的 1 都不同。猫 shell、`cmd && merge` 链、managed 载体读的是这个码，不是 stdout 的颜色；
- stderr 依次打印 `⚠ UNVERIFIED — gate classification finished; this route carries no verification evidence.`、`Still owed at this exact HEAD: <requiredChecks>`（classifier 早已算出的、这个 HEAD 还欠哪些证据；为空时回落 `risk-matched-targeted-evidence`）、`Run those checks, attach their output, then merge. This terminal state never means passed.`；
- **末非空行**声明 `CAT_CAFE_MANAGED_TERMINAL_STATE=unverified`（脚本常量与 `packages/api/src/domains/ball-custody/managed-command-terminal-declaration.ts` 的同名常量由守护测试钉死）。API 侧 managed 唤醒读到它后渲染为「⚠️ 未验证（退出码 3）— 命令已完成分类，但未产出验证证据」——既不是 ✅ 也不是 ❌，并原样带上 requiredChecks。声明能力刻意做弱：不能改写退出码 0、未知 token 不猜、只认末非空行；
- **不写 green sentinel**（`scripts/write-gate-last-run.sh` 只在 `full` 通过或 `reuse` 命中时执行）。

已完成的只有 base 冻结、route 分类、`assuranceLevel` 判定；**没有跑任何测试、类型检查或 lint**。作者随后必须自己实跑 `Still owed` 列出的受影响检查（触及跨包类型时补对应 typecheck），把命令逐条写进 evidence manifest 的 `gate_commands`；`gate_passed` 只能由这些命令的真实退出码决定，classifier 的 3 不是它的输入。

**runtime 未激活时的读法**：渲染器代码已在 main，但 `live=dormant`——runtime 经 ADR-039 `pnpm runtime:restart` 激活前（在线时 `pnpm start` 是 no-op，不激活），managed 唤醒仍按旧逻辑把它显示成「❌ 退出码 3」。看到「退出码 3」一律按 3 的语义读（已分类、未验证）：不要去 debug 一个没坏的东西，也不要为它重跑 full。

历史事故：S1 之前这条路径 exit 0 + 一行黄字，2026-09-20 opus5 六次 gate 实录第 3 次差点看绿开 PR（`[thread-id]#private-source-id`）；退出码 3 与末行声明就是为此改的。

### 浏览器验证政策（operator 2026-09-20 拍板）

**决策**：浏览器旅程（`packages/web/test/browser/` 下、以显式 `test:browser` 脚本为注册表的 journey）是 feature 的验收证据，不再无条件成为所有人的 merge 门禁。S2 #4669 已落地（main `a3aa1ceded`），下表是代码事实，不是待办：

| 层 | merge 前 | merge 后 |
|---|---|---|
| 核心 smoke | `pnpm --filter @cat-cafe/web test:smoke`：`chat-connection-recovery` / `navigation-continuity` / `rich-html-interaction-continuity` 三文件；`--core-smoke` 注入执行预算 `CAT_CAFE_GATE_EXECUTION_SLA_MS=300000`（只算执行，不含排队、build、tsc 与 journey——不能把这些藏起来宣称"整次反馈五分钟"）。web 默认 `pnpm test` = `test:unit` → `test:smoke` → `test:guards`，不再串全套 | — |
| 受影响 journey | canonical `pnpm gate` 的 `test-web-browser` stage 以 `planned` 模式跑 `scripts/run-browser-verification.mjs --mode merge --base <冻结 base> --head <HEAD>`：从冻结 diff 生成 `VerificationPlan`（`requiredUnitIds` / `planFingerprint` / `coverageGaps`），交给 S3 执行 API 按资源 claim 排队执行，receipt 落 `cat-cafe-browser-verification/`；**有覆盖缺口 → stderr `{"status":"unverified","coverageGaps":[…]}` + 退出码 3，不标绿、不静默 skip**；红灯即本 PR 阻塞。public 导出形态仍跑显式 `test:browser` 全套 | — |
| 完整 journey 集合 | 不再无条件进入 canonical gate（shared-runtime 输入命中时仍可能全选）；显式 `test:browser` 仍是全套，供 feature 自己的 Design Gate 验收用 | `alpha-browser` scheduler 模板（`packages/api/src/infrastructure/scheduler/templates/alpha-browser.ts`）按 main 每个 revision 持久发现、验证、结算；delivery + trigger 被接受且 checkout 清理完成后才结算，不用来源不明的旧 green 代表新提交 |
| alpha 红灯归属 | — | 已验证的 feature owner 承接**内部 P1**（带 source）；owner 解析不唯一时保持 unresolved，不猜、不把公开发 issue 当默认动作 |

**准入与配额**（`scripts/lib/browser-verification-catalog.mjs`）：catalog 按文件建 unit（`lane` = `smoke` / `journey`），`FEATURE_FILE_LIMITS` 冻结每个 feature 的**文件数**上限——是文件配额，不是时长配额；提高配额是显式政策变更，须附实测执行成本，共用文件名前缀不等于配额共享；核心 smoke 成员超过 3 个文件需要显式准入。当前冻结值以该文件为准，不抄进本节。

**选择规则的诚实边界**：命中 `SHARED_RUNTIME_INPUTS`（`packages/web/src`、`packages/api/src` 等共享运行时输入）的改动**保守选择全部相关 journey**——这是 scope 选择不是缓存闭包，更窄的运行时依赖闭包尚未证明；只碰工具 / intake 面的改动只跑 smoke。因此成立的是：工具 / intake 改动不再为自己的验证选择无关的完整 journey；**browser×browser 仍串行**——`scripts/lib/gate-resource-policy.mjs` 给每个 browser claim 保留 `mutex:browser=1`，S3 解除的是 browser 对整个 host-heavy 池的清零、不是 browser 之间的互斥——所以 smoke 仍可能等待正在跑的其他 browser（S2 smoke receipt 实测 queue 48417ms / execution 66653ms），跨任务总等待的改善须由 receipt 验收；"改了 web 源码只跑几条"暂不成立。

**代价要如实写**：跨 feature 视觉回归可能在合入后才于 alpha 暴露，这个窗口是政策的已知成本；「可 revert」是恢复手段，**不是零风险**——revert 之前 main 已经带着错误状态，依赖它的 PR 与 alpha 验收都会被波及。

**仍未闭合、不得冒充完成**：实际 alpha 订阅、逐 revision P1 回流与 intake 总反馈时间对照由 Task `private-source-id`（owner Astra）承接；Gate ROI 总 Task `private-source-id` 只在消费者总反馈时间取得可比改善后关闭。**runtime 仍 `live=dormant`**：API 侧 alpha 模板与终态渲染要等 ADR-039 的 `pnpm runtime:restart` 激活（runtime 在线时 `pnpm start` 是 no-op，不激活，见 Step 7.5c）；激活前按「targeted 终态语义」的未激活读法处理。

**与其他 skill 的关系**：`feat-lifecycle`、`concept-demo-design`、`../.cat-cafe-shared-refs/design-in-context-checklist.md` 中「claim 或旅程文件一改，gate 强制 full」读作：该 journey 进入本次 merge 前 `VerificationPlan` 的 `requiredUnitIds`（旅程文件本身变化必选；宿主源码命中 shared-runtime 输入时仍全选），不因 claim 变化自动全选；「强制 full」保留"不能只走文档校验"的原意。

**真相源**：问题定义与托付 `[thread-id]#private-source-id`；政策接受 `[thread-id]#private-source-id`（operator quote 主执行猫的提议并 comment 同意）；分工、基线与验收机制 *(internal reference removed)*；S2 落地 PR #4669。

### 判例：门禁执行链改动的 targeted 证据边界（#4152 / #4163）

两个 PR 都改门禁执行链本身，都以「定向守护套 + 独立 review」合入、未重跑 full gate，且都以operator在同一 thread 的原话作为跳过 full 的车道授权。它们成立的部分和不成立的部分要分开写：

| | #4152 `467dae702d` 识别 owned worktree Redis | #4163 `3f45481d2b` standalone 浏览器统一 admission |
|---|---|---|
| targeted 证据证明了什么 | 租约识别的行为面正确（定向 63/63 + `check:pre-merge-gate` 158/158） | 互斥与锁序正确（focused 并发回归 + `check:pre-merge-gate`；Terra P1 已修） |
| targeted 证据**没有**证明什么 | 对并行 gate 吞吐的影响 | 对全家排队的影响：合入后 standalone 浏览器测试成为 host-heavy 池独占请求的主要**来源**（近期 receipt 窗口 41 次 / 合计 13.8 分钟；full 9 次 / 153 分钟——次数多意味着更频繁触发独占排队，执行时长大头仍在完整旅程集合） |
| 当时验收线缺的维度 | 总反馈时间 | 总反馈时间；review 只审了安全（锁序 / 死锁），没有吞吐验收 |

**修正后的规则**：

1. targeted 车道对「改动自身的行为面」是合法且足够的证据；**不因为改的是 gate 脚本就自动升 full**，升档理由仍须可查。
2. 改动触及**共享调度、资源 admission 或门禁执行链**时，PR 必须额外声明它对总反馈时间的预期影响，以及用什么 receipt / 指标验证（或明确 `unknown，由 receipt 观测`）。这不是测试覆盖，是**消费者验收维度**；review 放行不等于这一维已闭合。
3. 作者按「Gate 选择」自决足够的 targeted 覆盖，不必重求上述历史案例中的 operator 单次豁免；仍需真实实跑、现有 manifest 和独立审查，不能把裁量当作覆盖证明。
4. 此类改动合入后，对应 Gate 任务不因 PR merged 而 done；完成条件是消费者总反馈时间取得可比改善（*(internal reference removed)*「验收与验收机制」）。

### Exact-Main Receipt（main 自身的 gate 验证）

`pnpm gate` 要求在 feature branch 上运行（main 分支被拒绝）。当需要验证 main 当前内容本身通过 gate（例如 main-health guardian 初始 receipt），使用零差异隔离 worktree：

```bash
# 1. 拉最新 main 并创建零差异 feature worktree
git fetch origin main
pnpm worktree:new ../cat-cafe-exact-main-receipt --branch gate/exact-main-receipt --policy ttl --ttl-days 1

# 2. 在 worktree 里跑正常 gate（不加 --no-rebase，让 classifier + durable receipt 全走）
cd ../cat-cafe-exact-main-receipt
pnpm gate  # rebase 是零差异 no-op，receipt 正常铸造
# 如需风险加严：pnpm gate --risk contract

# 3. 完成后清理 worktree
cd -
git worktree remove ../cat-cafe-exact-main-receipt
git branch -d gate/exact-main-receipt
```

**不要**加 `--no-rebase`——本节要铸造 latest-main receipt。`--no-rebase` 仍执行 route classifier，但只作本地验证，不执行 durable receipt `begin` 或发布 canonical sentinel；未提交改动也参与分类，不能复用旧 green。正常 gate 会 fetch + rebase，但因 branch 已在 `origin/main` HEAD，rebase 是 no-op；classifier、receipt 和选中的检查正常走。

### Root Artifact Guard（Step 0.5，开 PR 前必跑）

```bash
ROOT_ARTIFACTS="$(git diff --name-only origin/main...HEAD | \
  rg '^[^/]+\.(png|jpe?g|webp|gif|webm|mp4|mov|wav|pdf|pen)$' || true)"

if [ -n "$ROOT_ARTIFACTS" ]; then
  echo "❌ 根目录存在媒体/设计工件（已提交差异），停止 merge-gate"
  printf '%s\n' "$ROOT_ARTIFACTS"
  echo "请先归档到 project-evidence/、docs/features/assets/F{NNN}/ 或其他正式目录。"
  exit 1
fi
```

这个检查和 Step 8 的脏工作树 fail-closed 互补：  
- Step 0.5 拦“已经进分支历史但放错位置”的文件  
- Step 8 拦“还在工作树里没处理的脏改动”

### 合入方式（唯一正确做法）

```bash
# 1. Push feature branch
git push origin {branch}

# 2. 开 PR（读 ../.cat-cafe-shared-refs/pr-template.md 获取 body 模板，用 HEREDOC 填写）
gh pr create --title "feat(xxx): ..." --body "$(cat <<'EOF'
... 按 ../.cat-cafe-shared-refs/pr-template.md 模板填写 ...
EOF
)"

# 3. 注册这个 PR 的追踪（F280 + #1392 AC-7）
# → 调用 MCP: cat_cafe_register_pr_tracking(repoFullName, prNumber)
#    普通情况这就是全部参数。服务端会装上 PR 自身的状态条件（review decision /
#    CI 终态 / 冲突 / 新 HEAD）和两个评论面，受众按你在这个 PR 上的角色解析；
#    返回里的 notification 写明实际装了什么、过滤了什么。
# 可选：expiresAt=<future unix ms>（省略则没有时间到期）、
#      goal={kind:'await_reply_from', authorLogins:[...]}（只听点名的人）、
#      when=[...]（高级精确入口，每种 typed 条件最多一个）
# 例：只想被 CI 终态与冲突叫醒时才写 when：
#    when=[{kind:'pr_ci_terminal'}, {kind:'pr_became_conflicting'}]
# 若注册时 CI 已经终态，live baseline 会吸收历史，不补发；立即 `gh pr checks {PR}` 并继续。
# 等待目标变化时显式 re-register；新 generation 原子替换旧 generation，不叠加 tracker/hold。
# predicate catalog、compact wake 与 terminal 语义见 ../.cat-cafe-shared-refs/pr-signals.md。
#
# 收到冲突通知时（F140 Phase B）：
# - 暂停当前工作，处理冲突优先（冲突是 merge blocker）
# - 在对应 worktree 执行 rebase（参见 ../.cat-cafe-shared-refs/pr-signals.md Phase B）
# - rebase 成功后继续原工作流
# - 复杂冲突 → 通知operator，等指示后再继续

# 4. PR body 防呆检查（禁止任何 @句柄出现在 body）
PR_BODY="$(gh pr view {PR_NUMBER} --json body --jq '.body')" || \
  { echo "❌ 无法读取 PR body，停止流程"; exit 1; }
printf '%s\n' "$PR_BODY" | rg -q '@[A-Za-z0-9_-]+ review' && \
  { echo "❌ 不合规：remote review 触发句柄只能写在 comment，不能写在 body"; exit 1; }
#    句柄模式不枚举猫名（猫会换代）：命中任何 @word，排除邮箱（前面紧跟字母数字）与 npm scope（后面紧跟 /）
printf '%s\n' "$PR_BODY" | rg -qP '(?<![A-Za-z0-9_.])@[A-Za-z][A-Za-z0-9_-]*(?![A-Za-z0-9_/@-])' && \
  { echo "❌ 不合规：PR body 禁止出现任何 @句柄（含 HTML 注释中的签名）"; exit 1; }

# 5. 仅当风险路由选中 cloud 时触发remote review；产品快车道未选 review / local-only / guardian-only lane 跳过 5–6
#    （极简格式，在 PR comment 中，不是 body！）
# ⚠️ 只发 “@codex review” 一行，不带 SHA、不带规则描述、不带审查标准！
# 详细格式会让 Codex connector 误解为代码修改请求（2026-04-20 PR #1300 确认）
# 详见 ../.cat-cafe-shared-refs/pr-template.md「云端 Review 触发 Comment 模板」

# 触发前按 pr-signals.md 读取同一 PR 的 exact trigger，避免重复 comment。
gh pr comment {PR_NUMBER} --body '@codex review'

# 6. 已选 cloud 时按 ../.cat-cafe-shared-refs/pr-signals.md 的 exact trigger contract 等结果：
# EYES=0 才能 bounded hold/re-trigger；EYES>0 后只注册 pr_review_result_available typed wait，停止轮询。

# 6.5 Guardian Sign-Off Gate (F168 Phase D — community intake PRs only)
#
# Trigger condition: PR branch links to a community issue (check PR body or branch name).
# Skip this step for non-community PRs.
#
# Do not call localhost:3004 or hand-build callback auth. The author calls
# cat_cafe_community_request_guardian(caseId, author, reviewer); the assigned non-author/non-reviewer
# guardian receives the returned checklist + signoffToken and calls cat_cafe_community_guardian_signoff.
# Merge remains blocked until the canonical community case projects an approved durable signoff.

# 6.8 Hotfix Cross-Cat Review Gate（F177 Phase E）🔴
# 运行检测脚本（不纯依赖 label — 脚本扫 commit messages + PR title）
HOTFIX_OUTPUT="$(PR_NUMBER={PR_NUMBER} node scripts/check-hotfix-pattern.mjs --apply-label {PR_NUMBER} 2>&1 || true)"
HOTFIX_JSON="$(echo "$HOTFIX_OUTPUT" | tail -1)"
if ! echo "$HOTFIX_JSON" | jq empty 2>/dev/null; then
  echo "❌ Hotfix 检测脚本输出无效 JSON，停止 merge-gate（fail-closed）"
  echo "Output: $HOTFIX_OUTPUT"
  exit 1
fi
IS_HOTFIX="$(echo "$HOTFIX_JSON" | jq -r '.hotfix // false')"
LABEL_ERROR="$(echo "$HOTFIX_JSON" | jq -r '.labelError // empty')"
if [ -n "$LABEL_ERROR" ]; then
  echo "⚠️ Hotfix label 添加失败: $LABEL_ERROR — 请手动: gh pr edit {PR_NUMBER} --add-label hotfix"
fi
if [ "$IS_HOTFIX" = "true" ]; then
  PR_AUTHOR="$(gh pr view {PR_NUMBER} --json author --jq '.author.login')"
  REVIEWERS="$(gh pr view {PR_NUMBER} --json reviews --jq '[.reviews[] | select(.state == "APPROVED") | .author.login] | unique | join(",")')"
  if [ -z "$REVIEWERS" ] || echo "$REVIEWERS" | grep -q "^${PR_AUTHOR}$"; then
    echo "❌ Hotfix PR 必须有跨猫 review 放行（禁止 self-merge）"
    echo "   Author: $PR_AUTHOR | Approved by: ${REVIEWERS:-none}"
    exit 1
  fi
  echo "✅ Hotfix cross-cat review: Author=$PR_AUTHOR, Approved by=$REVIEWERS"
fi

# 6.9 Evidence Validation Checker（F253 Phase A）🔴
#   组装 evidence manifest → 按产品快车道适用性验证 E1-E5 → 通过才继续
#   → 详见上方「Evidence Validation Checker（Step 6.9）」
#   E1: head === PR current HEAD
#   E2: stale === false (review SHA covers head)
#   E3: reviewer provenance 闭合
#   E4: verdict !== "blocked"
#   E5: gate_passed === true
```

```bash
# 7.5a Pre-merge: Feature Doc Truth 核对（在 merge 之前！）🔴
#   拿这个 PR 的代码现实对账 feature doc 当前的声称，确认 doc 没对 main 撒谎。
#   机械兜底（已含在 Step 0 `pnpm gate`）——硬拦明显 status↔timeline drift：
node scripts/check-feature-truth.mjs
# → 详见下方「Feature Doc Truth 核对（Step 7.5）」§ 7.5a（含人工核对项）

# 7. Squash merge（GitHub 处理，禁止本地 squash！）
# ⚠️ merge 退出码双向不可信 → cleanup 只由 PR truth(state=MERGED) 授权，退出码不能单独定性：
#    ① worktree false-fail（#2567 opus48 / #2837 Sol）：gh 删远端 branch 后切回 main 被主仓 worktree
#       占用而拒绝（"main is already used by <path>"）→ 远端已 merged 但【非零退出】。非零 ≠ 失败。
#    ② merge queue / auto-merge（cloud P2-2）：`gh pr merge --help` 明确 exit 0 可能只是入队 / 启用
#       auto-merge，PR 仍 OPEN 未 merged → 【exit 0 ≠ 已 merged】。盲信 exit 0 会 cleanup 未合的 PR。
#    ❌ 禁止凭退出码判 merge 成败或重跑 gh pr merge。
MERGE_RC=0
gh pr merge {PR_NUMBER} --squash --delete-branch || MERGE_RC=$?
# 定性：脚本查 gh pr view state，仅 state=MERGED 才授权 cleanup（回归测试 classify-merge-outcome.test.mjs）。
# 退出码三态——pending 不是失败，必须与真失败分开出口（cloud P2-4）：
#   0 = PR truth 确认 MERGED（clean / worktree false-fail）→ 进入 7.5b/8 cleanup
#   3 = merge_pending（merge queue / auto-merge 已入队，PR 仍 OPEN）→ 不是失败，等 PR truth=MERGED 再 cleanup
#   1 = 真失败 / indeterminate（PR truth 不可得）→ 停下诊断，禁止盲目 retry 或 cleanup
node scripts/classify-merge-outcome.mjs --pr {PR_NUMBER} --merge-exit-code "$MERGE_RC"
CLASSIFY_RC=$?
case "$CLASSIFY_RC" in
  0) : ;;  # confirmed MERGED → 继续 7.5b/8 cleanup
  3)  # merge_pending：PR 入队 / auto-merge，未 merged。不是失败——不 cleanup、不 retry、不 abort。
      echo "⏳ PR 在 merge queue / auto-merge pending（未 merged）——不是失败，暂不 cleanup。"
      echo "   等它合完再 cleanup：轮询 gh pr view {PR_NUMBER} --json state 到 MERGED，"
      echo "   或 cat_cafe_hold_ball 等 PR state=MERGED（wakeWhen 跑 gh pr view ... 命令），MERGED 后再进 Step 7.5b/8。"
      exit 3 ;;
  *)  # 1（及其它非 0/3，如 2 bad-invocation）= 真失败 / indeterminate
      echo "❌ merge 未确认成功（真失败 / PR truth 不可得）——停止 merge-gate；人工核 PR 状态"
      echo "   gh pr view {PR_NUMBER} --json state,mergeable,mergeStateStatus  （不要盲目重跑 gh pr merge 或 cleanup）"
      exit 1 ;;
esac

# 7.5b Post-merge: 仅当本 PR 改变 feature truth 时同步状态 🔴
#   Phase / AC / Status 有真实 delta → 同步 + Timeline provenance → commit → 复跑 check-feature-truth
#   仅“发生了一次 merge”不是状态 delta；无 delta 则整段跳过，不制造 doc churn
# → 详见下方「Feature Doc Truth 核对（Step 7.5）」§ 7.5b
```

### Step 7.5c: Runtime Activation Truth（按影响面触发）🔴

PR 触及 runtime 加载面（API / Web / MCP / L0 staging 等）时，merge 只证明代码落到 `main`，不证明 live runtime 已加载。合入后必须分别声明：

- `main=landed:<merge SHA>`
- `live=dormant:<当前 runtime 未加载的证据>`，或 `live=activated:<授权与新实例验证证据>`

默认终态是 `live=dormant`，不得自动同步或重启。普通待激活验收不再逐项催 You 重启：若当前运行实例已真实暴露 `cat_cafe_register_deployment_wait`，把“精确目标 deployment 包含本次 frozen merge SHA 且所需服务 ready”登记到**原验收 / 开发 work Task**，取得 typed 持久回执后再报告：

- `main=landed:<merge SHA>`
- `live=dormant:<当前 runtime 未包含该 SHA 的证据>`
- `deploymentWait=<原 Task id + generation + deployment subject + receipt>`

登记是续办责任，不是部署授权：不调用 `hold_ball` 轮询，不因登记执行 restart，也不把业务 Task 写成 done。目标版本真实 ready 后，系统沿原 Task owner / thread 一次性接回；猫再执行 `nextStep` 的真实验收。确无合适 Task 时，只能沿已有授权与 F310 接责契约建立承载验收的 work Task；**不能从 merge 事件推导新授权，也不能复制已有 Task**。

只有operator显式授权后，才从持有 main 的 worktree 走 ADR-039 的显式动作（Invariant 2）：runtime 已在线时 `pnpm start` / `pnpm runtime:start` 只是"未运行才启动"的幂等 no-op——不 fetch、不 build、不发信号，**不会激活新代码**；更新现有实例必须 `pnpm runtime:restart`，它结束身份核验过的旧实例后由同一实现完成 sync + build + 重启。禁止进入 `cat-cafe-runtime` 手工 pull / build / restart。

激活后的验证必须来自**新进程或新 invocation**：至少证明 runtime HEAD 包含目标 merge SHA，并验证一个该 PR 改变的真实加载面。旧进程上的源码 diff、重复 delivery receipt、或 main 文件存在都不能冒充 live 生效。

**首次引导 / 能力未加载边界**：工具在当前运行实例不可见、route 返回 not-ready，或登记没有返回持久 Task/generation 回执时，禁止写“已登记”。这通常发生在 F323 登记能力自身第一次合入、尚未激活的窗口；保留现行路径，带 Decision Packet 路由 `@co-creator`，并明确 `registration=unavailable`。能力可见不等于登记成功，源码里已经有工具也不等于 live 已加载。

普通情况已有等待回执后不再单独 @co-creator。只有紧急激活，或出现新增权限、显著成本、产品取舍，才带 Decision Packet 路由 `@co-creator`；等待人类回复不调用 `hold_ball`。只有完成授权后的启动与新实例 probe，才能改报 `live=activated`。

### Step 7.6: Hotfix 升级 Review Cron 注册（F177 Phase E）🔴

**触发条件**：Step 6.8 检测到 `IS_HOTFIX = true` 时执行；否则跳过直接进 Step 8。

**时机**：merge 完成后、清理前。`delayMs: 1209600000`（14 天）从注册时刻起算 ≈ 合入后 14 天。

**操作**：调用 MCP 工具 `cat_cafe_register_scheduled_task`：

| 参数 | 值 |
|------|------|
| `templateId` | `"reminder"` |
| `trigger` | `{"type":"once","delayMs":1209600000}` （14 天） |
| `label` | `"Hotfix 升级 review — PR #{PR_NUMBER}"` |
| `description` | `"2 周升级 review：PR #{PR_NUMBER} 是 hotfix，需要三选一处置"` |
| `category` | `"pr"` |
| `params` | `{"message":"Hotfix PR #{PR_NUMBER} 合入已满 2 周。请三选一处置：1. 升级正式修复（开 feat）2. 接受永久方案（标记 permanent）3. 已不再相关（代码已重写/删除，标记 obsolete）"}` |

**注册范围**（2026-07-15 修订）：仅对**明确临时债务**注册（修法自声明是权宜、欠正式方案）；走了 hotfix 流程但修法本身已是终态的，留痕 `reminder=not-needed:<理由>` 免注册。**注册失败不阻塞清理**：记 telemetry / 留痕后继续 Step 8，事后补注册——调度器故障不该扣押 worktree（旧版 fail-closed 是自噬环）。

```bash
# 8. 更新本地 + 清理（fail-closed）
# ⚠️ 发现脏工作树就停止，不要“即兴”用 git stash -u 清理。
# 原因：git stash -u/--include-untracked 会删除 untracked 文件（内部 git clean），
# 在多 session 共享工作目录时可能导致其他 session 的未 commit 产出丢失。
if [ -n "$(git status --porcelain)" ]; then
  echo "❌ 工作树不干净，停止 merge-gate（fail-closed）"
  echo "请先处理改动后再继续。禁止使用 git stash -u/--include-untracked。"
  git status --short
  exit 1
fi
# 本段从主仓（持有 main 的 worktree）执行；7.5b 已 cd 至此，git checkout main 幂等 no-op。
# 勿在 feature worktree 执行 git checkout main（main 被主仓占用会被拒绝，见 7.5b）。
git checkout main && git pull origin main
git worktree remove ../cat-cafe-{feature-name}
git branch -d {branch-name} && git worktree prune

# 8.5 回收 review 沙盒（review-target-id 与 request-review 约定一致）
REVIEW_TARGET_ID="{review-target-id}"  # e.g. f113 or fix-redis-keyprefix
REVIEW_BASE="/tmp/cat-cafe-review/${REVIEW_TARGET_ID}"
if [ -d "$REVIEW_BASE" ]; then
  for sandbox in "$REVIEW_BASE"/*/; do
    [ ! -d "$sandbox" ] && continue
    # no-force 铁律（LL-012）：有未保存改动 → 报阻塞，不硬删
    if git worktree list 2>/dev/null | grep -q "$sandbox"; then
      STATUS=$(cd "$sandbox" && git status --porcelain 2>/dev/null)
      if [ -n "$STATUS" ]; then
        echo "⚠️ Review 沙盒 $sandbox 有未保存改动，跳过"
        continue
      fi
      git worktree remove "$sandbox"
    else
      rm -rf "$sandbox"
    fi
  done
  rmdir "$REVIEW_BASE" 2>/dev/null
  echo "✅ Review 沙盒已回收: $REVIEW_BASE"
fi
git worktree prune  # 清理 dangling worktree references
```

### remote review 选择与处理规则

**⚠️ LL-033 教训：必须检查 inline code comments！**

remote review 的 P1/P2 可能在 **inline code comments** 里，不在 review body 里。
`gh pr view` 的 `--json reviews` 只返回 review body（可能显示"no major issues"），
但 inline code comment 里可能有 P1。

#### 什么时候选 cloud

云端 Codex 没有 Clowder AI MCP，看不到 thread / memory / 家里 SOP 演化历史；它的价值是 context-blind 代码扫描，不是所有 PR 的第二张门票。

**优先 local、默认不选 cloud**：
- `cat-cafe-skills/**`、家规、SOP、治理 / discussion 等依赖家里语境的改动；
- 风险低、targeted checks 精确、local stateful reviewer 足以覆盖的实现；
- co-creation docs classifier 返回 `cloudReview=skip`。

**优先 cloud**：
- secret / auth / SSRF / DoS / 生产数据 / 外部契约等高风险代码面；
- 跨包或陌生代码，需要独立 context-blind 扫描；
- inbound community PR 的 source-intent / 外部边界验证。

普通 `packages/**` 或 test 改动**不因文件类型自动触发 cloud**；先看五轴风险与 targeted coverage。若 local 与 cloud 同时使用，PR body 必须分别写明两者覆盖的不同风险面。未选 cloud 时记录 `cloudReview=not-selected reason=<...>`，不是“豁免申请”。

事故来源：PR #1661 的纯 SOP 改动在 local review 后又无意识触发 cloud；第二刀把“默认触发 + 申请豁免”反转为“有风险理由才选择”。

#### 层级 A：通知已包含 severity（自动）

ReviewRouter 现在会在投递通知时**主动拉取** review body + inline comments，
提取 P0/P1/P2 findings 并写入通知消息。如果通知里已有 severity header
（`Review 检测到 P1`），说明**有 actionable findings，必须处理**。

#### 层级 B：merge 前软守护（手动确认）

即使通知层漏报（GitHub API 暂时不可用、新 commit 后内容变化），
merge 前仍需执行以下检查作为兜底：

```bash
gh api --paginate repos/{OWNER}/{REPO}/pulls/{PR_NUMBER}/comments \
  --jq '.[] | select(.body | test("\\bP[012]\\b"; "i")) | {body: .body[:200], path: .path}'
```

- 有 P1/P2 输出 → **WARNING**，确认是否已处理后再决定是否继续
- 无输出 → 通过，继续 Step 7
- 命令执行失败 → **不默认通过**，排查原因或手动检查 PR 页面

| 结果 | 处理 |
|------|------|
| 0 P1/P2（review body + inline comments 都无） | 通过，执行 Step 7 |
| P1/P2 有复现证据 | 在 feature branch 修 → push → **re-trigger review** → 等通过 |
| P1/P2 无复现证据 | 降级 P3，留 comment，视为通过 |
| 误报 | 留 comment 解释，视为通过 |
| 架构/改法建议（非 P1/P2） | **过 VERIFY 三道门再决定改不改**（见 receive-review VERIFY）。云端没有运行环境，理论推理 < 本地实测。改坏能跑的功能 = P0 |

### Feature Doc Truth 核对（Step 7.5）🔴

**为什么在 merge-gate 而不是 feat-lifecycle close**：一个 Feature 拆 N 个 Phase/PR，如果等 close 才核对/更新文档，中间所有 session 冷启动读到的都是过时甚至**说谎**的状态。**每次 merge 都是一次"代码现实 ↔ feature doc"对账**——merge 前核对 doc 没撒谎，merge 后记录已合入。这不是只在最后做的事，是每个 PR 的增量动作。

#### 7.5a — Pre-merge：核对 feature doc 是否说真话（在 Step 7 merge 之前）

merge 是把状态写进 main 的不可逆点（其他 session 立即读到）。合之前，拿**这个 PR 的代码现实**对账 feature doc 当前的声称，确认没有对 main 撒谎：

1. **识别 Feature**：从 PR title/branch 提取 `F{NNN}`（无 Feature ID → 跳过，纯 TD/hotfix 不需要）。
2. **声称 vs 代码现实**（人工 — 语义层机器判不了）：
   - feature doc 里标 ✅ 的 Phase / 打勾的 `[x]` AC，**这个 PR（及历史）的代码真做了吗**？严防"doc 声称完成但代码是 stub / 没做"——糖衣包装"未做"（参 self-evolution「下次一定」）。
   - **Status 行**和真实开发阶段一致吗？（写 `spec`/`spike` 但代码已在跑 = 撒谎）
   - 反向：代码已做的，doc 漏记了吗？
3. **机械兜底** `node scripts/check-feature-truth.mjs`（已含在 Step 0 `pnpm gate`）：硬拦**明显**矛盾 —— Status 仍是 pre-development（`spec`/`design`/`idea`/`draft`/`spike`/...）但 `## Timeline` 已有 merged PR 且无 reopen 标记。机器**只抓这一类零歧义 drift，不替你判 AC/Phase 语义**。
4. **核对不过 → 先修 doc 再 merge**：doc 撒谎（过度声称 / 漏记 / Status 虚高）当场修正、commit、重新核对。**禁止带着说谎的 doc 合进 main。**

#### 7.5b — Post-merge：记录已合入状态（在 Step 7 merge 之后）

⚠️ **切到持有 main 的 worktree 再 commit**：`gh pr merge --squash --delete-branch` 之后你仍在 feature worktree 上。直接 commit 会落到**已合并/已删的 feature branch**（或留脏工作树让 Step 8 fail-closed abort）。而且 worktree 开发场景下 `main` 由主仓 worktree 持有——**在 feature worktree `git checkout main` 会被 git 拒绝**（ref 已被另一 worktree 占用）。所以切到持有 main 的 worktree（而非 checkout）：

```bash
# 找到持有 main 的 worktree（通常是主仓 cat-cafe/），cd 过去做 doc-sync：
MAIN_WT="$(git worktree list --porcelain \
  | awk '/^worktree /{wt=substr($0,10)} /^branch refs\/heads\/main$/{print wt; exit}')"
cd "$MAIN_WT" && git pull origin main   # 取回刚 squash 的 commit，doc-sync 落点切到 main
```

然后先判断这个 PR 是否带来 **feature truth delta**：Phase 完成、AC 达成/删除/签字、Status 推进。**“PR merged”这个事实本身不是 feature truth delta**；若三者均无变化，整段 7.5b 留痕跳过，Timeline 也不追加。

仅在存在上述 truth delta 时，**在 main 上**把这个 PR 带来的增量写进 feature doc：

1. **更新 feature doc** `docs/features/F{NNN}-*.md`：
   - **Phase 状态**：本 PR 对应的 Phase 标记从 📋/🚧 → ✅
   - **AC 打勾**：本 PR 实际完成的 AC 项 `[ ]` → `[x]`（只勾代码真做了的 —— 7.5a 已核对）
   - **Timeline**：为这次 truth delta 加一行 provenance：`| {YYYY-MM-DD} | Phase {X} merged (PR #{N}) |`
   - **Status 行**：第一个 Phase 完成 `spec` → `in-progress`；最后一个 Phase 视情况推进（`done` 留给 completion 愿景守护）
   - **不做**：不动 Dependencies/Risk/Links（kickoff/completion 的事）
2. **Commit + push**：只有 Phase / AC / Status 至少一项真实变化才会进入本段；Timeline 是该变化的 provenance，**不能反过来把自己当成触发 commit 的理由**。本 PR 未改变 feature truth → 留痕跳过，不产出空 doc commit 刷 main（churn + index 竞态源，2026-07-15 修订）。派生 index 由生成器 / merge finalizer **机器独占维护**，不随手工 doc commit 顺手刷。message `docs(F{NNN}): sync phase progress after PR #{N} merge`（文档同步不需走 review）。
3. **复验**：再跑一次 `node scripts/check-feature-truth.mjs` —— 确认 post-merge 写入没引入新 drift（例如加了 merged Timeline 却忘把 `spec` 推进成 `in-progress`，lint 会抓）。

> 落点说明：7.5b 切到持有 main 的 worktree（通常是主仓）做 doc-sync；后续 Step 8 清理本就从主仓发起（`git worktree remove ../cat-cafe-{name}`），此时已在 main worktree，其 `git checkout main` 幂等 no-op。单仓无独立 feature worktree 时 `git worktree list` 只返回主仓，cd 即原地。

**检查清单**：
- [ ] **(pre)** doc 标 ✅ 的 Phase / 打勾 AC 都有代码支撑（没撒谎）
- [ ] **(pre)** `check-feature-truth` 绿（无 status↔timeline drift）
- [ ] **(post, 有 truth delta 时)** Phase / AC / Status 与现实同步，Timeline 记录同一 delta
- [ ] **(post, 有 truth delta 时)** 复验 `check-feature-truth` 仍绿
- [ ] **(post, 无 truth delta 时)** 已留痕跳过，未仅为 Timeline 制造 doc commit

## Quick Reference

| 条件 | 检查方式 |
|------|---------|
| Reviewer 放行？ | 搜索明确信号词 |
| P1/P2 清零？ | 检查 review 记录 |
| BACKLOG 更新？ | `grep '\[x\]' docs/ROADMAP.md` |
| 选中 cloud 时通过？ | review body + inline comments + `gh pr checks {PR}`；未选 cloud 记录理由 |
| Evidence validation 通过？(Step 6.9) | E1-E5 五项全绿（head 一致 + review 不 stale + provenance 闭合 + verdict passed + gate passed） |
| Feature doc 说真话？(pre-merge) | doc 标 ✅/打勾 AC 有代码支撑 + `node scripts/check-feature-truth.mjs` 绿 |
| 已合入状态记录？(post-merge) | 有 Phase/AC/Status truth delta → 同步并加 Timeline provenance；无 delta → 留痕跳过 |
| `route=targeted`（退出码 3）后能直接开 PR？ | 不能——3 = 已分类、零测试；按 `Still owed` 列表实跑受影响检查并写入 `gate_commands` 后才算 `gate_passed` |
| 浏览器旅程要在 merge 前全跑？ | 不：核心 smoke（3 文件、执行预算 300000ms）+ 冻结 diff 选出的 `requiredUnitIds`（缺口退出码 3，不标绿）；全套只在显式 `test:browser` / Design Gate / alpha 逐 revision。改 `packages/web/src` 等共享运行时输入仍会选全部相关 journey；browser×browser 仍串行，smoke 可能等待其他 browser，跨任务等待改善看 receipt |

## Common Mistakes

| 错误 | 正确 |
|------|------|
| 机器判 full 或旧 full 红，就只等待、重跑或找 operator 豁免 | 作者核实关联、执行足够的受影响检查并记录理由；无关红灯交原 owner，相关红灯修好。按「Gate 选择」合入并承担后续回归责任 |
| 因为“regular PR / packages 改动”默认叠 local + cloud | 先做五轴风险判断，默认一个合适的独立 source；高风险才按不同风险面叠加 |
| PR body 里写了remote review 触发句柄 | 在 PR **comment** 里写（body 里写会触发代码修改权限而非 review） |
| PR body 或 HTML 注释里写了 `@句柄`（例如签名） | **PR body 禁止任何 @句柄**，签名改为纯文本（写自己的 catId，不带 `@`） |
| 触发 comment 带了多行描述（SHA/规则/审查标准） | **只发 `@codex review` 一行**，详细内容让 Codex 误解为代码修改请求 |
| 同一个 commit 连续发多条触发 comment | 先做 Step 5.1 去重检查；只有新 commit 才 re-trigger |
| 触发后立刻轮询或手动重触发 | 5 分钟后查 👀（Step 6.1）；有 👀 = PR tracking 自动通知，**释放 hold_ball 不再轮询**（KD-27）；无 👀 = 允许 re-trigger |
| 修了 P1 没让 active source 覆盖新 HEAD | local finding 回 local；cloud finding 才 re-trigger cloud |
| cloud P1/P2 修完后又 @ 本地旧 reviewer 续签 | `headChangeCause=cloud-finding` → re-trigger cloud review + 等 PR tracking；本地 peer 不是 Stage ④ 常驻 gate |
| `pnpm gate` rebase / merge / fixup 后**不做判定**就沿用旧 review 直接 merge | 先对齐 `headRefOid`；**只要 HEAD 变了，先按 Review Provenance Matrix 判定 nextGateOwner**（rebase / merge 的 C1–C3 全满足 = 合法 continuity + 留痕；未判定未留痕就沿用 = 违规） |
| owned feature branch 同步 main 后一律 force push，或因为 SHA 变化不敢普通 push | 核对 local/remote 方向及实际同步方式：保留发布 tip 的 merge 普通 `git push origin {branch}`；实际 rebase 改写历史且已有授权覆盖时才 `--force-with-lease`。再按 C1–C3 做 continuity / evidence validation |
| 本地 `git rebase -i` 手动 squash | 用 `gh pr merge --squash`（GitHub 处理） |
| 本地 merge 后 `gh pr close` | `gh pr close` = 放弃，`gh pr merge` = 合入 |
| `gh pr merge` 非零退出就判 merge 失败 / 重跑 | worktree 里远端 merge 成功但本地切回 main 被拒也会非零退出（#2567 opus48 / #2837 Sol）；Step 7 用 `classify-merge-outcome.mjs` 查 PR truth 定性——state=MERGED 进 cleanup、**禁止重跑**；真失败才 block |
| 把 merge queue / auto-merge pending 当 merge 失败 abort | exit 0 + PR OPEN = 入队 / auto-merge pending（不是失败，cloud P2-4）；classify 给独立 exit 3，Step 7 `case 3` 分支等 PR truth=MERGED 再 cleanup——**pending 不 cleanup、不 retry、不 abort、不标成 failure** |
| 选了 cloud 却没等结果就合入 | 选中的 source 必须覆盖 final HEAD 且 P1/P2 已处置；未选 cloud 不等待它 |
| 把截图/录屏/.pen 直接 commit 到仓库根目录 | Step 0.5 Root Artifact Guard 先拦截；先归档再开 PR |
| 跳过 evidence validation 直接 merge | Step 6.9 五项 E1-E5 全过才能进 Step 7；不组装 evidence = 不知道 review 是否 stale |
| Merge **前**不核对 feature doc 说真话 | Step 7.5a：标 ✅/打勾 AC 必须有代码支撑，`check-feature-truth` 绿，再 merge |
| Merge **后**无条件追加 Timeline | Step 7.5b：先判 Phase/AC/Status truth delta；有才同步并记 provenance，无则整段跳过 |
| Merge 后不清理 review 沙盒 | Step 8.5 按 review-target-id 回收 `/tmp/cat-cafe-review/` |
| 看见 `Gate route=targeted` 就当 gate 绿了开 PR / 合入 | targeted 退出码 3 = 分类完成、零测试；自己实跑 `Still owed` 的受影响检查并写进 evidence manifest（「targeted 终态语义」） |
| 把「退出码 3 / ⚠️ 未验证」（或 runtime 未激活时的「❌ 退出码 3」）当普通失败去 debug 或重跑 full | 3 不是坏了，是已分类未验证；按 `Still owed` 补证据即可（「targeted 终态语义」） |
| 改门禁执行链 / 共享调度只交定向测试 + review 就宣布"gate 已提速" | 定向证据只覆盖行为面；另报总反馈时间预期与验证方式，任务不因 PR merged 而 done（判例 #4152 / #4163） |
| 把"可 revert"写成"零风险" | revert 是恢复手段；暴露窗口内 main 已带错，波及依赖 PR 与 alpha——如实记录代价（「浏览器验证政策」） |

### **⚠️⚠️ 反面案例（PR #160）— 必须记住**

**错误行为**：
- PR description 里签名写了 `(@句柄)`（在 HTML 注释里）
- 后续说明评论又写了 `@句柄`

**后果**：
- 触发了 `chatgpt-codex-connector` 的“Create an environment”自动回复
- remote review 没有实际执行，流程被噪声污染

**硬规则（加粗执行）**：
- **PR body（含 HTML 注释）禁止出现任何 `@句柄`**
- **只允许在专用触发 comment 里使用标准触发模板（见 ../.cat-cafe-shared-refs/pr-template.md）**

## 常见 QA（云端 Review 触发）

### Q1: 出现 "Create an environment for this repo"，是不是 review 没权限？

**不是。**

**⚠️ THIS IS NOT A REVIEW-PERMISSION ERROR. THIS MESSAGE IS ABOUT CODE-WRITE ENVIRONMENT PERMISSION.**

**最常见原因**：comment body 里带了多行内容（SHA、审查标准、规则描述等），Codex connector 把它解析成了**代码修改请求**而非 review。即使第一行是 `@codex review`，附加描述在当前解析规则下仍会触发 code-write intent。

**动作**：**只发 `@codex review` 一行**重新触发（同 SHA 不需要新 commit）。

```bash
gh pr comment {PR_NUMBER} --body '@codex review'
```

> 教训演进：2026-04-18 曾以为是"后台 bug / 没接单"，2026-04-20 PR #1300 确认根因是**详细格式触发 code-write 解析**。极简格式是唯一可靠触发方式（PR #1258 + PR #1300 两次实战验证）。

### Q2: PR 里看到小眼睛（👀）是什么意思？

**小眼睛 = remote reviewer 已接单/已看到触发。**

**⚠️ EYES ICON MEANS "REQUEST RECEIVED", NOT "FAILED".**

它不是失败信号，也不等于环境错误。后续是否通过，以 review comment / findings 为准。

### Q3: 触发后多久需要再操作？

默认 **不操作**。

- **5 分钟后查一次 👀**（Step 6.1）：有 👀 = 已接单，PR tracking 会自动通知，猫猫不用管
- **无 👀** = 云端没接到 → 允许 re-trigger
- 有 👀 的情况下严禁重复触发

### Q4: remote reviewer 没猫粮了怎么办？

云端 Codex 的"代码审查"额度独立于总额度，可能单独耗尽。此时降级到其他猫做 **完整 PR review**（不是跳过 review！）：

| 原 reviewer | 降级到 | 说明 |
|-------------|--------|------|
| 云端 Codex / 任一Maine Coon（OpenAI 池） | **另一 provider** 的在役本地 reviewer（当前为Ragdoll家族；按 dossier 常驻索引 + F293 可用性选具体个体） | **跨 provider family**：OpenAI 各 model 共享 API 池，一个没猫粮 = 都没猫粮 |
| Ragdoll某个体 | Ragdoll其他在役个体 / Maine Coon | 同族或跨族 |
| **禁止** | Siamese | 家族约束：不做代码 review（新版本是否放宽，等真实任务证据写进 dossier 再改） |

**铁律：降级后仍须校验"reviewer ≠ 作者"**——降级表是建议顺序，不能覆盖 self-review 禁令。

**⚠️ 共享 API 池陷阱（F238 教训）**：同一 provider 的不同 model（Codex/GPT-5.4/GPT-5.5）共享 API 额度。降级必须跨 provider family（OpenAI → Anthropic），不能在同 provider 内换个体。

操作：`gh pr comment {PR} --body "..."` 用标准触发模板 @ 降级 reviewer（句柄查 `cat-config.json`）。

## 和其他 skill 的区别

- `quality-gate`: 自检（在 review 之前）
- `request-review` / `receive-review`: review 循环（在 merge 之前）
- **本 skill**: review 通过后的合入全流程

## 下一步

合入后判断 feature 规模：

**最后一个 Phase（或小 Feature）** → `feat-lifecycle` completion：
1. 自己做愿景三问。
2. 用户可见、产品方向或愿景发生变化 → 按 `feat-lifecycle` 的作者范围与独立性要求选择守护猫（含排除当前体验 Design Gate 定稿人）；这是终态风险触发，不是每个 PR 固定第三审。
3. 纯内部机械 change 且没有 feature-close 愿景面 → 记录 `guardian=not-triggered reason=<...>`，不为流程完整度召唤守护猫。
4. 守护触发时：放行才 close；踢回则修改并跑与 delta 匹配的验证。

**中间 Phase** → 按 Step 7.5 同步实际 truth delta，让阶段成果、用户实得、剩余差距和下一步可见。已确认方向内自主推进；发现愿景、范围或体验分叉时，按 `feat-lifecycle` 的「Phase 进度与方向校准」拿具体稿及时共创，不为每次 merge 再设确认轮次。

---

## CI Repair Loop (F253 Phase C)

When CI fails after push:

1. Read CI output → `classifyCiError(output)` (from `scripts/classify-ci-error.mjs`) → get error class + deterministic flag
2. If non-deterministic → **escalate immediately** (post to thread, @ author)
3. If deterministic + round < 2 → run `autoFixCommand`, commit, push
4. If deterministic + round ≥ 2 → **escalate** (same error class won't auto-fix after 2 tries)
5. Track round count via PR label `ci-repair-round:N`

**Allowlisted auto-fixes**: biome format, biome lint (non-suspicious)
**Never auto-fix**: test failures, type errors, lint/suspicious, unknown errors

Use `shouldAutoFix(classification, sameClassRound)` to check the protocol.
State machine: idle → attempt_1 → attempt_2 → escalated (terminal).
