---
name: quality-gate
description: >
  开发完成后的自检门禁：愿景对照 + spec 合规 + 验证。
  Use when: 准备对交付作完成声明、需要整理风险匹配的自证。
  Not for: 收到 review 反馈（用 receive-review）、merge（用 merge-gate）。
  Output: Spec 合规报告（含愿景覆盖度）。
triggers:
  - "开发完了"
  - "准备 review"
  - "自检"
  - "声称完成"
---

> **SOP 位置**: 本 skill 是 `sop-definitions/development.yaml` stage `quality_gate` 的执行细节。
> **SOP definition**: `sop-definitions/development.yaml` stage `quality_gate`。
> 这是按需自检车道，不绑定固定上一步 / 下一步；完成后把证据交给实际选择的独立验证源或交付载体。

# Quality Gate

完成声明前做两件事：对照真实需求自检，并用与风险面匹配的真实命令输出证明声明。

## 核心知识

**两条铁律合一**：

1. **Spec alignment**（来自 `spec-compliance-check`）：AC 可能写偏，先回读原始需求，再逐项验收
2. **Evidence before claims**（来自 `verification-before-completion`）：没有运行命令、没看到输出，就不能说"通过了"

> 铁律：`NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE`
>
> 自问："我是这次真的运行了命令并看到输出，还是我只是相信它能工作？"

**为什么 AC 可能不够**：AC 是人写的，可能遗漏 UX 要求或场景覆盖。F041 教训：AC 全打勾，但operator的原始需求（能力显示描述、多项目管理）根本没进 AC——spec compliance check 检查了 AC，但 AC 本身就是错的。

## 流程

