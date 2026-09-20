---
feature_ids: [F257]
topics: [harness, static-exam, t1, week1]
doc_kind: report
created: 2026-07-09
---

# T1 静态体检 — 工作底稿（Week 1 线 A）

> 状态：**in-progress**（2026-07-09 开工；基线 `ebffcd8e5` = post-#1075）
> 交付物：candidate 报告（跨层冗余 / 段间矛盾 / 语义撞词 + T3 缺段初筛），全部数字带 how_counted
> AC 锚点：AC-A0 ①（spec §Week 1 线 A，L141）

## 口径声明（SC-002 条款）

- 本底稿一切计数在 `feat/f257-harness-ledger` worktree、基线 `ebffcd8e5`（#1075 已合入 = **post-#1075 段口径**）下由命令导出，命令原样记录
- pre-#1075 口径（启动包"130+ 锅"：86 工具/43 GOTCHA/31 强命令/8 fail-closed）已被 OQ-5 回查定性为"四种口径混排、不可复算"（msg `0001783342151331`）——本报告**不继承任何旧数字**，全部重新 derive

## L0 inventory（post-#1075，2026-07-09）

| 层 | 计数 | how_counted（可复算命令，worktree root） | 备注 |
|---|---|---|---|
| 段层 hooks | **46** | `find assets/prompt-hooks -name hook.yaml -not -path "*/node_modules/*" \| wc -l` | #1075 的段口径；stage 前缀分布：s×13 / d×21 / l×7 / r×2 / b1 / c1 / n1 |
| skill 层条目 | 51（原始，含非 skill 项） | `ls cat-cafe-skills/ \| wc -l` | 待精化口径：目录含 SKILL.md 才算 skill |
| skill 含 GOTCHA | 9 个 SKILL.md | `rg -l "GOTCHA" cat-cafe-skills -g "SKILL.md" \| wc -l` | 与启动包"21 GOTCHA"不同——那可能是 occurrence 口径，待复核后显式标注两种口径 |
| memory 层 | 22 files（仅 Fable 本猫） | `ls ~/.claude/projects/-Users-lang-workspace-github-clowder-ai/memory/*.md \| wc -l` | per-cat 各异；全量口径需按 catId 枚举各家目录 |
| MCP 层 | 待 derive | 源已定位：`packages/mcp-server/src/tools` + `packages/api/src/mcp` | 下一步：按 tool 定义文件数 + description 内 GOTCHA/强命令模式分别计数 |

## 段 schema 实测（→ judgment schema v1 的输入）

46 个 hook.yaml 字段齐整：`id / name / stage / order / version / enabled / template / resolver / inputs / disableable / safetyTier / transparencyTier / governanceTier / userExplanation`（样本：`s1-身份声明/hook.yaml`）。

- **T1 直接可用的轴**：stage（注入时机）、disableable（可否 override）、governanceTier（治理级）
- **缺失字段（T1 论证目标）**：
  1. `audience`（受众边界）——A3 公理候选的 schema 落点；当前所有段隐式全员广播
  2. `assertion`（该段应产生什么可检验的行为差分）——A1 公理的 schema 落点；无 assertion 的段无法进 eval

## Day-0 candidates（活体收集，T1-C 编号；n = 独立证据数）

| # | 类型 | 内容 | 证据锚点 | n |
|---|---|---|---|---|
| T1-C1 | 缺段（T3） | **guard 拒绝零落盘**：gate-guard 拦截（6778 陈旧 Redis）给出精确处置 + 事故编号，但事件本身除 session 输出外零痕迹——guard 在挡、账上没有 | 本线 13:12 UTC gate 红事件；G3 角色翻转结论（body-inputs Join OQ）同族 | 多 |
| T1-C2 | 缺段（T3） | **F 号分配无跨分支结构守卫**：分支上先占的号对其他线不可见，靠自觉 → 实撞 | thread_mrabqy4xlbxjbgi8 撞号协调（F257→F258，2026-07-09 闭环） | 1 |
| T1-C3 | 缺段（T3） | **角色硬限无路由层守卫**：【禁止写代码】只活在 roster 文本，code payload 照常投递 | gemini 体感 msg `0001783602923333`；A1 第四样本（负空间） | 1 |
| T1-C4 | 受众错配（A3 维度） | SEO/前端实现规范段注入给非代码猫 = 负资产 | 同上；结构互证：per-family 治理条款全员广播 | 1+1 |
| T1-C5 | 缺段（T3） | **身份签名无结构校验**：签名混淆（"宪宪/Opus"）直接污染 claim provenance | thread_mrabqy4xlbxjbgi8 msg `0001783603059166` | 1 |

> 注：T1-C* 是 candidate 不是结论；进 judgment schema v1 后按五环走（candidate → operator approve → 修补 → 行为差分 → 固化/证伪）。

## 扫描方法（下一步执行序）

