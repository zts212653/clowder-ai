---
feature_ids: [F218]
related_features: [F086, F192, F203, F200, F152, F163]
topics: [harness-engineering, meta-cognition, source-audit, evidence-quality, search-reliability]
doc_kind: spec
created: 2026-05-31
---

# F218: Evidence Provenance & Source Hygiene — 外部证据溯源与信源卫生

> **Status**: done | **Completed**: 2026-05-31 | **Owner**: Ragdoll | **Priority**: P1

## Why

2026-05-31 operator与Ragdoll讨论《Agent Harness Engineering: A Survey》时，operator四轮追问暴露系统性认知缺陷：猫猫搜到信息后缺少"这东西靠谱吗？"的批判性反射。

具体事件：Ragdoll搬了 Meng et al. survey 的"65% 企业 AI 失败归因 harness 缺陷"和"每步 2% 上下文衰减"——溯源后发现 65% 来自 MemU（卖 AI 记忆产品公司）博客，无 peer-reviewed 来源；多篇博文互引形成回声室被误当"多方验证"；用 2025 年旧模型数据论证 2026 年 Opus 4.6 的能力问题。

三猫圆桌诊断（@opus + @opus47 + @codex）：**失效在触发器缺口，不在能力**——猫被追问时展现了完整批判性能力（追溯营销博客、识别回声室、做代际校验），但日常引用时没有 dispatcher 把批判能力绑到"引用外部数据"这个动作上。

operator experience（2026-05-31）："不能只靠 landy 拉闸——agent 领域我能拉，但如果聊的是达芬奇生平或者博士论文研究，你们交出一份看起来非常有道理实则胡说八道的东西，不是因为你们偷懒，是你们被外部不可靠信息源污染还没警惕。"

这不是幻觉问题（模型自己编），是**外部证据污染问题**（模型被不可靠来源带跑了还没警觉）。搜索结果不是证据，只是候选线索；一旦我们把候选线索写进 research、PPT、ADR，它就会污染后续猫的判断链。

与 F086（元思考）同源：「猫猫缺少元思考，不是能力问题是意识问题」。解法应该是结构化 reflex，不靠自觉、不靠operator在场。

## What

### Phase A: 软+硬+eval 三层防御骨架

三层防御，按"operator不在场也得生效"原则排序：

**1. `source-audit` skill（主防线）**

新 skill，action-bound trigger。触发条件：准备引用外部 claim 且命中高风险特征（数字/百分比、benchmark、因果归因、趋势判断、模型能力对比、医学/金融/论文、会落 docs/ADR/PPT）。

流程：
- 列出要引用的每条数据 → 五问 checklist 逐条评分：
  1. 一手 or 二手？（追到原始论文/官方文档，多处引用 ≠ 多方验证）
  2. 利益冲突？（卖产品方说产品问题严重 = 扣分）
  3. Peer-reviewed or 博客/营销？（博客不能当学术证据）
  4. 时效性？（AI 领域一年=上古，标数据测试年份+模型代际）
  5. 体感校验？（数字跟自家经验不一致 → 追问）
- verdict 四选一：`use` / `use-with-caveat` / `reject` / `escalate-to-deep-research`
- 引用产出必须带 provenance 行

Provenance 格式（Maine Coon提议分级）：
- 聊天：短行 `[一手/二手 | 来源类型 | 数据年份 | 适用对象 | 置信度]`
- docs/research：claim ledger 表
- Hub 可视化：rich block（暂缓，friction 太高）

**2. L0 §2 升级（辅助层）**

把 F203 Phase A placeholder 升级为 ≤150 tokens 信源批判反射触发器。压缩免疫，每次 invocation 都看到——但只能提"我可能要批判"，不能强制做。

**3. `deep-research` 模板升级**

Source Mix 下加四项：Primary Source Trace / Conflict of Interest / Temporal Applicability / Object Applicability。

**4. 已有污染清理** ✅ 已完成（commit 825e11d12）

`evolvable-harness/paper-landscape.md` 和 `gemini-reframing-harness-workspace.md` 中的 65% 叙事已标弱证据或删除。

**5. F192 eval 案例**

给猫一个营销博客互引案例（MemU 事件本身就是完美素材），看是否会追一手来源并拒绝过度结论。挂 F192 capability-wakeup eval domain。

**6. L0 方法论触发（harness = 软+硬+eval）**

把 ADR-031 的 harness engineering 方法论压成一句常驻触发：凡是改 harness / skill / MCP / shared-rules / SOP / L0，不只写软规则，还要同时问硬门禁和 eval 怎么接。软+硬+eval 是体制化门禁，不是这次论文 thread 的私货。

