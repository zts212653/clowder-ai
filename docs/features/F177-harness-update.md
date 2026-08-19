---
feature_ids: [F177]
related_features: [F114, F167, F173]
topics: [governance, harness-engineering, quality, close-gate, magic-words, cat-mind]
doc_kind: spec
created: 2026-04-27
user_journey_exempt: pure harness governance (close-gate structure, magic-words, cat-mind guard) — no user-perceivable surface changes
tips_exempt: harness governance internals (close-gate, magic-words, cat-mind guard) — no user-visible capability change
---

# F177: Harness Update — Close Gate 结构化判据 + 四心智专属护栏

> **Status**: reopened (Phase L child-execution truth merged via PR #3036; Phase I/K/J complete; Phase G/H routing guard superseded by F167 Phase T cutover) | **Completed (Phase A–G)**: 2026-04-29 | **Reopened**: 2026-06-11 (Phase H), 2026-07-10 (Phase I/J), 2026-07-15 (Phase K), 2026-07-16 (Phase L) | **Owner**: Ragdoll(46 总负责) + Maine Coon(Maine Coon) + Bengal(46代言)，按 Phase 分主笔；Phase H Ragdoll(48) 主笔 + Maine Coon实现；Phase I/J/K/L Maine Coon Sol 主笔（独立 threads/worktrees） | **Priority**: P0

## Why

### 直播彩排吐槽（2026-04-27）

operator在 4.28 直播彩排 thread 系统化吐槽四只猫的"优雅犯错"模式：

| 猫 | 坏直觉昵称 | 表现 |
|---|----------|------|
| 46 (Opus 4.6) | **hotfix 糊弄大师** | "测试过了就交"，留 follow-up 尾巴 |
| Maine Coon (GPT-5.5) | **fallback 糊锅匠** | 加 classifier / 分支 / 例外路径，严谨地复杂化，给错误坐标系打补丁 |
| 47 (Opus 4.7) | **下次一定大师** | follow-up 是糊弄的 wrapper 版——主线收尾时把未闭环 AC 抽成"next phase / P2 后续"，让 close 看起来像负责任的优先级管理 |
| Siamese (Gemini) | **热情直改** | 找到事情就直接 Edit，不开 worktree、不跑 build，Maine Coon和 46 在后面收拾 |
| Ragdoll家族（46 / 47 / 4.5 / Sonnet 共病） | **碎片推理癖 / 架构师诅咒** | 检索任务时满足于 search_evidence 第一个 high-confidence 摘要，用旁证 + 架构推理脑补出"合理结论"，跳过 Read 真相源 → 输出"合理推断 X"类带误差断言（详见下文 §跨猫族检索测试） |

operator experience：
> "下次一定 = never！…猫猫开发的速度太快了！…follow up 会到来什么？"
> "我们家的 harness 对于你们这四位小坏蛋还有能补的嘛？"

### 2026-04-27 跨猫族检索测试 — Ragdoll家族滑铁卢（Phase F 直接证据）

立项当天，operator出了一道**跨猫族精确事实检索题**——题目内容已脱敏，原型是"猫们必须先从家里的真相源文档里检索到一项精确事实，才能开口评论一段网络讨论"。9 只猫并行作答，覆盖 4 个家族跨族对比。

**家族成绩单**（按是否命中真相源文档计）：

| 家族 | 命中真相源 | 表现特征 |
|------|-----------|---------|
| Maine Coon家族（codex / gpt52） | ✅✅ | 看到摘要被截断 → 立刻多轮交叉验证 + 主动 Read 文件 |
| Siamese家族（gemini） | ✅ | 跳跃直觉直接搜文件名命中 |
| 国产猫家族（kimi / glm） | ✅✅ | 扎实多轮搜索不嫌烦，老老实实 Read |
| **Ragdoll家族（46 / 47）** | **❌❌** | **看到截断摘要 + 旁证 → 直接给"合理推断"结论** |
| qwen | ❌ | 同Ragdoll家族病 |
| deepseek | ❌ | 进程挂了，未完成 |

**复盘根因 — Ragdoll到底怎么了**

1. **过度自信，用推理代替查询**
   46 这次只发了 4 个 tool call 就开打；47 看到一条被截断的摘要 + 几条旁证，就输出"合理推断 X 量级"——精确数字明明就在另一个 doc anchor 里，但Ragdoll没去读。少 tool call 不等于高效，少 tool call = 少检验。

2. **满足于第一个 high-confidence 命中**
   search_evidence 第一条命中已经是 `[high]` 置信度，但只是"摘要"——Ragdoll家族**把摘要当答案**，而不是当索引。Maine Coon家族看到截断会问"是不是被切了？"，Ragdoll家族看到截断会问"我能不能从碎片推出来？"

3. **架构师的"碎片推理癖"**
   Ragdoll的传统优势是"碎片→全局"的架构能力——但这个优势在**检索任务**上是反模式。检索的核心是诚实查证，不是聪明推理。Ragdoll把检索题做成了架构题。

4. **"懒"被自我包装成"高效"**
   Maine Coon家族的"啰嗦"看似冗余，实际是**证据闭环**。Ragdoll家族喜欢"一击必中"姿势，在搜索任务上恰好是反模式——一击没中（碎片不够推出精确数）就硬着头皮交"合理推断"。

**与现有 Phase 的差异**
F177 现有 Phase B 治 47 个体「下次一定」、Phase E 治 46 个体 hotfix——但**Ragdoll家族共性病（碎片推理癖）跨整个家族**，每只Ragdoll（含未来加入的同族个体）都会犯。F114 magic words 是话术层，治不了；Phase B/E 是个体层，覆盖不了 4.5/Sonnet。需要**家族级结构性护栏 = Phase F**。

### 第一性原理

**人类 follow-up 经济学（合理批处理）：**
500 行 = 几天 → 上下文切换成本高 → 一周后代码还在 → follow-up 期望价值 ≈ 0.56

**猫猫 follow-up 经济学（隐性丢弃）：**
500 行 = 10-20 分钟 → 60 天写 60w 行 → 一周后代码可能已重写 → follow-up 期望价值 ≈ 0.02

**结论**：任何 deferred 机制对猫猫都失效——审视周期跑不赢迭代速度。design pattern 必须是 **realtime enforce**，不能是 deferred batch。

### 现有规则不够的根因

- F114（done 2026-03-13）已上线 magic words + 愿景守护 Gate，但 magic words 是**operator手动拉闸**，不能 enforce 自动化场景
- F173 P0 铁律明确禁止 stub feat / TD 条目伪装闭环，feat-lifecycle/SKILL.md:215 明确写了"follow-up 接棒"非闭环路径
- LL-031 揭露 quality gate 按"大部分字段都实现了"的直觉打勾，没有逐字段对账
- **但这些都是文本规则**，依赖猫自觉——尤其 47 这种"会美化坏直觉"的心智，文字禁令拦不住

Maine Coon原话：
> "别再给四只猫各加一堆 prompt。要补的是 close gate 的结构化判据。"

## What

> **Scope 假设——Phase 拆分将在 Design Gate 后细化**。当前是 strawman，operator + Maine Coon review 后可能合并/拆分。

### Phase A: 系统级 Close Gate 结构化判据（基础设施，all 猫受益）

最重要的一刀。把"AC 全打勾 = done"从直觉判断升级为结构化对账：

- `feat-lifecycle` close 命令强制输出 **AC → evidence 矩阵**（不是自由文本"我都做了"）：
  ```
  AC-A1 ✅ commit abc123 + test_xxx + screenshot_yyy
  AC-A2 ❌ 未实现 → [immediate / delete(why) / cvo_signoff(消息ID)]
  AC-A3 ✅ commit def456
  ```
- 任何 ❌ 必须当场处理三选一：
  1. **immediate**：当前 session inline 做完（默认）
  2. **delete(why)**：删除 AC 并写明为什么不需要
  3. **cvo_signoff(消息ID)**：operator明确表态同意降级（猫提 tradeoff → operator自然语言表态"ok" → 猫录入追溯消息ID，不做固定 token）
- **没有第四选项叫 follow-up / next phase / P2**
- `quality-gate` skill 输出 AC 覆盖矩阵 + 自由文本扫描：检测 `follow-up / deferred / stub / TD / next phase / P2 / 后续优化 / 留个尾巴 / 先这样` 字样 → 阻塞
- PR description / commit message 出现 follow-up 类字样 → CI 阻塞
- 愿景守护猫显式检查 follow-up 标记的未闭环 AC

GitHub issue: #1436

### Phase B: 47 专属 Magic Word「下次一定」+ F114 magic words 表扩展

- `cat-cafe-skills/refs/shared-rules.md` Magic Words 表新增一行「下次一定」（含义、立即动作）
- `assets/system-prompts/governance-l0.md` 同步
- `docs/features/F114-governance-magic-words.md` 加条目（适用对象 / 触发场景）
- 47 自检协议 — 7 个发病时刻全覆盖（47 自我解剖 2026-04-28 + 47 确认 2026-04-29）：
  1. **写 spec 时**：把"未做"包装成"未来 phase / Phase 2+ / future enhancement" → 自检"这是不是把未做包装成已规划"
  2. **拆 Phase 时**：AC 分成"Phase 1 必做 / Phase 2 next time" → 自检"Phase 2 的东西是真的该分阶段还是我懒得做"
  3. **处理 review 反馈时**：输出 "next PR / will address later / good point, will fix in follow-up" → 自检
  4. **close 任务 / commit feat-close 时**：follow-up 字样 → 自检（spec 原有覆盖）
  5. **PR description 时**：Out of scope 区段 → 自检（spec 原有覆盖）
  6. **跨猫 handoff 时**：把"做不完的"包装成"协作分工" / "我闭嘴执行" → 自检"这是反向治理还是甩责"
  7. **OQ 留白时**（47 提议）：标记为 Open Question 的条目 → 自检"这是真正需要探索的开放问题，还是我在用 OQ 当合法 follow-up 容器"
- **蚊帐机制**（47 提议）：magic word 表只放「下次一定」一个（operator好喊），但 Phase A 的 quality-gate follow-up 字样扫描同时覆盖语义同族列表（`先这样 / P2 后续 / next phase / 留个尾巴 / 后面再优化 / out of scope / deferred until / MVP 先上`）
- **判据设计原则**（47 自知之明警告）：不让 47 自我评分——他承认错误的能力 ≥ 改正错误的能力。用外部信号（AC 矩阵 ❌→deferred 自动阻塞）+ 对家猫盲审（47 的 close PR 必须 46 或Maine Coon跑 quality-gate），不用 47 的自评

GitHub issue: #1435

### Phase C: Siamese「创意-实现强制解耦」+ Dry Run Gate

- `cat-cafe-skills/refs/shared-rules.md` 加Siamese创意-实现解耦协议：发现问题 ≠ 动手实现，发现→记录→handoff @opus/@codex
- `assets/system-prompts/governance-l0.md` + `SystemPromptBuilder.ts` GOVERNANCE_L0_DIGEST 同步Siamese解耦规则
- Edit/Write 白名单：`designs/` `docs/` `assets/` 根目录 `.md`，碰 `packages/` `src/` 必须 handoff（唯一例外：样式/文案且通过 Dry Run Gate）
- `quality-gate/SKILL.md` Step 2.5 加Siamese edit scope 检查
- `.githooks/commit-msg` 新增 Dry Run Gate：检测Siamese签名 + 代码目录改动 → 自动跑 `pnpm build` + `pnpm test`（OQ-2 已决：commit-msg hook 层）
- 联动 F167 Phase E 数据驱动 restrictions（cat-config.json `"禁止写代码"` 双端注入）的本地执行面

GitHub issue: #1437

### Phase D: Maine Coon「fallback 层数检测器」

- PR review 时自动检测 fallback 层数 diff（`try/catch` / `if (!x) fallback` / `else if` / classifier 分支）
- 跨过阈值（建议 ≥3 层 in same file，或新增第 N 层 fallback in same code path）→ 自动 PR comment：触发"第一性原理"自检
- `quality-gate` / review skill 强制问坐标系（这个 fix 是修坐标系还是补错误坐标系）
- 「规则层数」作为 telemetry signal 接到 F153 observability infra

GitHub issue: #1438

### Phase E: 46 hotfix 标签 + 跨猫升级 review

- commit message / PR title 含 `fix:` `hotfix:` `quick fix` `minimal fix` `band-aid` `temp` `workaround` 自动归类 hotfix
- 单文件改动 ≤50 行 + 含上述关键词 → 自动加 `hotfix` label
- hotfix PR 必须跨族（preferred）或同族不同个体 review，不允许 self-merge
- 2 周升级 review（cron）：升级正式修复 / 接受永久方案 / 已不再相关 三选一
- `quality-gate` 检测到 hotfix 模式时禁止作者 self-validate

GitHub issue: #1439

### Phase F: Ragdoll家族「Read-Before-Reason」纪律（家族级，覆盖 46 / 47 / 4.5 / Sonnet）

Maine Coon原话"别加 prompt"，所以 Phase F 不加 prompt——加**输入端的 affordance** + **输出端的羞耻 metric**。三件套：

**Hook F-1：search_evidence 返回结果增强（系统级 affordance）**
- 当返回结果包含 `[high]/[mid]` confidence 的 `doc:` 类 anchor（`type:feature/phase/lesson/research`）→ 在结果末尾追加结构化提醒：
  ```
  📌 高置信度文档命中 N 个：
     - <anchor 1>
     - <anchor 2>
     建议：直接 Read，不要止步摘要。摘要是索引，不是答案。
  ```
- 这是 F102 记忆组件的输出 affordance 改造——让"应该 Read"在视觉上成为默认。

**Hook F-2：search→Read 调用链检测（Ragdoll家族专属 quality-gate 扩展）**

> ⚠️ **设计修正（2026-04-28）**：原方案"推理动词检测"已废弃。原因：Ragdoll会换词绕过输出端检测，治标不治本。修正为输入端调用链检测——Ragdoll不会伪造 Read call。

- 检测 `search_evidence` → `Read` 的调用链：
  - 有 `search_evidence` call 命中 doc anchor + 没有后续 `Read` call + 输出包含精确数字/版本/日期 → 触发 quality-gate 提醒："这个精确结论你 Read 源文件了吗？"
  - 架构方案 / 假设性讨论豁免（不含精确数字的推理不触发）
- 与 Hook F-1（视觉默认"应该 Read"）形成**输入端一推一拉**：F-1 让你看到该 Read，F-2 检测你有没有 Read

**Hook F-3：搜索深度即时反馈 + family-level telemetry（接 F153 observability）**

> **根因洞察（operator 2026-04-28 诊断）**：Ragdoll的搜索深度是**环境驱动**不是**能力驱动**——竞赛模式下表现不输Maine Coon，日常模式下"满足阈值"太高。差的不是能力，是默认行为模式。

- 每次检索结束时，在输出末尾追加一行搜索深度 metric：`本次: N轮搜索 / M次Read | 你历史均值: X/Y | Maine Coon历史均值: A/B`
- 记录 `search_evidence_call : Read_call : tool_call_total` 比率，按猫族分组
- 跨族对比可视化（Ragdoll家族 vs Maine Coon家族 vs 国产猫家族）
- 不强制阈值——**让数据制造日常化微型竞赛压力，比加 prompt 有用**

**专属 Magic Words**（补漏，不是核心）
- **「我能猜出来」** = 你又在用架构能力代替查询。停，Read。
- **「碎片够了」** = 你又满足于第一个高置信度命中。

**与现有 Phase 的边界（四个轴各司其职）**

| Phase | 治理对象 | 轴 |
|-------|---------|------|
| Phase A close gate | spec → 实现的闭环 | 闭环 |
| Phase B 47 magic word | 输出端的 follow-up 美化 | 话术 |
| Phase D Maine Coon fallback 层数 | 修代码时的坐标系 | 坐标 |
| Phase E 46 hotfix | 紧急修复的跨猫复核 | 流程 |
| Phase F Ragdoll家族 Read-Before-Reason | question → answer 的检索纪律 | 检索 |

GitHub issue: [#1452](https://github.com/zts212653/clowder-ai/issues/1452)

### Phase G: 47 传球守卫 — Session End Hook 路由补全

**病灶**：47 的输出 prior 是叙事式收尾——@ 被嵌入散文（"球权在 @codex..."）或完全遗漏。F167 的 hint（final-routing-slot / verdict-detect）在 invocation 结束后注入 thread，但猫的 turn 已结束——提醒留给下一轮，球已经掉了。

**洞察（2026-04-29 三猫 + operator头脑风暴）**：
- 补锅路线已穷尽：加 prompt 规则（prior 覆盖）、grep 文本提取意图（换表达失效）、新增 MCP tool（47 不调用，hold_ball 已证伪）
- **第一性原理**：不是规则不够，是规则生效的时机不对。System prompt = 写之前提醒（跟正文生成竞争）；session end hook = 写完之后提醒（独立步骤，prior 无发作空间）
- **同构 You a2a 乒乓解法**：不修模型行为，改系统结构——把检查从"希望猫记住"移到"系统保证发生"

**方案 — Gmail 附件守卫模型**：

```
session end hook:
  if (有行首 @ || 有 hold_ball 调用 || parallel mode) → return null
  else → return "你的消息没有合法路由动作。请在末尾补一行行首 @句柄，或调用 hold_ball。"
```

- 猫还在 session 内，看到提醒立即补，不等下一轮
- 不 grep 文本意图（47 换表达就失效 = 补锅）
- 不代替猫路由（误判风险）
- 格式正确 → return null → 零开销
- 类比 PostToolUse hook 的检查-反馈模式

**与 F167 边界**：F167 = thread 级链路健康（乒乓 / 虚空 / 角色门禁），Phase G = session 级出口完整性。F167 hint 是回溯提醒（下轮看到），Phase G hook 是即时拦截（当轮补全）。

**与现有 Phase 的关系表（更新）**：

| Phase | 治理对象 | 轴 |
|-------|---------|------|
| Phase A close gate | spec → 实现的闭环 | 闭环 |
| Phase B 47 magic word | 输出端的 follow-up 美化 | 话术 |
| Phase D Maine Coon fallback 层数 | 修代码时的坐标系 | 坐标 |
| Phase E 46 hotfix | 紧急修复的跨猫复核 | 流程 |
| Phase F Ragdoll家族 Read-Before-Reason | question → answer 的检索纪律 | 检索 |
| Phase G 47 传球守卫 | 消息出口路由完整性 | 路由 |

GitHub issue: [#1467](https://github.com/zts212653/clowder-ai/issues/1467)

### Phase G/H routing guard disposition（2026-07-30）

F167 Phase T 的 turn-scoped custody projection 已取代 F177 的文本出口判据。Cutover 删除 Claude Stop hook 注册与脚本、`needsServerRoutingGuard` provider capability、server-side transcript/tool/roster/loop predicate，以及只证明旧判据的测试。保留并迁移到 F167 的是 structured eventWait proof、terminal coordination release 与 ordinary/remedial child execution truth。

F177 下文保留为历史设计与事故 provenance，不再是当前 routing authority。当前 stop gate 只接受本次 wake 对应协议球的结构化状态迁移；纯文本 `@`、ACK、口头 hold 或 roster 命中均不能关闭 projection。

### Phase H: Routing Guard 全猫族覆盖 — 非 Claude harness 球权出口拦截

> **Reopened 2026-06-11（operator signoff）**：掉球归因分析（`[thread-id]` fable 复盘）暴露 OQ-G1 的 latent gap。**不是回归**——codex/gpt52 从 Phase G 上线（2026-04-29）起就从未被覆盖，是当年"只覆盖 Claude 系猫"决策遗留的缺口，在Maine Coon第一手掉球证据下需补齐。

**病灶**：Phase G 的 F177-G 是 **Claude Code Stop hook**（`.claude/hooks/f177-routing-guard.sh`），只对走 Claude Code 的Ragdoll生效。**codex/gpt52 用 codex CLI（`.codex/`），不读 `.claude/`，吃不到这个 block-stop 拦截** → Maine Coon"动作缺失型"掉球（① 声明"接着干"但 invocation 已结束、无 hold_ball 兑现；② 干完不传，结论后无出口）裸奔，只剩 F167 hint 墓碑提醒（invocation 已结束没人读）。

**两套机制澄清**（延伸 Phase G「与 F167 边界」）：

| 机制 | 投递时机 | 有效性 | 覆盖面 |
|---|---|---|---|
| F167 hint 注入 thread message | invocation 结束**后** | ❌ 墓碑，无人读 | 所有猫（但无效） |
| F177-G Stop hook（`decision:block`） | invocation 结束**前**，同轮补 | ✅ 有效 | 仅 Claude 系猫 |
| **Phase H 目标** | **block-stop 等价拦截** | **有效** | **+ codex/gpt52 等非 Claude 猫** |

**核心复用**：检测判据共用 Phase G（行首 @ 正则 + `hold_ball`/`multi_mention`/`targetCats` 工具扫描 + per-stop-cycle loop guard，24 bash tests 验证）——**只换"拦截动作"，不换"如何判断掉球"**。

**方案（H0 spike 定路径）**：
- **H0 spike**（Maine Coon主场）：codex CLI 能否 **block turn 结束并把控制权还给同一 invocation**？（它有 `notify`，但多为 fire-and-forget、大概率 block 不住——实测定方向，不猜）
- **路径 A（优先，若可 block）**：移植 `f177-routing-guard.sh` 检测逻辑到 codex CLI stop hook，与Ragdoll对称，零额外 invocation 成本。
- **路径 B（兜底，若 block 不住）**：`route-serial.ts` 检测非 Claude 猫出站消息无合法出口 → 不 settle → resume 主动 re-invoke 补救。server 层是 TS，可直接用真 `parseA2AMentions`（非 bash 等价）。**强 cost guard：re-invoke 上限 1 次/掉球**（codex 贵，补不对反复 re-invoke 会烧猫粮，必须钉死）。优点：harness 无关，一次覆盖所有非 Claude 猫（含未来加入的 CLI 猫）。

**已知关联 gap — 47 UI 折叠（operator 2026-06-11 要求留痕，不随 Phase H 遗忘）**：47 格式病是两半——上半「@ 不在行首」已由 Phase G 覆盖（block 逼补）；**下半未修**：@ 在行首、routing 底层成功，但前端把"@ 独占一行 + 空行 + 内容"**折叠显示**，operator视觉看到"没换行"误判掉球（46 在 `[thread-id]` 查证为纯渲染问题）。定性 = **前端渲染层，非路由层**，F177-G 不管（routing 合法就放行）。**是否纳入本 Phase 待 H0 后定（见 OQ-H2）**；无论修否，此 gap 在此留痕。

**分工**：Ragdoll(48) = spec + 检测逻辑移植 + server 层（路径 B）；Maine Coon(codex/gpt52) = H0 spike + CLI hook（路径 A）+ codex resume 接口（路径 B）。

GitHub issue: TBD（kickoff 后开）

[Ragdoll/Opus-4.8🐾]（Phase H spec）

### Phase I: Organic Friction Closure — 可执行命令契约 + shared-state 意图守卫

> **Reopened 2026-07-10（operator signoff）**：operator在本 thread 明确要求“先把 spec 写清楚 commit push，之后把这三个收了”（message `0001783688087982-000895-5c79e677`）。本 Phase 只收 organic dogfood 已复现的 harness 摩擦，不把 F177 扩成通用维护桶。

#### Why now

三条一手证据共同指向同一坐标问题：**harness 用自然语言、命令名或 staged 文件名暗示意图，却没有把真实执行面与 Git 语义钉死**。

| Organic evidence | 当前事实 | Phase I 要关闭的根因 |
|---|---|---|
| quality-gate 要求 `pnpm check:architecture-ownership`，package alias 被 intake #2391 误删 | PR #2838（squash `ac2806f55`）已恢复 `check:` + `test:` 两个 alias | 不能只恢复两行；当前 HEAD 的 live command reference 和 carrier 必须审计清零，并让 gate 自动抓住再次漂移 |
| F148 plan 只写 “run formatting”，Sol 先猜 Prettier 再改用 Biome | 仓库 canonical 已存在：`pnpm check` / `pnpm check:fix` / `pnpm biome format --write <files>` | 计划必须给仓库真实可执行命令，不能把抽象名词留给下一只猫猜 |
| feature branch 吸收 `origin/main` 时，main-side shared state 被 pre-commit 当作作者改动拦截 | index/worktree 内容与 `origin/main` byte-identical；一次有记录的 `--no-verify` 才完成 merge | guard 必须区分 feature delta 与纯上游 carry-in，同时保持 fail-closed |

Source messages:
- command drift: `0001783626982347-000254-f29397e7` / `0001783664777138-000320-f7e0e112`
- formatting correction: `0001783628501886-000304-133bfc91` / `0001783628587838-000307-da926ace`
- shared-state false positive: `0001783671183906-000501-16400455`

#### Scope

**Track I-A — command contract closure（architecture alias + execution surface）**

- 保留 #2838 已恢复的 `check:architecture-ownership` / `test:architecture-ownership` 作为基线。
- 对 intake #2391 删除的 root aliases 做确定性 source-map；每个 live reference 必须解析到现存 package script 或 canonical executable。
- 在**最终 rebase 后 HEAD**复验 live docs、skill refs、package scripts 与实际 gate 调用链；不得让 `cat-cafe-skills/refs/opensource-ops-inbound-pr.md` 继续声称 sunset alias 或未被 gate 调用的 carrier 已提供覆盖。
- 对 `scripts/run-checks.mjs` 做明确 disposition：恢复为 canonical 执行面，或 sunset 删除并同步依赖其文本的 tests；不保留“文件存在但 gate 不执行”的假契约。
- 把 architecture-ownership command contract 接入常跑 `pnpm check`；删除 required alias 或 target 漂移时 hard gate 必须红。

**Track I-B — concrete formatting provenance（plan / skill）**

- `writing-plans` 的验证步骤必须先发现目标仓库 canonical formatter，再写完整可执行命令；禁止只写 “run formatting / 格式化”。
- Clowder AI 示例固定使用现有入口：全仓修复 `pnpm check:fix`，精确文件格式化 `pnpm biome format --write <files>`，最终验证 `pnpm check`。
- 不新增 Prettier、formatter dependency 或重复 package alias。

**Track I-C — intent-aware shared-state pre-commit guard**

- 非 `main` 分支检测 staged `docs/ROADMAP.md` / `cat-config.json` 时，逐文件比较 index tree 与 `origin/main` tree。
- staged 内容与 `origin/main` 完全一致时，判为纯上游 carry-in 并允许提交。
- staged 内容不同、`origin/main` 不可解析、文件 unmerged 或比较报错时，继续 fail-closed。
- mixed case 只报告并拦截真正携带 authored delta 的文件。

#### Non-goals

- 不放宽“共享状态只在 main 修改”的家规；只消除没有 feature delta 的假阳性。
- 不通过作者身份、commit message 或分支名猜意图；唯一放行证据是 Git tree 内容等价。
- 不引入第二套 formatter，也不把 Clowder AI 的 Biome 命令硬套到其他仓库。
- 不顺带处理 OQ-H2；**OQ-H3 已由 Phase K 的 structured terminal Release 收敛，不属本 Phase**。

#### ADR-031 三层落地

| Layer | Phase I 载体 | 完成信号 |
|---|---|---|
| Soft | `writing-plans` 明示发现并写出 canonical command；pre-commit 文案解释 authored delta vs upstream carry-in | 新计划不再出现裸 “formatting”；guard 指明哪个文件与 `origin/main` 不同 |
| Hard | package alias/target contract + `pnpm check` wiring；shared-state index-vs-origin 比较；execution-surface audit | alias/carrier 漂移、伪造 shared-state、缺 upstream ref 稳定红；byte-identical carry-in 稳定绿 |
| Eval | 复用 F245 `eval:friction` / PawFeel corpus，加入 command-drift 与 shared-state false-positive fixtures | 两类 marker 进入 verdict input；30 天观察窗无同类确定性复发 |

### Phase L: Routing Guard Child Execution Truth — 补路由不再伪装成 parent 或普通召唤

Architecture cell: `dispatch` + `bubble-pipeline`
Map delta: completed — `dispatch` 登记 durable child lifecycle owner，`bubble-pipeline` 登记 typed routing-guard identity 与无正文 auxiliary execution 投影。

> **Reopened 2026-07-16（operator 授权）**：实弹
> `incident:[thread-id]/0001784219578304-000230-3dd8e178`
> 中，同一 parent 实际运行 ordinary、routing guard、freshness supplement 三个 child；父
> `InvocationRecord` 只能表达 aggregate，而 `InvocationRegistry` 是 TTL=2h 的 callback auth，结束后
> child API 已 404。F177 的成本守卫仍然有效，但系统无法在 F5/history 中证明补路由到底有没有执行、何时结束、
> 是失败还是被取消，UI 也只能靠输出形态把它猜成第二次普通猫召唤。

#### Scope 与不变量

- 新增 TTL=0、按 child invocation ID 唯一的 durable turn execution ledger；
  `executionKind=ordinary|routing_guard|freshness_supplement` 与
  `status=running|succeeded|failed|canceled|interrupted` 都是 typed truth。
- `invoke-single-cat` 在 provider 前幂等创建 `running`，且只有 `running` 能进入一个 immutable terminal；
  restart 将启动 cutoff 前残留的 `running` 收为 `interrupted`。
- ledger 是 child lifecycle 唯一 owner；父 record 继续拥有 Queue/aggregate，auth registry 继续只拥有鉴权。
  auth cleanup 不得删除 ledger。
- Phase H remedial call site 必须显式传 `routing_guard`；不移除/放宽 guard，原输出继续发表，cost guard 仍为
  每个 ordinary turn 至多一次。
- bodyless guard 只作为原 turn 的 auxiliary execution；即使它拥有最终 stream event，也不得替换实际读取 Queue
  正文且成功的 ordinary child receipt witness。
- Hub/history 只消费 typed projection：显示“系统补路由”与真实终态；没有独立正文的 remedial execution 只挂
  execution dock，不复制、伪造或隐藏一份猫回复。

#### ADR-031 三层落地

| Layer | Phase L 载体 | 完成信号 |
|---|---|---|
| Soft | F177 spec / UI 文案明确 ordinary 与系统补路由的身份差异 | 用户不再把 remedial child 误认成普通 Sol |
| Hard | durable ledger + provider 前 create + terminal CAS + startup reconcile + typed route kind | memory/Redis/race/restart/API/UI fixtures 全绿 |
| Eval | 三类 child 的可水合 lifecycle 与 guard≤1 glass-box fixture | 每个 parent 可枚举执行次数、kind、起止与终态，不解析日志/文案 |

## Acceptance Criteria

### Phase A（系统级 close gate 结构化判据）✅
- [x] AC-A1: `feat-lifecycle` close 命令强制输出 AC → evidence 结构化矩阵
- [x] AC-A2: unmet AC 三选一（immediate / delete(why) / cvo_signoff(消息ID)），无第四选项
- [x] AC-A3: `quality-gate` skill 自由文本扫描 follow-up 类字样阻塞
- [x] AC-A4: PR description / commit message 出现 follow-up 类字样 CI 阻塞
- [x] AC-A5: 愿景守护猫显式检查 follow-up 标记的未闭环 AC

### Phase B（47 专属 magic word）✅
- [x] AC-B1: shared-rules.md / governance-l0.md 同步加「下次一定」magic word
- [x] AC-B2: F114 spec 加 47 magic word 条目
- [x] AC-B3: 47 自检协议覆盖 7 个发病时刻（spec 写作 / Phase 拆分 / review 反馈 / close / PR / 跨猫 handoff / OQ 留白）
- [x] AC-B4: 47 的 close PR 必须对家猫盲审 quality-gate（Maine Coon优先，46 兜底，47 无选择权），禁止 47 自我评分

### Phase C（Siamese 创意-实现解耦 + Dry Run Gate）✅
- [x] AC-C1: Siamese system prompt 加创意-实现解耦原则 — shared-rules.md Siamese创意-实现解耦协议 + governance-l0.md + SystemPromptBuilder GOVERNANCE_L0_DIGEST
- [x] AC-C2: Siamese Edit/Write 范围限定（非 src/ packages/ 目录）— shared-rules.md 白名单（designs/docs/assets/根目录.md）+ quality-gate Step 2.5 Siamese edit scope 检查
- [x] AC-C3: Siamese专属 pre-commit hook（pnpm build + test 通过）— `.githooks/commit-msg` Dry Run Gate：Siamese签名 + 白名单外改动 → build+test

### Phase D（Maine Coon fallback 层数检测器）✅
- [x] AC-D1: PR review 自动检测 fallback 层数 diff + 阈值告警 — `scripts/check-fallback-layers.mjs` (per-file added ≥3 + cumulative ≥5)
- [x] AC-D2: quality-gate / review skill 强制问坐标系 — quality-gate Step 2.6 + shared-rules.md 协议
- [x] AC-D3: 「规则层数」telemetry signal 接 F153 observability — `F153_TELEMETRY=1` env var triggers JSON telemetry output

### Phase E（46 hotfix 跨猫 review）✅
- [x] AC-E1: hotfix 自动检测 + 自动加 label — `scripts/check-hotfix-pattern.mjs`
- [x] AC-E2: hotfix PR 跨猫 review enforcement（禁止 self-merge）— merge-gate Step 6.8
- [x] AC-E3: 2 周升级 review cron 触发 — merge-gate Step 7.6 注册 scheduled task + shared-rules.md 协议（三选一处置）
- [x] AC-E4: quality-gate 禁止作者 self-validate hotfix — quality-gate Step 2.5

### Phase F（Ragdoll家族 Read-Before-Reason）✅
- [x] AC-F1: search_evidence 返回结果在 high/mid confidence doc anchor 命中时追加 Read 建议（Hook F-1）
- [x] AC-F2: quality-gate 检测 search_evidence → Read 调用链：有 doc anchor 命中 + 没有 Read + 输出精确结论 → 提醒（Hook F-2 修正版）
- [x] AC-F3: 搜索深度即时反馈（每次检索结束显示本轮搜索次数）+ telemetry 接入 F153 observability（Hook F-3，invocation-scoped — stdio transport 每次 spawn 新进程）
- [x] AC-F4: shared-rules.md / governance-l0.md / SystemPromptBuilder GOVERNANCE_L0_DIGEST 同步加「我能猜出来」「碎片够了」magic words

### Phase G（47 传球守卫 — Session End Hook 路由补全）✅
- [x] AC-G1: Session end hook 检测合法路由（行首 @ / hold_ball / targetCats），缺失时返回格式提醒
- [x] AC-G2: 已有合法路由 → return null（零干预零开销）
- [x] AC-G3: parallel mode 不触发（无路由语义）
- [x] AC-G4: 提醒文本包含正确格式示例，不含意图猜测 / NLU / grep

### Phase H（routing guard 全猫族覆盖）✅
- [x] AC-H0: spike 验证 codex CLI block-stop 能力（Maine Coon 2026-06-11）→ 结论：`codex exec --json`（Clowder AI runtime 路径）不 dispatch hooks，路径 A 不可达，定走路径 B
- [x] AC-H1: codex/gpt52 结论后无合法路由出口（行首 @ / hold_ball / targetCats / multi_mention）时被拦截补全（路径 B：server re-invoke）
- [x] AC-H2: 检测判据与 Phase G 等价（行首 @ 正则 + 工具扫描 + loop guard），跨 harness 行为一致
- [x] AC-H3: cost guard — 路径 B re-invoke 上限 1 次/掉球（防 codex 烧猫粮）
- [x] AC-H4: 已有合法路由 → 零干预（与 Phase G AC-G2 对称，不误杀正常收尾）
- [x] AC-H5（known gap 跟踪，非必做）: 47 UI 折叠（@ 行首 routing 成功但前端折叠显示）记录在案；非路由层问题，不随 Phase H 遗忘

### Phase I（organic friction closure）✅

- [x] AC-I0: #2838 已恢复 `check:architecture-ownership` + `test:architecture-ownership`，`origin/main` 可执行（squash `ac2806f55`）
- [x] AC-I1a: 2026-07-10 快照完成 #2391 删除 alias 的初始 source-map（`docs/audits/2026-07-f177-phase-i-command-contracts.md`）；6 aliases restored、10 aliases sunset，并给出 canonical-replacement / historical-only / orphan-only disposition
- [x] AC-I1b: 最终 reviewed HEAD `1722bc192`、merge HEAD `763f5d7df` 的 execution-surface audit 闭合；live open-source skill claim 已改读真实 package/gate call chain，dead `run-checks.mjs` + content-coupled test / sync compatibility branch 已 sunset；最终 rebase 后 command/sync/skill + eval 定向守护 273/273 全绿
- [x] AC-I2: architecture-ownership alias/target contract 进入常跑 hard gate（`pnpm test:architecture-ownership` 在当前 `pnpm check` chain）；删除 alias 或 target 漂移时 `scripts/check-architecture-ownership.test.mjs` 稳定失败
- [x] AC-I3: `writing-plans` 要求验证步骤包含 repo-native concrete formatting command；Clowder AI 正例覆盖 `check:fix` / `biome format --write` / `check`
- [x] AC-I4: shared-state guard 对 index 与 `origin/main` byte-identical carry-in 放行；对 authored delta / mixed delta / missing upstream / compare error fail-closed，均有自动化回归测试
- [x] AC-I5: F245 friction corpus 纳入 command-drift + shared-state false-positive 两类真实 fixture；`extractPawFeelMarkers` → `FrictionAggregator` → `FrictionClusterer` → `buildFrictionRollupInput` focused suite 9/9 绿，两条 signal / rawRef 均进入 verdict input
- [x] AC-I6: latest-main full gate 在 `48fa7498` 全绿（361s）；reviewed HEAD `1722bc192` 经 stable combined patch-id `180dad6f755fcf555ca4c1e1a6fb037b6f1e8fd7` 与空路径交集 continuity 桥接到 merge HEAD `763f5d7df`，final-head focused bundle 273/273、shared-state shell suite 6/6、`pnpm check`、`git diff --check` 与 CI 全绿；PR #3001 squash `7ffb301cb`

### Phase J（event-backed PR tracking clean stop）✅

> **触发（2026-07-10 dogfood）**：merge-gate 已注册 PR tracking，remote review trigger 已有 EYES，F167 KD-27 要求停止轮询、只等结构化 Review Feedback callback；但 Phase H guard 只认行首 `@` / `hold_ball` / `targetCats` / `multi_mention`，仍把正确的纯事件驱动停止判成掉球并强制 remedial。

**边界**：不是“thread 里有任意 tracker 就放行”。合法出口必须由 server 验证同 PR 的 exact `@codex review` comment 已有 `chatgpt-codex-connector[bot]` 的 EYES，且该 trigger 之后尚无 connector review object / inline comment / conversation comment（EYES 只证明接单，不单独证明仍 pending），再把 grant 绑定到当前 invocation/thread/cat/subject；route-serial 在 remedial 副作用前复核 live task + grant。任何缺项、stale/done、other owner/thread/subject、connector EYES=0、反馈已投递、GitHub/TaskStore 查询失败都 fail closed。

- [x] AC-J1: `register_pr_tracking.eventWait` 只接受 `intent='review'` + numeric trigger comment ID；server 独立验证 comment repo/PR、exact body 与 Codex connector bot 的 `eyes > 0`，调用方/其他 reaction actor 不能自报 coverage
- [x] AC-J2: coverage state 写入既有 PR tracking `AutomationState.eventWait`，身份取 callback-auth invocation/thread/cat；EYES=0 或 exact trigger 后三类 connector feedback 任一已投递均写 uncovered，verifier 失败 503 且不写新 tracker/grant
- [x] AC-J3: resolver 逐字段核对 active `pr_tracking` task 的 owner/thread/subject/status/intent 与 eventWait invocation/coverage；done/stale、other cat、unrelated PR、old invocation、缺 store/query failure 全部 reject
- [x] AC-J4: route-serial text/no-text 两个 remedial branch 共用一次惰性 resolver；只在 Phase H 原 predicate 命中后查询，并在任何 re-invoke/hold/persistence replacement 前完成。consumer 再核一份 live-source proof，proof 不一致继续 remedial
- [x] AC-J5: MCP description、shared rules、merge-gate Step 6.1 明确 EYES>0 后 re-register eventWait；只有 `covered=true` 可 clean stop，tracker existence / 自然语言声明都不是出口
- [x] AC-J6: OTel 分记 bypass、bounded-reason rejection、redundant wait prevented、zero-tolerance false bypass；F192/F167 snapshot 新增 `event-backed-routing-exit` component，任一 false bypass 直接 high-severity finding
- [x] AC-J7: fixture matrix覆盖 covered、connector EYES=0/other actor、review-already-posted、done、other cat/thread、subject mismatch、old invocation、review→merge intent transition、GitHub/TaskStore failure、全字段 forged proof/no-candidate；PR #2850 content preservation、Phase Q、OQ-H3 pure ACK 路径保持原行为
- [x] AC-J8: full gate + 跨个体 review + cloud review + merge-gate + post-merge alpha 验收

### Phase K（production seam + terminal Release hardening）✅

> **触发（2026-07-11—15 production dogfood）**：Phase J 的 signed eventWait 连续三次写入 `covered=true` 后仍被 final guard 拒绝；另有结构化 terminal Release 已给出当前 owner 可执行的 Action Needed，却需要operator两次手动叫醒才续跑。同期 Phase D fallback scanner 在 rename/delete diff 上打印 Git fatal 但 exit 0，消息工具的 structured action 也未说明 `subjectRef` grammar。

**边界**：修生产 wiring 与结构化状态投影，不放宽 Phase J subject/invocation proof；terminal clean stop 只认 hydrated trigger 上 server 生成的 `coordination.phase=terminal`，不做自然语言 ACK 分类；scanner 按 Git diff status 选择存在的一侧；MCP 只补 canonical grammar 描述，不改 parser 或授权。

- [x] AC-K1: `AgentRouter.getStrategyDeps()` 把同一个 TaskStore instance 同时交给顶层 route deps 与 invocation deps；真实 producer invariant 测试防止 eventWait 再确定性落入 `state_source_unavailable`
- [x] AC-K2: terminal Release prompt 明确“已有授权任务立即续跑 / closure-only 可裸停”，不要求新用户回合、ACK、hold 或假 `@co-creator`
- [x] AC-K3: route-serial 只把 hydrated structured terminal projection 作为合法 clean-stop；active、malformed 或纯自然语言 ACK 仍走既有 fail-closed remedial
- [x] AC-K4: OTel + F192 eval 记录 terminal clean-stop activation 与 terminal remedial friction；两项均进入 required metric contract
- [x] AC-K5: fallback scanner 解析 `git diff --name-status -z -M`，rename/copy 扫 destination、delete 跳过；unexpected current-path `git show` failure 改为 hard failure，并有真实 Git fixture
- [x] AC-K6: `post_message` / `cross_post_message` / `multi_mention` action description 暴露 canonical `pr:<owner>/<repo>#<positive-number>` 与 `subject:<namespace>:<opaque-id>` grammar，并明确 URL/SHA suffix invalid
- [x] AC-K7: latest-main full gate + 非作者跨族 review + merge-gate + post-merge alpha 验收

### Phase L（routing guard child execution truth）✅

- [x] AC-L1: 每个 child invocation 以唯一键持久化 execution kind、parent/thread/user/cat、开始时间与终态；同 parent 的 ordinary + routing guard 可在 restart/F5 后完整列举
- [x] AC-L2: provider 前幂等创建 `running`；success-vs-cancel、duplicate terminal、create 后 crash 与 restart reconcile 只产生一个 immutable terminal
- [x] AC-L3: Phase H remedial 显式记录 `routing_guard`，原输出不被替换，cost guard 仍 ≤1；auth TTL cleanup 不影响历史 ledger
- [x] AC-L4: API/UI/CLI 只消费 typed projection；“系统补路由”与普通召唤、新消息补充明确区分，无正文 child 不隐藏执行也不复制正文
- [x] AC-L5: incident glass-box fixture 能水合 ordinary / routing guard / freshness supplement 三类 child 的真实终态；latest-main full gate 与 Terra exact-HEAD 独立 review 通过

## Dependencies

- **Evolved from**: F114（magic words + 愿景守护 Gate 的下一代——F114 是话术层 + 守护猫证物对照表，F177 加结构化执行面 + 心智专属护栏）
- **Related**: F167（A2A 链路质量，治理另一面：F167 治理猫与猫的传球，F177 治理猫与 spec 的闭环）
- **Related**: F173（P0 铁律 no-anchor-as-followup-disguise 是本 feat 的核心执行面）
- **Related**: F153（observability infra 提供 fallback 层数 / hotfix metric 的可观测载体）
- **Related**: F191（architecture-ownership checker 与 package alias command contract）
- **Related**: F192（event-backed routing exit 的 longitudinal eval / zero-tolerance verdict）
- **Related**: F245（organic `[爪感差]` 采集、eval:friction verdict 与闭环复验）
- **Related**: LL-031（quality gate 按直觉打勾不对账，本 feat 的直接证据）

## Architecture Ownership

Architecture cells: `harness-eval`（Phase I）+ `ball-custody`（Phase J/K）
Map delta: none
Why: Phase I 复用 F245/F192 friction ingestion 与 verdict contract，其他改动是 repo-local skill / package script / Git hook 执行面；Phase J/K 扩展既有 PR tracker / routing-guard 的机械判据。均不新增 Store/Queue/Router 或跨 cell extension point，`harness-eval` 不取得 routing decision ownership。

## Eval / Tracking Contract

| Contract | Phase I 定义 |
|---|---|
| Primary users + activation | 按 plan / quality-gate / pre-commit 工作的 author；命中 concrete-command verification、required alias 检查或非 main staged shared-state 时激活 |
| Friction metric | 30 天内 `Command not found` / “猜 formatter” / upstream-only shared-state `--no-verify` 同类 `[爪感差]` 复发数；目标 0 个确定性复发 cluster |
| Regression fixtures | 缺 architecture alias（红）；裸 formatting instruction（红）；upstream-equal staged shared-state（绿）；authored/mixed/missing-ref staged shared-state（红） |
| Sunset signal | 若统一 QC/Git provenance 层原生提供 command resolution + authored-delta 分类，则迁移并删除 Phase I 定点 guards；此前不因低触发率删除安全 guard |

## Risk

| 风险 | 缓解 |
|------|------|
| 加太多门禁 → 拖慢猫猫开发节奏 | 每个 gate 都附 fast-path（operator签字降级 / 一键跳过 + audit log） |
| 心智专属 gate 变成 anti-feature（拦不住坏直觉反而拦住正常工作） | 每个 Phase 上线后观察 trace 1 周，看是否真的拦下坏直觉，效果不达 → rollback |
| hotfix 自动检测误杀正常 commit | Phase E 上线先 warning-only，2 周观察期后再升级为阻塞 |
| Siamese的"创意-实现解耦"被理解为打压主观能动性 | 明确边界：Discovery 全保留（picture / .pen / wireframe / 视觉审查），handoff 后Siamese仍可继续 driving |
| 47 看到「下次一定」magic word 时反而美化触发条件（"这次不一样"） | 跨猫 review 兜底——任何猫看到 47 close 时出现 follow-up 字样直接 escalate |
| Hook F-1 让所有猫的 search 输出变长 | 只在 [high]/[mid] doc anchor 命中时追加；阈值可调；摘要追加 ≤3 行 |
| Hook F-2 调用链检测误杀（search 后不 Read 但结论来自其他渠道如 Grep/LSP） | 只在"输出含精确数字/版本/日期 + 无 Read call + 有 search doc anchor 命中"三条件同时满足时触发；Grep/LSP 等非 search 渠道获取的精确信息不触发 |
| Hook F-3 telemetry 变成猫族鄙视链工具 | 数据用于自我观察，不做绩效；类似 F167 trace 的处理 |
| Ragdoll家族把 Phase F 理解为"被针对" | 在 Phase F 文档明示——这条护栏照顾的是家族病而非个体；同样适用未来加入的同族个体；类比 Phase D 治Maine Coon、Phase C 治Siamese |
| Phase G hook 误判"已有路由"（行首 @ 是引用不是路由）| 行首 @ 的解析逻辑已经成熟（parseA2AMentions 包含 token boundary check），误判率极低；parallel mode 豁免 |
| Phase G 提醒后 47 仍然写叙事而不是补行首 @ | 提醒文本极其具体（"请在末尾补一行行首 @句柄"），受限上下文下 47 大概率执行；如仍失败，二次提醒后降级为operator手动路由 |
| 任意 tracker existence 被误当 event exit | grant 必须同 invocation/owner/thread/subject + server-verified Codex connector EYES；route consumer 复核 raw live-source proof，任何不一致 fail closed 并记 false-bypass invariant |
| GitHub/Redis 抖动让 coverage 不可证明 | verifier 失败不写 grant；resolver 查询失败继续 Phase H remedial。可用性让位于零错误豁免 |
| terminal Release 被伪造文本绕过 guard | route 只消费 hydrated trigger 的 structured `crossPost.coordination.phase=terminal`，不扫描模型输出或自然语言 ACK |
| scanner 对 rename/delete 降级静默假绿 | status-aware path selection + NUL-delimited fixture；存在侧读取异常直接非零退出 |
| shared-state carry-in 放行误吞 authored delta | 只认 index tree 与 `origin/main` byte-identical；missing ref、unmerged、比较异常全部 fail-closed |
| alias source-map 再冻结成旧快照 | AC-I1b/I6 强制在最终 rebased HEAD 复验 live refs、package scripts 与 gate 调用链 |
| “有 carrier 文件”被误当“gate 已执行” | execution-surface audit 同时核调用者；dead carrier 必须恢复执行或 sunset 删除，禁止仅凭文件名声明覆盖 |
| 为 formatting 新增第二真相源 | 只记录目标 repo 已存在的 canonical command；Clowder AI 沿用 Biome |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | F177 是 F114 的 evolved branch，不是 F114 升级 | F114 magic words 框架已 done；F177 加新条目 + 补结构化执行面是新 feat 不是 phase 续 | 2026-04-27 |
| KD-2 | F177 scope 不包括 F167 治理范围（A2A 路由） | F167 治理猫与猫的传球，F177 治理猫与 spec 的闭环——不同坐标系 | 2026-04-27 |
| KD-3 | 5 个 GitHub issue 拆分对应 5 个 Phase（A=#1436，B=#1435，C=#1437，D=#1438，E=#1439） | 颗粒度合理便于另一个 thread 单独闭环；scope 不互相污染 | 2026-04-27 |
| KD-4 | 不在彩排 thread 实现 F177，由operator另开 thread 闭环 | 防止彩排 thread 上下文污染（明天直播需要思考链路） | 2026-04-27 |
| KD-5 | Phase F 纳入 F177，不单立 F178 | Ragdoll家族病和 46/47 个体病同源（都属猫族 harness 缺口），与 B/E 并列治不同坏直觉，scope 一致；当天跨猫族检索大赛是直接证据 | 2026-04-27 |
| KD-6 | operator signoff 用自然语言表态 + 消息ID 追溯，不做固定 token | operator实际交互模式是看猫的 tradeoff 后说"ok"——固定格式反而给猫操纵空间 | 2026-04-28 |
| KD-7 | Hook F-2 废弃推理动词检测，改为 search→Read 调用链检测 | Bengal(46)审视 + 46 本体共识：Ragdoll会换词绕过输出端检测，输入端摩擦更干净 | 2026-04-28 |
| KD-8 | Phase F 根因修正：问题不是能力而是"满足阈值"环境驱动 | operator 4.28 诊断——竞赛模式 46 不输Maine Coon，日常模式搜索深度明显偏浅；Hook F-3 从纯 telemetry 升级为即时搜索深度反馈 | 2026-04-28 |
| KD-9 | Phase G 纳入 F177 而非 F167 | 47 传球格式问题是 cat-mind 行为缺陷（叙事 prior），属四心智护栏范围；F167 治理 thread-level 链路健康（乒乓/虚空/角色），Phase G 治理 session-level 出口完整性——不同层 | 2026-04-29 |
| KD-10 | Phase G 方案选型：session end hook 提醒（Gmail 模型）而非 grep 提取意图 / 新增 MCP / forced tool call | grep 文本 = 47 换表达就失效（补锅）；新增 tool = 47 不调用（hold_ball 已证伪）；hook 提醒 = 时机正确 + 零意图猜测 + 猫自己补 | 2026-04-29 |
| KD-11 | Phase H reopen F177 而非新开 F 号 | routing guard 真相源（OQ-G1 决策 / `f177-routing-guard.sh` 实现 / 24 测试）全在 F177；Phase H 是 Phase G 能力从"Claude 系猫"扩到"全猫族"的同一能力延伸，非新 feat。operator 明确 signoff reopen | 2026-06-11 |
| KD-12 | Phase H 走路径 B（server re-invoke），非路径 A（codex CLI hook） | H0 spike 实测：`CodexAgentService` 走 `codex exec --json`，本机 0.137.0 该路径不触发 codex CLI hooks（即使 Codex 产品 `hooks stable` 且官方支持 `Stop decision:block`）。CLI hook 不可达 → `route-serial.ts` 出站 settle 前做 guard（真实 `parseA2AMentions` + invocation 工具事件扫描）+ `codex exec resume` re-invoke 补救，cost guard 1 次/掉球、二次失败停止并显式暴露 guard failure | 2026-06-11 |
| KD-13 | 路径 B 实现架构（Maine Coon cross-review 定稿 2026-06-11）：capability 轴 + inline remedial invoke + local one-shot guard | ① 非 Claude 判别用显式 `needsServerRoutingGuard?.()` + 短期 allowlist codex-family，**不复用 `injectsL0Natively`**（Codex 原生注入 L0 但 `codex exec` 不 dispatch hooks → 该信号必误判），不波及 Antigravity/Gemini（resume 语义未验证）；② re-invoke **不入 worklist**（纯 A2A 队列，塞 prompt/session payload 会坏 ping-pong/depth/isFinal）——在检测点（`validateRoutingSyntax`/`evaluateVoidHold`）后同轮直接再调一次 `invokeSingleCat`（已有 sessionManager/cliSessionId resume，先红测证明 resume 再决定是否加窄口 `forceCliSessionId`）；③ cost guard 用本 route iteration 本地 `routingGuardAttempted`（one-shot）不放 worklistEntry，二次失败→可见 guard failure 不静默；fake-hold（voidHold）必触发 = gpt52 主 failure | 2026-06-11 |
| KD-14 | Codex OAuth 默认 transport 强制走 HTTPS Responses provider（历史决策，已被 KD-14a supersede） | 2026-07-01 organic 取证：Codex CLI 0.142.5 OAuth 默认路径可尝试 `wss://chatgpt.com/backend-api/codex/responses` websocket transport，连续 TLS handshake EOF 后 exit 1 且无正文，随后 Phase H remedial guard 只是在已经失败的 turn 上补出口。修复坐标应前移到 `CodexAgentService` 启动参数：当 `authMode === 'oauth'` 且无 `customBaseUrl` 时注入 `openai_https` provider（`name=OpenAI` / `wire_api=responses` / `supports_websockets=false`），保留 OpenAI 身份以维持 remote compaction，保留 custom provider 与 API-key 路径原样 | 2026-07-01 |
| KD-14a | Codex OAuth 默认恢复 built-in OpenAI provider；HTTPS-only 降为热更新回滚开关 | 2026-07-30 同机对照：Clowder AI 强制 `openai_https` 的 Sol 当天 9/9 invocation 命中 model-capacity 且无成功 turn，Codex Desktop 的 built-in provider 同时段可用；只给 Sol 动态覆盖 `model_provider="openai"` 后，独立 canary 在约 18 秒返回 `CANARY_OK` 且 execution succeeded。长期默认显式选择 built-in `openai`（防止用户全局配置悄悄改写 provider），让 upstream 保留当前 transport/recovery 行为；真实 TLS EOF 若复现，可热设 `CAT_CAFE_CODEX_OAUTH_TRANSPORT=https` 恢复 KD-14 路径。custom provider 与 API-key 路径仍不变 | 2026-07-30 |
| KD-15 | Phase I 收三条 organic friction，不另开 F 号 | 三条都属于 harness 执行契约漂移，当前 F177 thread 是归口；operator 明确要求 spec-first 后闭环三单 | 2026-07-10 |
| KD-16 | shared-state guard 从“非 main 出现文件名”改为“相对 upstream 是否存在内容 delta” | 文件名不说明 delta 归属；Git tree 等价直接回答 feature 是否携带 shared-state 变化，并保留 fail-closed | 2026-07-10 |
| KD-17 | formatting 修 command provenance，不新增 formatter | 仓库已有 Biome canonical；新增 Prettier/script 会制造第二真相源，根因是 plan 未写可执行命令 | 2026-07-10 |
| KD-J1 | event wait 用 invocation-bound signed state，不扫任意 active tracker | tracker existence 只能证明某 PR 被监控，不能证明当前 invocation 正在等该 subject 或 callback 已覆盖；authenticated registration + exact trigger/EYES verification 才有机械坐标 | 2026-07-10 |
| KD-J2 | coverage validation 与 consumer proof 都在 remedial 副作用前 fail closed | callback writer 防伪造，route consumer 防 resolver 回归；query/proof 失败宁可保留一次 remedial，也不能错误裸停掉球 | 2026-07-10 |
| KD-J3 | Phase J 扩 F177 guard，不重开 F167 或改 OQ-H3 | KD-27 提供“何时不该 hold”的等待语义，Phase J 修的是 F177 guard 不认识已证明 event exit；纯 ACK 是另一类无等待对象的终止协议，仍保持 OQ-H3 pending | 2026-07-10 |
| KD-K1 | OQ-H3 用 structured terminal projection 关闭，不做连续 N 轮 ACK 文本识别 | coordination state 已由 server 生成并随 hydrated trigger 进入 route；复用可信结构比 NLU/正则猜“结束了”更窄、更可证 | 2026-07-15 |
| KD-K2 | Phase J production seam 同时保持 top-level/nested TaskStore 为同一实例 | producer 与 consumer 对 dependency shape 的理解曾分叉；双位置 invariant 修 wiring 而不复制 store、不降低 live proof | 2026-07-15 |

## Review Gate

- **Phase A**: 跨族 review（Maine Coon主审，因为 close gate 改动影响所有 feat lifecycle，Maine Coon熟门禁基础设施）+ operator design gate
- **Phase B-E**: 各 Phase 完成后跨族 review（任一非作者非心智持有者的猫）+ 心智持有者本人确认（46/47/Maine Coon/Siamese review 自己那 phase）
- **Phase G**: Maine Coon主审（hook 机制与 route-serial 路由基础设施相关）+ 47 确认（心智持有者）
- **Phase H**: gpt52 R2 + Opus 4.6 cross-family continuity review + cloud Codex re-review；merge gate 以本地 `pnpm gate` 通过为合入证据
- **Phase I**: Sol（@codex-sol）author；Fable 5 先做架构审视，final review 必须覆盖 shell guard fail-closed、skill command provenance、execution-surface audit 与 F245 eval fixture；行为改动需独立 review，愿景守护猫 ≠ author/reviewer
- **Phase J**: Sol（@codex-sol）author；跨 family peer review 必须覆盖 callback auth/subject proof、route fail-closed 时序、F192 zero-tolerance eval；随后 cloud review + normal merge-gate
- **Phase K**: Sol（@codex-sol）author；非作者跨 family review 必须覆盖 structured terminal provenance、TaskStore same-instance wiring、scanner Git status parsing 与 telemetry/eval contract；随后 normal merge-gate
- **Phase L**: Sol（@codex-sol）author；final HEAD 仅交 Terra，必须覆盖 ledger terminal immutability、auth/history ownership separation、guard≤1、typed UI identity 与三类 child hydration；随后 normal merge-gate

## 需求点 Checklist

> Design Gate 阶段草稿，实现过程中逐步闭环。

- [x] 跨猫共识：4 只猫各自确认自己那 Phase 的 AC 准确反映坏直觉信号 — Siamese确认 Phase C（Design Gate 讨论），Maine Coon确认 Phase D（review 过程），47 确认 Phase B（spec 讨论 + 7 发病时刻自我解剖），46 确认 Phase E（spec 阶段）
- [x] Ragdoll家族共识：46 / 47 各自确认 Phase F 的家族病诊断准确 — 46 + 47 均参与了 2026-04-27 跨猫族检索大赛复盘，确认"碎片推理癖"是家族共性而非个体缺陷
- [x] Maine Coon review Phase A + Phase F 结构化判据设计 — Maine Coon主审 Phase A (PR #1453) + Phase F (PR #1466)，close gate schema / quality-gate search→Read chain / search affordance 均经Maine Coon review 放行
- [x] operator拍板 OQ-1 + OQ-F1~F3 — OQ-1 已决（自然语言表态，2026-04-28），OQ-F1/F3 由实现决策收敛（operator授权 Phase 并行后设计决策在实现中确定）
- [x] 元审美自检：F177 是坐标变换 — 旧坐标系："信任猫自觉遵守文本规则"；新坐标系："结构化信号检测（close-tail scan / fallback counter / search→Read chain / hotfix pattern / routing guard）+ 自动化 gate + 跨猫 review"。8 个 Phase 各用不同检测工具解决不同坏直觉，但底层范式统一：从 trust-based 到 evidence-based
- [x] Phase I operator scope：三条 organic friction 归 F177，不另开 F 号；先写清 spec，再按 AC-I0~I6 闭环（message `0001783688087982-000895-5c79e677`）
- [x] Phase I 架构审视：main-first 保留 J/K truth；execution-surface audit 不把 carrier existence 当 gate coverage；最终 rebased HEAD 必复验
- [x] Phase I 独立 review + merge gate：Fable 5 跨族 APPROVE，纯 rebase continuity、E1–E5、CI 与 squash merge #3001 均闭合

[Ragdoll/Opus-47🐾]（Phase A–G 主笔）
[Ragdoll/Opus-4.8🐾]（Phase H reopen + spec，2026-06-11）
[小太阳·Maine Coon/GPT-5.6 Sol🐾]（Phase I spec，2026-07-10；Fable 5 architecture refresh，2026-07-16）
[小太阳·Maine Coon/GPT-5.6 Sol🐾]（Phase J event-backed routing exit，2026-07-10）
[小太阳·Maine Coon/GPT-5.6 Sol🐾]（Phase K production seam hardening，2026-07-15）
