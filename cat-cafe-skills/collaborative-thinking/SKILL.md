---
name: collaborative-thinking
tips_exempt: "This revision corrects conversation-to-work boundaries and optional settlement in an internal thinking method; it adds no user-openable capability."
description: >
  单人或多猫的创意探索、独立思考、讨论收敛。
  Use when: brainstorm、多猫独立思考、讨论结束需要收敛、方向性问题需要多视角。
  Not for: 已有明确 spec 直接写代码、单猫执行已定方案。
  Output: 共同理解、反例、取舍或结论；需要留存且已获授权时形成设计或讨论记录。
triggers:
  - "brainstorm"
  - "讨论"
  - "多猫独立思考"
  - "收敛"
  - "讨论结束"
  - "总结一下"
---

# Collaborative Thinking

三种按需使用的思考方式：单人探索 / 多猫独立思考 / 讨论收敛沉淀。`feat-lifecycle` 处理 Feature 的需求与设计；这里也容纳尚未指向交付的共同探索。讨论可以停在更清楚的问题、被推翻的假设或未决取舍，不自动产生任务、审批卡或下一阶段。已有明确委托沿原责任推进，不因开始讨论重新采访。

## 核心知识

| 模式 | 何时用 | 何时不用 |
|------|--------|----------|
| **A 单人探索** | 1:1 共同理解问题、探讨想法或设计 | 需要多视角的方向性决策 |
| **B 多猫思考** | 架构选型、流程设计、跨模型互补 | 实现细节、bug 定位（token 成本不值） |
| **C 收敛沉淀** | 任何讨论产出了决策/规则/否决理由 | 纯问答（结论在 thread 里已够）、operator说"不用记" |

## Mode A: 单人探索 (Brainstorm)

**目标**：一起弄清正在关心的问题，允许修正问题本身；到了要交付的地方，再形成可执行范围。

