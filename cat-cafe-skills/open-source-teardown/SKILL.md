---
name: open-source-teardown
description: >
  明星开源项目拆解：从宣传/PPT/README 进入源码，验证真实架构、明星特性、算法含量、营销水分、可学习点和不 follow 的 tradeoff。
  Use when: 铲屎官要求拆解热门 GitHub 项目、竞品 agent/runtime、外部 skill/tool 框架，或问“它到底有什么真本事/我们能学什么”。
  Not for: 普通资料搜索（用 deep-research）、社区 issue/PR 运营（用 opensource-ops）、只需要架构头脑风暴（用 collaborative-thinking）。
  Output: feature-discussions/YYYY-MM-DD-{project}-deep-dive/ 下的代码证据报告 + 对比结论 + 候选 lesson/skill。
  GOTCHA: 不许只看 README 下判断；每个明星特性必须追到代码路径、状态突变点、反馈闭环和算法输入输出。
triggers:
  - "拆解明星开源项目"
  - "拆解开源项目"
  - "竞品拆解"
  - "热门 GitHub 项目"
  - "它有什么真本事"
  - "我们能学什么"
  - "marketing vs reality"
  - "算法含量"
  - "拆解 hermes"
  - "看看 letta 怎么做的"
  - "codex cli 源码"
  - "agent runtime 拆解"
---

# Open Source Teardown

明星项目拆解不是“读 README 做竞品分析”，而是**宣传 claim → 源码证据 → 能力边界 → 我们的 tradeoff** 的审计流程。

## When to Use

触发：铲屎官看到 PPT、博客、README、社区讨论后问“这个项目是不是很强？”；需要拆解 agent runtime、skill 系统、memory/RAG、MCP/gateway、RL/eval、插件架构等工程系统；或需要把一次竞品分析沉淀为 lesson / ADR / skill。

排除：只需要查公开资料或论文综述用 `deep-research`；只需要处理外部 issue/PR/intake 用 `opensource-ops`；还没有明确目标项目、只是在讨论方向用 `collaborative-thinking`。

灰例：如果用户同时要求“查社区 issue 情报 + 读源码”，先用本 skill 建代码证据骨架，再按需补 `deep-research` 或 `opensource-ops`。

## Required Output

默认落盘：*(internal reference removed)*，包含 README、architecture-map、明星特性深挖、comparison、lessons/next steps。

最小合格产物必须包含：

- source repo URL、local path、commit SHA、更新时间。
- 宣传 claims ledger：claim / evidence files / verdict / caveat。
- 架构图或模块地图：entrypoints、state stores、extension points、empty dirs；用 ASCII tree 或 Mermaid，参考 *(internal reference removed)*。
- 明星特性深挖：每个特性都写到代码路径和运行链路。
- 算法剥皮表：真算法 / LLM judge / 启发式 / 规则 / 外部服务。
- Cat Café 对比：能学、不能学、我们因为 tradeoff 不 follow 的理由。

报告模板见 [refs/report-template.md](refs/report-template.md)；八审计镜头 + 命令见 [refs/teardown-method.md](refs/teardown-method.md)；用户视角第一性原理（第 9 镜头）见 [refs/user-mind-evaluation.md](refs/user-mind-evaluation.md)。

## 进度纪律

- **分次推进**：每只猫每次只做 1-2 份产物，commit 后传球，不一气呵成。
- **双视角交叉**：架构/明星特性/合流/skill draft 至少跨两只猫完成。
- **对口 review**：最终报告或 skill draft 必须由非作者猫 review，跨族优先。

### Step 0 — 定边界和真相源

1. 记录用户原始问题和最关心的 claims。
2. `search_evidence` 查我们是否已有同项目/同类系统讨论、lesson、feature anchor；有矛盾就 flag。
3. clone 或 update 到 `/home/user/{project}`。
4. 记录 `git rev-parse HEAD`、最新 tag/release、`git status --short`。
5. 把 README/PPT/官网中的明星特性拆成 claims ledger。

不要先评价。先把“它声称自己有什么”列成可验证对象。

### Step 1 — 架构地图

用 `git ls-files`、`find . -type d -empty`、`rg` 建第一版地图：