```
BEFORE 声称完成 / 提 review:

Step 0: VISION CHECK（愿景核对）
  ① 找原始 Discussion/Interview 文档（operator experience在里面）
  ② 读核心痛点："我要..."、"我不想..."
  ③ 问自己：operator坐在 Hub 前用这个功能，体验是什么样的？
  ④ AC 是否完整覆盖了operator的原始需求？
     → 如有遗漏，先补 AC 再继续

Step 0.5: DELIVERY COMPLETENESS CHECK
  ① 这次交付的是完整 feat 还是 feat 的一部分？
     → 完整 feat：继续
     → 部分：有operator明确同意分批交付的记录吗？没有就继续做完
  ② 本次产出后续需要"重写"还是"扩展"？
     → 扩展：通过
     → 重写：如果是已标注 Spike 且有结论，通过；否则不通过，回去重做

Step 1: FIND — 找 spec/plan 文档
  - the active feature spec or implementation plan
  - 同时找 Discussion/Interview（operator experience所在）

Step 2: CREATE — 建检查清单
  - 列出每一个 AC / 功能点 / 边界条件
  - 列出 Discussion 里的 UX 描述和场景

Step 2.5: CLOSE GATE MATRIX + FOLLOW-UP TAIL SCAN（F177 Phase A）🔴
  - 检查 CloseGateReport 是否已生成（schema: `cat-cafe-skills/refs/close-gate.md`）
  - 每个 unmet AC 是否三选一处置（immediate / delete / cvo_signoff）
  - **Follow-up tail scan**：扫以下文本来源，命中关键词 = **线索（进入语义判定），不是自动 BLOCKED**——判定标准只有一条：该词是否在把 **unmet AC 包装成已完成 / 偷偷延期**（close 借口）。正常阶段描述（"X 属 next phase 的 scope"）、风险讨论、路线图引用不触发（2026-07-15 修订：raw keyword 自动 BLOCK 误杀正常文本）：
    - 来源：close report、PR body、commit messages、spec 中 AC 注释、review 反馈回复
    - 线索关键词（不区分大小写；仅用于定位待语义检查处）：
      `follow-up` `followup` `deferred` `next phase` `next PR` `P2` `stub` `TD`
      `后续` `留个尾巴` `先这样` `下次一定` `回头` `以后再` `will address later`
      `out of scope`（作为 close 借口时）`MVP 先上`（作为 close 借口时）
    - 豁免：spec 的 Why/Risk/History 章节中引用历史上下文时使用这些词不触发
  - cvo_signoff 四件套完整性验证（proposal + cvo message + quote + scope）
  - 🔴 **47 盲审规则**（F177 Phase B）：若 PR 作者是 opus-47，quality-gate 必须由对家猫执行（Maine Coon优先，46 兜底）。审核者由 reviewer/系统指定，47 无选择权，47 的自评不计入放行判据
  - 🔴 **hotfix 自检禁止**（F177 Phase E）：执行 `node scripts/check-hotfix-pattern.mjs`，若检测到 hotfix 模式，作者不得自行通过 quality-gate——必须由另一只猫执行 quality-gate。原因：hotfix 心态容易自我说服"够用了"，跨猫审视打破惯性
  - 🔴 **Ragdoll search→Read 检查**（F177 Phase F）：若执行者是Ragdoll家族（46 / 47 / 4.5 / Sonnet），检查本次 session 的 search 行为：
    1. 有 `search_evidence` 调用命中 doc anchor（高/中置信度）吗？
    2. 命中后有对应的 `Read` 调用去读源文件吗？
    3. 输出中包含精确数字/版本号/日期但没有 Read 证据吗？
    → 三条件同时满足 = **BLOCKED**："这个精确结论你 Read 源文件了吗？摘要是索引不是答案。"
    → 豁免：架构方案/假设性讨论（不含精确数字的推理不触发）；通过 Grep/LSP 获取的精确信息不触发
  - 🔴 **Siamese edit scope 检查**（F177 Phase C）：若 PR 作者是Siamese，检查改动文件是否超出白名单（designs/ docs/ assets/ 根目录.md）。碰 packages/ src/ 的改动必须有对应 handoff 记录或 Dry Run Gate 通过证据（build + test pass）

Step 2.6: FALLBACK LAYER CHECK（F177 Phase D）🔴
  - 执行：`node scripts/check-fallback-layers.mjs` 扫描 PR diff
  - 同一文件新增 ≥3 层 fallback 或累计 ≥5 层 → 触发坐标系自检
  - 自检三问：①修坐标系还是补错误坐标系？②坐标变换能否消除？③每层为什么不能去掉？
  - 层数合理时在报告中说明理由；不合理时重构后再过 gate

Step 2.7: ARCHITECTURE OWNERSHIP REPORT（F191，warning-only）🔴
  - 执行：`pnpm check:architecture-ownership`
  - 从 spec / plan 抄入：
    `Architecture cell` / `Map delta` / `Why`
  - 若缺失，报告 `⚠️ missing` 并列为 review focus；不在 quality-gate 做 semantic hard block
  - 若 `Map delta: none` 但 diff 明显新增 `Store|Queue|Router|Adapter|Dispatcher|Binding` 等架构名词，报告 mismatch 给 reviewer
  - 若 `Map delta: update required|new cell required`，报告对应 ownership cell / new cell 文件是否随 PR 更新
  - 注意：quality-gate 只报告机械可见事实；架构语义正确性由 Design Gate + reviewer 判断

Step 3: VERIFY — 逐项检查
  - 代码在哪？有测试覆盖？边界处理了？
  - 🔴 F244 Tips Contribution：若本 PR 新增/修改 user-visible feature / capability / guide / harness behavior，
    必须满足其一：
    ① `packages/web/src/lib/capability-tips.seed.json` 有对应 `sourceRef` tip
    ② 相关 feature/guide/skill 文件写明 `tips_exempt: {reason}`
    并执行 `pnpm check:capability-tips`。
    注意：CI 只证明结构/anchor/action；reviewer 仍要退回只复述标题、没有动作或时机的废话 tip。
  - 🔴 交付物必须核实 commit/PR 状态（git log --grep + gh pr list）
    spec checkbox 是记录工具，不是真相源（LL-029）
  - 🔴 新增 MCP 工具 → 认知入口更新了吗？优先级：MCP tool description → 相关 skill refs → capability wakeup / L0 quick index；只有 legacy/fallback surface 仍依赖时才补 `MCP_TOOLS_SECTION`（F086 教训：造了工具猫不知道；F203 后不再默认塞 SystemPromptBuilder）
  - 🔴 新增行为规则 → governance digest / shared-rules 注入更新了吗？
  - 🔴 产出了 SKILL.md 或改了 MCP tool description → 加载 `writing-skills`，用 T0 六要素审查质量（软硬同检）

Step 4: RUNTIME GUARD — 前端证据采集前先做运行态保护
  - 若会话在 `cat-cafe-runtime`，先探活：`curl -sf http://localhost:3004/health`
  - 服务已在线时直接复用，禁止在该会话执行 `pnpm start` / `pnpm runtime:start` / `./scripts/start-dev.sh`
  - `localhost:3003/3004` 默认按 runtime 处理；如果你要验证未合入改动，不能把这两个端口的页面/接口响应当成当前分支的证据
  - 证明“这是我当前 worktree 的验证证据”时，必须同时说清：`worktree/cwd` + 目标 URL。两者对不上 = 证据无效
  - 确需重启时，先获operator明确授权，再用 `CAT_CAFE_RUNTIME_RESTART_OK=1` 执行
  - **Alpha 优先**：验证已合入 main 的改动时，优先用 `pnpm alpha:start`（3011/3012/4111/6398）取证，而非 runtime。Alpha 环境每次启动自动同步 origin/main