1. **理解上下文**：先恢复相关事实和已有决定。结合语境理解对方是在举反例、开放探索还是委托交付；只澄清会影响当前理解的未知，不把一句想法加工成需求采访。
2. **探索方案**：拿出理由、反例和有意义的备选，允许一起换问题。已进入交付设计时，才据真实需求判断哪些功能值得做。
3. **呈现进展**：把眼前的新理解或具体稿给对方看，说明重要取舍。提问服务真实疑点，不按字数分段索要确认；对方主动参与和猫主动占用注意力的分寸见 [决策准备](../.cat-cafe-shared-refs/decision-matrix.md#交流准备与时机)。
4. **收尾**：可以在当前对话说明所得与尚未确定之处。确有后续消费、需要留存且已有授权时，再写设计或讨论记录；讨论结束不等于授权写文件、commit 或开始实现。

## Mode B: 多猫独立思考

**何时启动 Mode B？** 参见 `../.cat-cafe-shared-refs/shared-rules.md` §13 元思考触发器 A-D。
调 `cat_cafe_multi_mention` 前必须带搜索证据（`searchEvidenceRefs`）。

**⚠️ 成本警告**：Swarm token 消耗是单猫 N 倍（N = 参与猫数）。实现细节不值得开 swarm。

**6 阶段流程**：
```
Phase 1: 独立思考（并行，禁止互看）
Phase 2: 串行讨论（有分歧才触发，限 2-3 轮）
Phase 3: operator选扇入者
Phase 4: 扇入综合（会议纪要 + 行动项）
Phase 5: 其他猫审阅补充（纠正误读）
Phase 6: 有待决事项时请operator参与；有留存需要时进入 Mode C
```

**Phase 1 独立性保护规则（最重要）**：
- 禁止互看：每只猫独立完成，不预测他人观点
- 防锚定：有背景材料时，先形成自己想法再参考
- 展示推理链："我为什么这么想"，不只给结论
- 标注不确定性：区分确信的结论和猜测

实现方式：`routeParallel()` 或operator分别 @ 各猫并强调"先独立思考"。

**Phase 2 触发**：各方基本一致 → 跳过；存在明显分歧 → 需要（限 2-3 轮）；operator说"够了" → 跳过。

**Phase 4 综合必须包含**：各方观点摘要 / 共识区 / **分歧区**（不要抹平！）/ 待决事项 / 行动项。

**Open Questions 分类（必须拆开）**：
- **技术 OQ**：给猫猫解决的（实现细节、方案选型中可回滚的部分）
- **价值 OQ**：需要 operator 判断的 → **必须附 Decision Packet**（格式见 `../.cat-cafe-shared-refs/decision-matrix.md`）

如果所有 OQ 都是技术型且回滚成本低，不升级 operator——猫猫自决 + 事后通报。

**扇入者默认**：Brainstorm 类 → operator；技术讨论 → 指定综合者 + 指定把关者。operator可随时覆盖。

### Mode B 严格档（高 stakes Roundtable）

> 来源：2026-06-16 圆桌 saga（`docs/content/drafts/longform-005-case-the-roundtable-that-caught-itself.md`）。
> ⚠️ **原则强化，不是填表剧本**——写成僵硬步骤就成了 longform-005 批的"演戏"。

**何时启用**：决策**不可逆** / **多方案价值取舍**（非对错题）/ **方向级·跨多 feature**。门槛宜高——日常 plan 走标准 Mode B，别开严格档（仪式化会贬值）。标准 6 阶段之上多守 5 条原则：

1. **沉默 ≠ 同意**（防虚假共识）：高风险条目上，快速全票是危险信号不是高置信；每只猫要么提反例，要么说清"查了什么才不反对"——不是没声音就算过。
2. **价值题不许技术化逃逸**：可 early-exit 退普通 `writing-plans`；但任一猫判某条为价值/不可逆/高风险就不能 exit，且否决须附"理由 + 什么能推翻它"（同时防技术题被反向价值化绑架）。
3. **分歧不抹平**：Phase 5 升为硬门——被代表的猫必须确认分歧没被扇入者写歪。
4. **不无限续命**：复用 Phase 2 的 2-3 轮上限；超限出 split-options 给 operator 或诚实宣告未收敛，不硬凑共识。
5. **收敛接 census**：严格档收敛稿（含 early-exit）handoff 给 `writing-plans` 必带 Stateful Object Gate——圆桌收敛 tradeoff ≠ 完成 census。

**operator 介入**：价值 OQ 最后给 operator，优先**提问**而非表态；表态标"价值偏好"不伪装事实约束。最终方案==operator 初始未公开倾向 → 自检"论证结果还是锚定"（这是 convention 自检；高 stakes 要强制，再升硬层 sealed-commit，别误读成已有机械执法）。

**软硬边界（ADR-031）**：以上是软层原则。"sealed 盲发 / 留痕格式 / 否决 packet schema"要做成可机械检测的强制属硬层（hook/validator），单独立项——别塞进 skill 当填表步骤。

## Mode C: 收敛沉淀 (Convergence)

**收敛时 operator 升级检查**：如果收敛结论中有需要 operator 拍板的 Open Question，必须附 Decision Packet（格式见 `../.cat-cafe-shared-refs/decision-matrix.md`）。先判断可逆性：回滚成本低的猫猫自决，不升级。

先判断这轮是否需要持久留存。没有形成决定、当前对话已足够或只是共同探索时，可以到此结束。已有授权且后续工作确实需要的结论，沿现有真相源更新；不要因为开过讨论就生成三份材料。

**1. 否决理由 → ADR**：已形成且需追溯的架构取舍，补到对应 ADR 的理由段。

**2. 踩坑教训 → 既有教训或回放**：消费真实失败；已有记录够用就引用，不为讨论收尾复制一份。

**3. 判断方法 → 相应 skill/ref**：已接受且授权修订的方法落到猫实际经过的入口，不把探索性意见直接升成 L0 规则。

**追溯**：实际留存的材料指回来源与所服务的工作；已有 Feature/BACKLOG 时更新对应入口，不为获得追溯链另建项目。

**会议纪要模板**（存放：`feature-discussions/YYYY-MM-DD-{topic}-meeting-notes.md`）：
```markdown
# {主题} 讨论纪要
**Thread ID**: `thread_xxx` | **日期**: YYYY-MM-DD | **参与者**: [列出]

## 背景 / 各方观点 / 共识 / 分歧 / 待决 / 行动项
```

## Quick Reference

| 你要做的事 | 用哪个 Mode |
|-----------|------------|
| 帮operator把想法变成 spec | A |
| 几只猫各自看一个架构方向 | B |
| 不可逆 / 价值取舍 / 方向级的重大决策 | **B 严格档** |
| 讨论刚结束，要沉淀 | C |
| Mode B 结束且结论需要留存 | C |

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| 把共同探索或举反例自动变成立项 | 先接住本次对话；有真实推进意图与授权才进入交付 |
| 为了凑备选或固定提问节奏反复确认 | 用实际疑点和取舍决定问什么，复用已清楚的约定 |
| Mode B Phase 1 让猫看到彼此回答 | routeParallel 或分别 @ 并强调独立思考 |
| Mode B 综合时抹平分歧 | 分歧必须保留 + 标注各方理由 |
| Mode B 跳过 Phase 5 审阅 | 综合可能误读观点，原作者必须确认 |
| 严格档写成逐条填表 / 打卡的步骤剧本 | 变成 longform-005 批的"演戏"；skill 只保护原则（沉默≠同意 / 分歧保留 / 接 census），可机械检测的强制归硬层 |
| 收尾默认写文档、commit、开任务 | 先判断留存是否有消费者与授权；当前对话可以就是产物 |
| 已留存的结论没有来源和原工作入口 | 补到原真相源的追溯，不另造平行项目 |

## 下一步

- 共同理解已足够 → 在当前对话结束，可以保留未决问题。
- 已接受且授权的交付 → 沿原工作链；需要实施计划时用 `writing-plans`，需要隔离时用 `worktree`。
- 需要留存结论 → Mode C；获准的文档变更按 `co-creation-docs` 交付。
- 确实决定立项新 Feature → `feat-lifecycle`，不由讨论或一个建议自动触发。