- entrypoints：CLI/server/worker/daemon/web。
- state stores：DB、files、cache、memory、lockfile、config。
- extension points：plugin/provider/adapter/registry。
- suspicious placeholders：空目录、TODO-only、docs-only 模块。
- community signals：高赞 issue、roadmap、真实 bug/feature 请求，验证宣传和用户痛点是否一致。

### Step 2 — 明星特性逐个追链路

每个 claim 单独拆：

```text
claim -> public API/command -> entrypoint -> core module -> state mutation -> future behavior
```

如果 claim 说“self-improving / learns / evolves”，必须画：

```text
signal -> decision -> state mutation -> future behavior
```

断一环，就只能写“有 UX/telemetry/CRUD”，不能写“闭环进化”。

### Step 3 — 算法剥皮

把被宣传成“算法”的点分栏：真算法 / LLM judge / 启发式 / 规则 / 外部服务。

硬规则：

- LLM prompt judge 不是算法，除非有独立 eval、score、threshold、rollback。
- Hash update 不是知识过期。
- Usage dashboard 不是生命周期治理。
- Reward 只说明 reward 覆盖的任务类型，不自动证明开放任务能力。

### Step 4 — 反馈链和评价主体

检查谁在判断“更好”：

| 任务类型 | 可接受评价主体 |
|----------|----------------|
| 客观任务：测试、编译、错误修复 | 机器/CI/eval |
| 专业任务：架构、review、审美、产品判断 | 对口专家/peer review |
| 主观/愿景任务：PPT、品牌、方向选择 | CVO/用户明确反馈 |

如果项目把三层都压给同一个模型自评，要明确写风险：它可能能沉淀步骤，但不能证明质量提升。

### Step 5 — 和 Cat Café 对比

不要写“我们有/没有”流水账。每个维度都写价值函数：

- **Learn**：立刻值得学的工程手法。
- **Gap**：我们承认缺口，需要立项或排优先级。
- **Do Not Follow**：我们不做，并写清哲学理由。

### Step 6 — 沉淀

1. 把候选 lesson 写进报告，不直接改全局 lesson，等铲屎官确认。
2. 如果形成稳定方法论，更新本 skill 或相关 skill。
3. docs 产物 commit + push；如果是新 skill，还要跑 `pnpm check:skills` 和 `pnpm sync:skills`。

## Common Mistakes

| 错误 | 后果 | 修正 |
|------|------|------|
| 只看 README/PPT 就下结论 | 被营销话术带跑 | 每个 claim 必须有代码路径 |
| 把“有命令/有 UI”当成“有闭环” | 误判能力成熟度 | 追到 state mutation 和 future behavior |
| 把 LLM judge 当算法 | 高估系统可验证性 | 算法表强制分栏 |
| 把 hash update 当 stale | 混淆上游版本和知识失效 | 分开写 package update / knowledge stale |
| 把 telemetry 当治理 | `last_used_at` 被过度解读 | 看它是否进入排序/淘汰/晋升 |
| 只看源码不看社区 | 错过用户真实痛点和官方 roadmap | 查高赞 issue / bug / enhancement |
| 用”我们没有”替代 tradeoff / 用”对方有”误报为”对方强” | 把设计选择误报成缺口 / 接口齐全度误读为质量 | 写清价值函数 + 用户视角第一性原理（refs/user-mind-evaluation.md）|
| 一只猫写完不找 review | 方法论未经挑战 | skill/report 交对口猫 review |

## 和其他 Skill 的区别

- `deep-research`：多源资料调研；本 skill 是**源码优先的能力审计**。
- `opensource-ops`：社区 issue/PR/intake；本 skill 是**项目架构和宣传真实性拆解**。
- `expert-panel`：多猫观点碰撞；本 skill 是**固定产物和检查项**。
- `writing-skills`：写 skill 的质量纪律；本 skill 可产出候选 skill，但写入时仍要加载 `writing-skills`。

下一步：工程/产品决策 → `collaborative-thinking` 或 `feat-lifecycle`；新 skill/修改 skill → `writing-skills`；外部社区情报 → `deep-research` 或 `opensource-ops`。