Step 4.5: DOGFOOD-YOUR-SLICE — 用一次自己刚做的功能（F209 教训 2026-05-23）🔴
  对 user-visible / runtime feature，author 必须在请求 review 前：
    ① 跑一条**真实端到端 query / 路径**，涵盖该 slice 的核心交付能力
    ② 把命令 + 输出 / 截图证据写进 Quality Gate Report 的 "Dogfood" 块
    ③ 抓到的任何 dogfood bug 必须当轮修，不允许"post-merge 再说"
    ④ **结构性例外**（2026-07-15）：验证路径只在合入后才存在（需 main/alpha 环境或真实外部案例，AC-F7 型）→ pre-merge 验证到能验的边界即可，剩余由**带 owner + 触发条件的持久 post-merge task** 接走，**不阻塞 pre-merge review / merge**；若它是 required AC，则 task 在 terminal PASS（或 `delete` / `cvo_signoff`）前仍阻塞 **feature close**。例外理由写进 review packet

  Scope（必做 vs 可豁免）：
    - **必做**：任何对最终用户 / 猫体感有变化的 feature 或 bugfix。包括但不限于：
      search / recall / UI / routing / drillDown / typed reader / 任何新 MCP tool / 任何新 REST 端点 /
      **任何修复用户或猫可感知路径的 bugfix（即使已有回归测试覆盖）**
      → 反例 PR #1854 dogfood hotfix：file-slice drillDown 路径口径不一致，已有回归测试也不够——
        必须 author 自己跑一遍 `search_evidence → drillDown → read_file_slice` 才能抓到
    - **可豁免**：docs-only / 纯重构 / 纯测试 / 内部基础设施 / **纯内部 bugfix（非 user/cat 可感知路径，如内部 DB 一致性、log format、纯算法常量调整等）**
      → 豁免必须**显式在 review packet 里写出理由**（"docs-only" / "纯重构 + 既有测试覆盖" / "纯内部 bugfix，不影响 user/cat 可感知路径"等），不能省略

  Why（F209 反思 2026-05-23）:
    "AC pass 但用户感受不到" + "dogfood bug post-merge 才暴露" 是同型走偏。
    - Phase B alias registry: AC-B1~B5 全 ✅、跨族 review APPROVE、merge 闭环 — 但生产 `entity_registry` 是空的，真实用户搜 `operator` 找不到 `operator`。
    - Phase C drillDown: 测试 / cloud review / merge 都过 — 但 author 自己 post-merge 用一次刚发现 file-slice 路径口径不一致。
    根因是没人 pre-review 真用一次自己刚做的东西。pre-merge dogfood 把这一类 bug 提前到 author 自检阶段。

  报告写法（在 Quality Gate Report 里加 "### Dogfood" 块）：
    ```markdown
    ### Dogfood-Your-Slice
    Scope verdict: ✅ 必做 / 🆗 可豁免（理由：xxx）

    （必做时）
    端到端路径: search_evidence("operator") → drillDown → cat_cafe_get_thread_context
    实际命令 / 输出（粘贴）: ...
    发现的 bug: 无 / 列表（含修复 commit SHA）
    ```

Step 5: PEN CHECK — 自动化设计稿对照（不可跳过！）
  ① glob designs/**/*.pen，匹配当前 feat 编号或关键词
  ② 若匹配到 .pen 文件 → 强制进入设计稿对照流程（见下方"有 .pen 设计稿的功能额外要求"）
  ③ 若无匹配 → 检查 feat 是否有前端 UI 改动（改了 packages/web/src/components/）
     → 有 UI 改动但无 .pen → 在报告中标注"⚠️ 无设计稿，跳过对照"
  ④ 此步骤不依赖猫猫"记得"——必须执行 glob 命令，用输出决定是否进入对照