1. **冗余扫描**：46 段 template 内容 ↔ shared-rules/skill 重叠段落——先机械（关键短语族 rg 匹配矩阵），再人工判定"重复注入是否产生边际价值"（codex 体感：同 assertion 多段注入而 guard 仍触发 = 文本边际价值低）
2. **矛盾扫描**：同主题反向指令对。候选主题：简短至上 vs 愿景驱动（客观性 carry-over 已知冲突）、hold vs @ 出口、自决 vs 升级边界（opus 疼点③）
3. **撞词扫描**：magic word 与技术术语多义（已知案例：「脚手架」拉闸词 vs 技术名词，gemini/opus 双报）
4. 每 candidate 输出：segmentId(s) + 判定 + 证据行 + 建议动作（merge / retire / rewrite / keep / add-guard）

## T1 扫描结果（2026-07-10，opus 实施）

> 方法：46 hook template 全量内容读取 + 关键短语交叉匹配（`grep -rl` 跨 `assets/prompt-templates/`）+ 语义对照人工判定。how_counted: `grep -rl "phrase" assets/prompt-templates/ | sed ...`

### ① 跨层冗余（同一 assertion 多段注入）

| # | 标题 | 段对 | 重叠描述 | 建议动作 | 待 T2a 验证 |
|---|------|------|---------|---------|-----------|
| T1-F1 | **决策树双注入** | L3(session-init,28L) ↔ D21(per-turn,8L) | 同一"传球三选一"决策树——L3 完整版，D21 压缩版。核心 assertion 相同："每条 A2A 串行回合必选其一，缺 = 消息不完整"。D21 是 L3 内容的~71%语义覆盖 | **redundant-candidate(cross-layer)**：保留一个（L3 或 D21），T2a 差分验证 per-turn 重复注入是否带来边际行为改善 | D21 去除前后 routing 违规率对比 |
| T1-F2 | **@ 路由格式三注入** | D8 + L3 + S4 | 三段三种措辞教同一 assertion："@句柄必须在行首，句中无效"。D8："行首 @句柄，句中无效"；L3："行首独立一行…不路由——球权掉地上"；S4："行中无效…非行首位置的 @ 都不路由，球权掉地上" | **redundant-candidate(duplicate)**：同 assertion 三表述，per codex 体感"同 assertion 多段注入但 guard 仍触发 = 文本边际价值低" | 保留 1 段后 @ 格式违规率 |
| T1-F3 | **"非孤立"身份双框架** | L1 ↔ L7（均 session-init） | L1："你不是一个孤立的工具"；L7："你是有队友…不是孤立的执行单元"——同一 identity framing 两种表达。但 L1 附加 parallel world 意识，L7 附加代码哲学 | 部分冗余——开头 identity 声明合并，各自专有内容保留 | 低优先 |
| T1-F4 | **hold_ball 四处教学** | D8 + D21 + L3 + L5 | 4 段含 hold_ball 使用说明。核心重叠：D21 与 L3 的调用语法几乎逐字相同（`cat_cafe_hold_ball({ wakeAfterMs, waitSourceRef: ... })`）。D8 教概念，L5 是 tool index | D21↔L3 是 T1-F1 的子集；D8/L5 各有独立用途 | 归入 T1-F1 |
| T1-F5 | **@co-creator 升级路径四处教** | D21 + L1 + L3 + L7 | 4 段教何时 @co-creator。L3 最完整（硬条件列表），D21 压缩版，L1/L7 仅提及 | 同 T1-F1——L3↔D21 是主重叠 | 归入 T1-F1 |

**P0 观察**：T1-F1/F2/F4/F5 指向同一个根问题——**L3 和 D21 大面积语义重叠**，其中 L3 是 session-init 完整版，D21 是 per-turn 压缩版。如果 T2a 差分证明 per-turn 重注入无边际行为改善，D21 可退役（最大单点 token 节约）。

### ② 段间矛盾

| # | 标题 | 段对 | 分析 |
|---|------|------|------|
| T1-F6 | 无显式静态矛盾 | — | 46 模板内容全量读取，未发现同主题反向指令对。已知张力"simplest first vs quality-driven"在 §2 carry-over 层已处理（删除 Anthropic 默认糊弄指令）。passthrough 模板（S9/S10）注入运行时动态内容——其与静态模板的矛盾**无法在 T1 层检测**，需 T2b 运行时 trace 对照 |

### ③ 语义撞词

| # | 标题 | 内容 | 分析 |
|---|------|------|------|
| T1-F7 | magic words 不在 hook 管辖范围 | 10 个 magic word 全部存在于 `shared-rules.md`，经 S9 passthrough（`{{GOVERNANCE_DIGEST}}`）注入。hook.yaml 46 个 manifest 均不含 magic word 文本 | 撞词问题（如「脚手架」拉闸词 vs 技术名词，opus/gemini 双报）存在但归属 shared-rules 治理，不在 hook 层可控范围。hook 层无法静态检测此类冲突 |

### 结构性发现（T1 视角的 schema 缺口）