**7. feat-lifecycle Eval Contract 教学升级**

把 `feat-lifecycle` 里的 Eval Contract 从 checklist 升级成教学段落：解释 Soft / Hard / Eval 三层各自承重，要求 harness 类 feature 在 Design Gate 写出三层计划或明确说明为什么某层不适用。

## Acceptance Criteria

### Phase A（三层防御骨架）
- [x] AC-A1: `source-audit` skill 创建，含五问 checklist + verdict 四选一 + provenance 格式规范
- [x] AC-A2: L0 §2 升级为 ≤150 tokens 信源批判反射，compile-system-prompt 测试通过
- [x] AC-A3: `deep-research` 模板 Source Mix 下新增 4 项（Primary Source Trace / CoI / Temporal / Object Applicability）
- [x] AC-A4: F192 eval 案例创建并跑一次 dogfood（用 MemU 事件作为 fixture）
- [x] AC-A5: 已有污染清理完成（commit 825e11d12）
- [x] AC-A6: L0 §2 增加 harness 改动三层触发（软+硬+eval，详见 ADR-031），且不超过 L0 token 预算
- [x] AC-A7: `feat-lifecycle` Eval Contract 门禁升级为 Soft / Hard / Eval 教学段落，覆盖 harness/skill/MCP/shared-rules/SOP/L0 行为变更

## Eval / Tracking Contract

| 字段 | 内容 |
|------|------|
| Primary Users | 所有猫（日常搜索引用场景） |
| Activation Signal | WebSearch/WebFetch 返回结果后，猫在 response 中引用外部数据时触发 source-audit |
| Friction Metric | 引用数据但未标 provenance 的次数（eval 扫描输出文本） |
| Regression Fixture | MemU 65% 事件：给猫一个多源互引的营销数据，看是否追到一手来源 |
| Sunset Signal | 模型原生批判性达到人类 reviewer 水平（标注：当前无量化基线，Build to Persist 倾向） |

## Dependencies

- **Related**: F086（元思考 vision——同源问题）
- **Related**: F203（L0 压缩免疫——§2 升级载体）
- **Related**: F192（harness eval——eval 案例挂载点）
- **Related**: F200（记忆 recall eval——记忆质量与信源质量相关）
- **Related**: F152/F163（记忆治理——已入库知识的可靠性）

## Architecture Ownership

Architecture cell: harness-eval
Map delta: none（扩展 harness-eval cell 的 eval domain 注册）
Why: source-audit skill + eval fixture 挂到 F192 已有的 eval control plane

## Risk

| 风险 | 缓解 |
|------|------|
| L0 加噪音稀释关键信号 | 严格控制 ≤150 tokens；触发反射不放长清单 |
| source-audit skill 变成"每次搜索都跑一遍"的 friction | 触发边界收窄到高风险 claim（数字/benchmark/因果/趋势） |
| 猫绕过 skill 直接引用 | eval fixture 检测绕过行为 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 新建独立 `source-audit` skill，不塞进 `deep-research` | 分级清晰：deep-research 是重流程，source-audit 是中档闸，日常引用需要中间档 | 2026-05-31 |
| KD-2 | 不上 classifier 自动判别"营销 vs 学术" | 违反 KD-8（不用 regex/小模型替猫判断 intent），Cat Cafe meta-aesthetics 反认知脚手架 | 2026-05-31 |
| KD-3 | L0 只放触发反射（≤150 tokens），细则进 skill | L0 token 预算稀缺，加噪音稀释关键信号 | 2026-05-31 |
| KD-4 | 开新 feature 不塞 F203 | scope 横跨 L0/skill/模板/eval/污染清理，塞 F203 会 scope 混乱 | 2026-05-31 |
| KD-5 | Provenance 格式分级：聊天纯文本/docs 表格/Hub rich block 暂缓 | Maine Coon提议，避免 friction 过高 | 2026-05-31 |
| KD-6 | Zero per-family divergence：F218 只改共享层，不改 CLAUDE.md / AGENTS.md / GEMINI.md | 信源卫生和 harness 方法论必须对所有猫生效，不能变成单家族黑话 | 2026-05-31 |
| KD-7 | Harness 类变更默认按软+硬+eval 三层设计 | 软规则负责认知路径，硬门禁负责不靠自觉，eval 负责持续发现退化；方法论来源 ADR-031 | 2026-05-31 |
| KD-8 | L0 真相源修改必须跑 compile-system-prompt L0 测试 | L0 占系统提示词预算，新增内容必须证明压缩免疫收益大于 token 成本 | 2026-05-31 |

## User Visibility Disclosure