Step 6: RUN — 运行风险匹配的验证命令（必须这次真实运行）
  ① 先列五轴风险与受影响面；命令逐条对应 claim，不按“写了代码”机械全跑
  ② 默认：受影响 package / schema / generator / docs checker + git diff --check
  ③ 新行为 / bug：相关行为或回归测试；现有精确检查红可以直接作 RED
  ④ 安全、鉴权、生产数据、迁移、外部契约、不可逆，或 targeted 无法覆盖跨包合流风险：pnpm gate
  ⑤ Redis 相关改动额外跑：pnpm --filter @cat-cafe/api test:redis（只连 6398）
  ⑥ 任一实际选择的检查红都先修；不得挑绿灯报告、隐去红灯

Step 7: READ — 完整读输出，看 exit code，数失败数

Step 7.5: ARTIFACT HYGIENE CHECK — 根目录媒体垃圾闸门
  - 执行（工作树）：
    `git status --short | rg '^.. [^/]+\.(png|jpe?g|webp|gif|webm|mp4|mov|wav|pdf|pen)$'`
  - 执行（已提交差异）：
    `git diff --name-only origin/main...HEAD | rg '^[^/]+\.(png|jpe?g|webp|gif|webm|mp4|mov|wav|pdf|pen)$'`
  - 任一命中 → BLOCK：说明仓库根目录出现了媒体/设计工件（含已跟踪和未跟踪）
  - 处理方式：移到 `${TMPDIR}/cat-cafe-evidence/...` 或显式归档到正式目录后再继续
  - 规则真相源：`cat-cafe-skills/refs/evidence-output-contract.md`

Step 8: REPORT — 输出合规报告 + 证据
```

**前端功能额外要求**：author 必须在正确 worktree / preview 上走关键交互，并记录 URL、操作与结果。截图、录屏、DOM assertion、Playwright 输出都是证据载体；只有视觉判断确实需要画面时才采截图 / 录屏，缺截图本身不阻塞，也不得让 operator 代采。执行细则：`cat-cafe-skills/refs/vision-evidence-workflow.md`。

**有 .pen 设计稿的功能额外要求** 🔴（Step 5 匹配到 .pen 时强制执行）：
1. 打开 .pen 文件 → `get_screenshot` 截取设计稿
2. Playwright/Chrome 打开实际页面 → 截取实现截图
3. 逐区域对比：布局、颜色、间距、交互状态
4. 不一致处必须标注并修复（或记录为"有意偏差 + 原因"）
5. 报告附 **设计稿截图 vs 实现截图** 对照表
6. 🔴 **此流程由 Step 5 自动触发，不依赖猫猫主动想起来**

> 教训（2026-03-11）：三只Ragdoll同时跳过了 .pen 对照，根因是没有自动化检查点。
> Step 5 的 glob 就是解决这个问题——用命令输出驱动，不靠记忆。

## Quick Reference

| Claim | 需要 | 不够用 |
|-------|------|--------|
| 测试通过 | 这次运行输出：0 failures | "上次跑过"、"应该通过" |
| targeted checks 通过 | 与改动面对应的本轮命令 + exit 0 | 只挑一盏绿灯、隐去相关红灯 |
| full gate 通过 | high 风险触发时本轮 `pnpm gate` exit 0 | 低风险为了报告完整机械全跑，或高风险只跑局部 |
| Bug 修了 | 原症状测试：通过 | 代码改了，以为修了 |
| 需求满足 | spec + Discussion 逐项打勾 | 测试通过就完事 |
| Feature 完成/未完成 | git log + PR 状态 + spec 逐项 | 只看 spec checkbox 就下结论 |

**合规报告模板**：

```markdown
## Quality Gate Report

Spec: feature spec or implementation note
原始需求: feature-discussions/YYYY-MM-DD-xxx/README.md
检查时间: YYYY-MM-DD HH:MM

### 愿景覆盖（Step 0）
| # | operator原始需求 | AC 覆盖？ | 实现？ |
|---|---------------|-----------|--------|
| 1 | "我要 XXX"    | AC#3      | ✅     |

### 功能验收
| # | 要求 | 状态 | 代码位置 | 测试覆盖 |
|---|------|------|----------|----------|
| 1 | XXX  | ✅   | file.ts:L10 | test.spec.ts |

### 设计稿对照（Step 5）
glob designs/**/*.pen 匹配结果: [列出匹配文件或"无匹配"]
对照状态: ✅ 已对照 / ⚠️ 无设计稿（有 UI 改动）/ ➖ 无 UI 改动

### Artifact Hygiene（Step 7.5）
仓库根目录媒体/设计工件（工作树 + 已提交差异）: 无 ✅