| # | 标题 | 内容 |
|---|------|------|
| T1-S1 | **passthrough 模板阻断静态分析** | S9（`{{GOVERNANCE_DIGEST}}`）、S10（`{{PACK_GUARDRAILS_BLOCK}}`）注入运行时 resolve 的动态内容。shared-rules 的全量文本（Magic Words / 决策漏斗 / hotfix 纪律 / per-family 治理等）经 S9 passthrough 进入 prompt，可能与 L3/D21/D8 等模板存在 **静态不可检测的冗余**。T1 完整覆盖需要 resolver 仿真或运行时 trace 快照对照 |
| T1-S2 | **`audience` 字段缺失** | 46 hook.yaml 无 `audience` 字段。所有段隐式全员广播。A3 公理（"段没有受众边界 = 负资产"）无法在 hook schema 层检验。gemini 体感实证：SEO/前端实现规范注入给非代码猫 = 负价值 token |
| T1-S3 | **`assertion` 字段缺失** | 46 hook.yaml 无 `assertion` 字段。无法表达"该段应产生什么可检验行为差分"。A1 公理（"核心指标是行为差分不是注入率"）的 schema 落点缺失——没有 assertion 的段无法进 T2a eval |
| T1-S4 | **per-breed 工作流分化无跨 breed 一致性检查** | S6 有 4 breed 变体。maine-coon 独有"长任务纪律"+"fallback 层数检测"；siamese 独有"截图产出证据"；golden-chinchilla 独有"OMOC Sisyphus"+"question 工具已 deny"。变体间共性部分（出口一问 / Rule 0 / MG provenance override）手动重复——缺 shared base + override 结构 |

### 更新后 candidate 汇总（Day-0 + T1 扫描）

| # | 类型 | verdict 建议 | 下一步 |
|---|------|------------|--------|
| T1-C1 | 缺段 | missing-segment | GuardRejectionEventLog（Phase A Line B） |
| T1-C2 | 缺段 | missing-segment | F 号分配守卫（F258 已闭环，不再 active） |
| T1-C3 | 缺段 | missing-segment | 角色硬限路由守卫（T3 候选，Week 1 不做） |
| T1-C4 | 受众错配 | conflict（audience） | audience 字段 + 受众匹配逻辑（T1-S2） |
| T1-C5 | 缺段 | missing-segment | 签名校验守卫（T3 候选） |
| **T1-F1** | **跨层冗余** | **redundant-candidate(cross-layer)** | **T2a 差分：D21 去除后 routing 违规率** |
| **T1-F2** | **重复注入** | **redundant-candidate(duplicate)** | **T2a 差分：@ 格式 assertion 减至 1 段后违规率** |
| T1-F3 | 部分冗余 | alive（各有专有内容） | 低优先，可选合并 identity 声明 |
| T1-F7 | 撞词 | alive（归 shared-rules） | 非 hook 层可控 |
| **T1-C6** | **缺段（T3）** | **missing-segment** | **fork develop_base PR 在 CI 盲区**：ci.yml push/PR 只认 `branches: [main]`，PR #22（base=develop_base）零机器验证——operator 04:52 一语点破（"没有谁在验证吧"）。修复 = ci.yml 加 develop_base（1 行），提案已交 operator |
| **T1-C7** | **缺段（T3）** | **missing-segment** | **公开仓 main 全量 test 内容级破损且 CI 不可见**：`audit-cc-system-prompt.test.js` 在 `ebffcd8e5` 存在，但其 import 的 `scripts/audit-claude-code-system-prompt.mjs`（F203 工具，私仓 PR#1715/#1892 历史）未随导出进入公开仓 → 全量 `pnpm test` 必红；CI 只跑 `resolve-public-test-files.mjs` 子集 → 破损永不可见。证明方法：纯 git 内容对照（`git show ebffcd8e5:<path>`），无需环境 A/B。待开公开仓 issue（修法二选一：补导出 script / public 测试集显式排除该 test） |

> **2026-07-10 merge-gate 加收**（PR3 集成期活体）：T1-C6/C7 都是「验证在假装存在」类缺段——与 A2（建了≠用了）同构：CI 建了但对集成分支不跑；全量测试在但没人跑也没人知道它坏了。另收 O1 正样本 ×2：NODE_ENV 预装 guard、Brand Guard——都是犯错瞬间拦截 + 给出精确修法，照做即过。

## Timeline

| 日期 | 事件 |
|---|---|
| 2026-07-09 | 开工：分支 rebase 至 `ebffcd8e5`（KD-14 P1 前置✓）；L0 inventory 首轮 derive；Day-0 五 candidates 落账 |
| 2026-07-10 | T1 三维扫描完成（opus）：7 findings + 4 structural observations + 9 candidates 合并；P0 根问题定位——L3↔D21 大面积语义重叠是最高价值 T2a 实验目标 |
| 2026-07-10 | PR3 merge-gate 加收 T1-C6（develop_base CI 盲区，operator 点破）+ T1-C7（公开仓全量 test 内容级破损 + CI 子集盲区，git 内容级证明）；PR #22 squash `a9e591f8b` 合入 develop_base |