| Surface | 用户能做什么（达成态） | 用户实际能做什么（close 时） | 缺失/退化 | 处置 |
|---------|--------------------|--------------------------|----------|------|
| 猫日常 research / docs / ADR / PPT | 高风险外部 claim 触发信源审计并带 provenance | Shared skill + L0 trigger + deep-research refs + `check:source-hygiene` 已接入 | 无直接 UI | met |
| Harness / skill / SOP / L0 设计 | 不只写软规则，同时说明硬门禁和 eval 怎么接 | L0 §2 + `feat-lifecycle` Eval Contract 教学 + hard check + F192 fixture | 无 | met |
| Eval Hub weekly packet | MemU fixture 进入 capability-wakeup eval context | Registry schema 保留 `fixtures`，`buildEvalCatInvocation().context.fixtures` 带入 eval-cat packet | 无 | met |
| Hub provenance rich block visualization | 可视化 provenance rich block | 未交付 | Phase A 不含该 UI surface | KD-5 明确聊天纯文本 / docs 表格先行；不作为 close AC |

## Vision Guardian Verdict

Opus 4.7（非作者、非本地 reviewer）独立复核后 APPROVE close：

- Zero per-family divergence：`CLAUDE.md` / `AGENTS.md` / `GEMINI.md` 零触碰。
- AC-A1..A7 均有代码 / 文档 / 测试锚点。
- `check:source-hygiene` 已进入 `package.json` 和 `scripts/run-checks.mjs`，非空挂。
- 云端 R1 的 eval fixture 断链已修：`evalDomainFixtureSchema` + `fixtures` parser default + invocation context carry-through。
- P1 blocker 数：0。

## CloseGateReport

```yaml
close_gate_report:
  feature_id: F218
  spec_path: docs/features/F218-evidence-provenance-source-hygiene.md
  head_sha: "41a5da40b close sync; 47e10793a base before close"
  report_date: 2026-05-31
  state: done

  guardian:
    cat: "Opus 4.7"
    verdict: approve
    message_id: "0001780244113547-000301-8caf1faa"
    blocker_count: 0

  user_visibility_disclosure:
    status: written
    section: User Visibility Disclosure

  harness_feedback:
    status: written
    path: docs/harness-feedback/2026-05-31-F218-source-hygiene.md
    primary_failure_class: none

  reflection_capsule:
    status: written

  ac_matrix:
    - ac_id: AC-A1
      status: met
      evidence:
        - kind: commit
          ref: "c3f6812a"
          description: "source-audit shared skill with five-question checklist, four verdicts, claim ledger, and provenance format"
        - kind: test
          ref: "scripts/f218-source-hygiene.test.mjs"
          description: "source-audit skill structure and manifest wiring verified by check:source-hygiene"
      resolution: null
    - ac_id: AC-A2
      status: met
      evidence:
        - kind: commit
          ref: "c3f6812a"
          description: "L0 section 2 source hygiene reflex added"
        - kind: test
          ref: "node --test scripts/compile-system-prompt-l0.test.mjs"
          description: "50/50 compiled prompt cases pass under budget"
      resolution: null
    - ac_id: AC-A3
      status: met
      evidence:
        - kind: commit
          ref: "c3f6812a"
          description: "deep-research template Source Mix adds Primary Source Trace / CoI / Temporal / Object Applicability"
      resolution: null
    - ac_id: AC-A4
      status: met
      evidence:
        - kind: commit
          ref: "c3f6812a"
          description: "MemU echo-chamber fixture added and wired into eval:capability-wakeup"
        - kind: commit
          ref: "f2187b38"
          description: "cloud R1 fix carries eval domain fixtures into eval-cat invocation context"
        - kind: test
          ref: "packages/api/test/harness-eval/eval-domain-registry.test.js + eval-cat-invocation.test.js"
          description: "registry preserves fixture refs and invocation context includes them"
      resolution: null
    - ac_id: AC-A5
      status: met
      evidence:
        - kind: commit
          ref: "825e11d12"
          description: "existing 65% pollution cleanup completed before Phase A implementation"
      resolution: null
    - ac_id: AC-A6
      status: met
      evidence:
        - kind: commit
          ref: "c3f6812a"
          description: "L0 section 2 includes harness soft+hard+eval trigger referencing ADR-031"
        - kind: test
          ref: "compile-system-prompt-l0.test.mjs"
          description: "L0 token budget checked for all cat archetypes"
      resolution: null
    - ac_id: AC-A7
      status: met
      evidence:
        - kind: commit
          ref: "c3f6812a"
          description: "feat-lifecycle Eval Contract upgraded with Soft / Hard / Eval teaching"
      resolution: null
```

## Review Gate

- Phase A: 跨族 review（Maine Coon优先，历史连续性——圆桌参与者）