### Architecture Ownership（Step 2.7）
Architecture cell: dispatch
Map delta: none
Why: 只扩展现有 InvocationQueue 行为，不改变 dispatch cell 边界
Diff mismatch scan: 无新增并行 Store/Queue/Router/Adapter ✅

### Dogfood-Your-Slice（Step 4.5）
Scope verdict: ✅ 必做 / 🆗 可豁免（理由）
（必做时）端到端路径: search_evidence("...") → drillDown → reader(...)
实际命令 / 输出 / 截图: ...
发现的 bug: 无 / 列表（含修复 commit SHA）

### 五轴风险与验证命令（必须是这次真实运行）
风险: behavior=<...> data=<...> security=<...> contract=<...> irreversible=<...>
<targeted command 1> → exit 0 ✅（覆盖 claim: ...）
<targeted command 2> → exit 0 ✅（覆盖 claim: ...）
pnpm gate → exit 0 ✅（仅 high 风险实际触发时填写）
```

## Common Mistakes

| 错误 | 正确做法 |
|------|----------|
| 只检查 AC，没回读 Discussion | Step 0 先读原始需求，AC 可能不完整 |
| "上次跑测试是通过的" | 这次重新跑，看输出，再声明 |
| "应该没问题" / "probably works" | Run the command. Read the output. |
| 测试通过就声称 phase 完成 | 还要对照 spec 逐项检查 |
| 部分实现就提 review | P1/P2 遗漏必须当轮补完再提 review |
| 交付半成品让operator"先看看" | 交付完整 feat，步骤是内部节奏不是交付批次 |
| 产出后续要重写而非扩展 | 如果要重写，说明绕路了（Spike 除外） |
| author 没跑 frontend preview，把“缺截图”扔给 operator | author 走关键交互；按视觉风险选择截图 / 录屏 / DOM / 浏览器测试证据 |
| 有 .pen 设计稿但没对照实现 | Step 5 自动 glob 检测，匹配到就强制对照，不靠记忆 |
| 为了截图在 runtime 会话里重跑 `pnpm start` | 先探活复用现有 runtime；确需重启必须显式授权 |
| 拿 runtime 的 `3003/3004` 页面当成当前 worktree 的验证结果 | 报告里同时写明 `pwd/worktree` 和目标 URL；如果 URL 是 `3003/3004`，默认这是 runtime 证据，不是未合入改动证据 |
| 截图/录屏/设计稿顺手掉进仓库根目录 | Step 7.5 必查；先移到 `${TMPDIR}/cat-cafe-evidence/...` 或正式归档目录，再继续 |
| Redis 改动用默认测试命令 | 必须跑 `test:redis`，禁止直连 6399 |
| 产出了 skill/MCP 但没审查质量 | 加载 `writing-skills`，用 T0 六要素审查（软硬同检） |
| 只看 spec checkbox 就声称完成/未完成 | 核实 `git log --grep` + `gh pr list` + 实际 commit（LL-029）|
| AC 全 ✅ 就声明 phase close（机制 ship 但用户感受不到）| Step 4.5 Dogfood-Your-Slice：必做 feature 跑一条真实端到端 query 写进报告；豁免必须显式写理由（F209 反思 2026-05-23）|

**Red flags — 立刻 STOP**：
- 用 "should"、"probably"、"seems to"
- 表达满足感（"好了！"、"完成！"）时还没运行命令
- 信任 subagent 的 "success" 报告而没独立验证

## 和其他 skill 的区别

| Skill | 关注点 | 时机 |
|-------|--------|------|
| **quality-gate（本 skill）** | spec 对照 + 风险匹配证据 | 作完成声明之前 |
| `merge-gate` | reviewer 是否放行、P1/P2 是否全修 | 合入 main 之前 |
| `receive-review` | 如何处理 reviewer 的反馈 | 收到 review 之后 |

一句话：quality-gate 是"你自己检查自己"，merge-gate 是"reviewer 放行你"，receive-review 是"你处理 reviewer 的意见"。

## 下一步

Quality Gate 通过后，把证据交给风险路由已选择的独立验证源：治理 / stateful 语义通常走 `request-review`；安全 / 契约的 context-blind 扫描可走 cloud；`fresh-context-review` 仅在 author 判断认知盲点收益足够时作为 finding generator，不是固定前置。

Gate 未通过时：
- **P1 遗漏** → 补完再过 gate
- **P2 遗漏** → 必须当轮补完再提 review
- **已选择的 targeted / full 检查失败** → 修到绿灯再交付
