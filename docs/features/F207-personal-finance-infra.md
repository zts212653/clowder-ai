---
feature_ids: [F207]
related_features: [F188]
topics: [finance, knowledge, infrastructure, cron, data-pipeline]
doc_kind: spec
created: 2026-05-18
---

# F207: AI Family Office — 个人投资学习基建

> **Status**: spec | **Owner**: Ragdoll | **Priority**: P2

## Why

team lead从 2026-04-22 开始投资学习（FIRE / ESOP / Bogleheads 资产配置），目前已完成：
- 财务画像（85%+ 储蓄率、200 万净资产、FIRE 目标 500 万）
- 人生路线图（"任性底气"模型 — 2026-2031 华为任性工作 + 分散化）
- 学习路径设计（5 层 + Layer 0 快照）

但猫猫团队在辅助过程中暴露了一个结构性缺陷：**没有金融数据基础设施**。WebFetch 对金融网站大量 403，模型知识库过时，导致猫猫只能"用老数据坐而论道"。

team experience（2026-05-18）：
> "我们家要干的第一件事，不是这样疯狂的 webfetch，而是干我们最擅长的事情——基建！"
> "我养猫，猫变成专家！我和猫贴贴！"
> "书不是我学，是你们学。"

team lead的愿景不是"自己学理财"，是**养一个 AI 家族办公室**：猫猫是分析师团队，team lead是 CVO，看报告拍板。

## What

**五层架构**（Phase 0 + 四层），Phase 0 是所有后续层的前置：

### Phase 0: 投资者画像 — Investor Profile

在做任何分析之前，猫猫必须先了解team lead是**什么类型的投资者**。不同风格/风险偏好/资产倾向决定了后续所有层的行为。

画像内容：
- 投资风格识别（保守/稳健/进取 — 基于问卷 + 行为观察）
- 风险承受能力（年龄、收入稳定性、负债、心理承受力）
- 资产类别倾向（股票/债券/基金/黄金/房产 — 偏好权重）
- 当前资产配置快照（各类别占比、具体标的、成本基）
- FIRE 参数（目标金额、时间线、年支出、安全边际）
- AUDHD 特质标注（影响操作频率、报告风格、护栏强度）

**数据安全模型**（授权制，类比 GPT/Claude App 银行数据授权流程）：

投资者画像包含个人财务数据（净资产、收入、资产配置），属于**敏感 PII**。安全目标是**数据静态加密 + 访问授权制**——不是"猫猫永远看不到"，而是"team lead授权后才能看到"。

- **静态加密**：本地存储文件使用 GPG 或系统级加密（macOS FileVault / 加密卷）——保护场景是物理设备丢失
- **访问授权**：猫猫读取画像数据前需通过 `request_permission` 获得team lead授权（类似 OAuth consent）。授权后猫猫可在当前分析会话中使用完整数据（含绝对金额）
- **默认脱敏视图**：未授权时，猫猫只能访问派生摘要（"风险等级=稳健""权益目标区间=40-60%""当前权益偏离=+8%""FIRE 安全边际=充足"），不含绝对金额和具体账户明细
- **报告默认脱敏**：分析报告中默认使用百分比和相对值；team lead显式要求时可包含具体数字
- **授权告知**：授权时明确提示"你的财务数据将发送给 [provider name] 的 AI 模型进行分析"

交付物：本地加密的 `investor-profile.json`（或等效结构化文件）+ 对应的 MCP 工具（含 permission gate）。

### Phase A: 知识层 — F188 金融知识 Collection

在 F188 联邦图书馆里新增金融知识 Collection，把team lead学习路径里的书和框架结构化为猫猫可查询的知识库。

内容范围：
- README 里列的 5 层学习书单（《金钱心理学》《漫步华尔街》《原则》《黑天鹅》等）
- team lead新增的 3 本中国实操书（《解读基金》《指数基金投资指南》《漫步华尔街》）
- 核心框架：Bogleheads 三基金、4% 法则、FIRE 测算、AUDHD 投资护栏
- team lead的个人决策文档（trilemma、Layer 0 快照、任性底气模型）

交付物：F188 Library 里一个 `finance` Collection，猫猫用 `search_evidence` 可查到书里的框架和team lead的决策历史。

### Phase B: 数据层 — Finance Provider Stack

**Blocked by**: 三路 deep research 结果回收 + 综合（prompt 已发，2026-05-18）

基于 deep research 结果选定 provider stack，接入数据管道：
- 市场快照（指数/股价/汇率/黄金 — 日线级别）
- 公司基本面（财报/估值/同比）
- 宏观指标（利率/CPI/国债收益率）
- 基金/ETF 数据（净值/费率/持仓）
- 财经新闻索引（标题/摘要/链接，不抓全文）

形态待定（直接 MCP / CLI 包装 / Python bridge），由 deep research 结果决定。

**Decision Gate**：如果 deep research 回收后结论为"现成方案均不满足，需要自建"且工作量 > 5 人天，重新讨论 scope/priority（可能降级为仅覆盖美股+A股两个市场域的 MVP）。

team lead朋友（蛋散）的实战反馈：Agent 只做数据搬运，分析是人脑做。数据源包括天天基金 skill、腾讯自选股、东方财富、同花顺、金投网。

### Phase C: 分析层 — 定期报告 + 事件触发

猫猫用知识层 + 数据层产出结构化分析：

1. **周报**（cron，每周一早）：市场快照 + 宏观变化 + 对team lead配置的影响评估
2. **季度评估**（cron，每季度初）：资产配置再平衡建议 + 置信度 + 证据链
3. **事件捕获**（财经新闻命中team lead关注的标的时）：进入 Hub inbox 待阅，**默认不主动 push**。team lead可在周报中集中审阅，或显式订阅低频 brief（最多每日 1 条摘要）

所有分析输出必须包含：
- 数据来源 + asOf 时间
- 置信度（高/中/低）
- 证据链（可追溯到数据层的具体查询）
- 明确建议（行动/观望/需要更多信息）

### Phase D: 决策层 — CVO 审批工作流

team lead（CVO）的操作界面：

1. 收到猫猫的分析报告（rich block / 文档）
2. 审阅：同意 / 拒绝 / 追问
3. 如果同意再平衡 → 猫猫生成具体操作清单（"买 X 基金 Y 元"）
4. team lead自己执行交易（猫猫不碰交易操作）

**硬约束**：Cat Café 不直连任何交易 API——所有交易由team lead在券商/银行 App 中自行执行。

AUDHD 护栏设计：
- 默认年度再平衡，不鼓励频繁操作
- 报告简洁，核心结论在前，详细数据在后
- 不推送"紧急"信号（避免触发焦虑/多巴胺追逐）
- 除非偏离阈值超 10%，否则季度报告建议"继续持有不动"
- **24h 冷却期**：任何"建议买入/卖出"操作清单生成后，24 小时内标记为"冷却中"，次日再确认"还想做吗？"
- **Panic 防护**：市场大幅下跌（单日 ≥5% 或累计 ≥15%）时，报告语气强制"持有/观望"基调，禁止传递焦虑（禁用"担心""不利""注意风险"等负面情绪词），正文首行固定为"长期投资者不需要对短期波动做任何操作"
- **频率监测**：检测team lead 7 天内查询同一标的 >3 次时，主动提醒"你已经关注 X 多次了，要不要先做点别的？"

## Acceptance Criteria

### Phase 0（投资者画像）
- [ ] AC-01: 存在本地加密的投资者画像文件，包含风格/风险偏好/资产倾向/FIRE 参数
- [ ] AC-02: 画像文件不出现在任何 git tracked 文件中（.gitignore 保护）
- [ ] AC-03: 未授权时猫猫只能访问脱敏派生视图（风险等级/目标区间/偏离度），不含绝对金额
- [ ] AC-04: 授权流程通过 `request_permission` 实现，含明确告知（"你的财务数据将发送给 [provider] 分析"）
- [ ] AC-05: 猫猫能基于画像回答"这个标的是否符合我的配置原则和风险约束？"——输出为 匹配/不匹配/需要更多信息 + 原因 + 反方观点，不直接输出"你适合买/卖"

### Phase A（知识层）
- [ ] AC-A1: F188 Library 中存在 `finance` Collection，至少包含 8 本书的知识条目 + 4 个核心框架条目
- [ ] AC-A2: `search_evidence("bogleheads 三基金")` 能返回结构化框架内容
- [ ] AC-A3: `search_evidence("team lead FIRE 决策")` 能找到 trilemma + Layer 0 文档
- [ ] AC-A4: README 中列出的所有书都有对应知识条目

### Phase B（数据层）
- [ ] AC-B1: 猫猫能查询美股/A 股/港股当日收盘价
- [ ] AC-B2: 猫猫能查询指定公司的最近一季财报
- [ ] AC-B3: 猫猫能查询当前国债收益率/CPI/基准利率
- [ ] AC-B4: 猫猫能查询指定基金的净值和费率
- [ ] AC-B5: 数据查询结果包含 source + asOf + 置信度，数据 freshness 偏差 < 24 小时（日线级别）

### Phase C（分析层）
- [ ] AC-C1: 每周一自动产出市场周报
- [ ] AC-C2: 每季度初自动产出再平衡评估
- [ ] AC-C3: 报告建议格式为"行动/观望/需要更多信息"三选一，附置信度 + 证据链
- [ ] AC-C4: 分析报告包含"反方观点"章节（对冲模型偏见）

### Phase D（决策层）
- [ ] AC-D1: team lead能在 Hub 中看到分析报告并做 approve/reject/追问（追问进入对话循环，最多 3 轮后强制收敛为建议）
- [ ] AC-D2: approve 后生成具体操作清单，标记"冷却中"24 小时，次日确认后才标记为"待执行"
- [ ] AC-D3: 默认无实时 push（事件进 inbox 不主动推送）
- [ ] AC-D4: 报告标题/正文禁止"紧急、立刻、马上买/卖"类措辞
- [ ] AC-D5: 除年度再平衡窗口外，不生成交易操作清单，只生成"观察项"；偏离阈值超 10% 也仅标记为"建议审阅"
- [ ] AC-D6: 所有操作清单必须在 CVO approve 后才生成
- [ ] AC-D7: AUDHD 护栏生效（24h 冷却期、Panic 防护、频率监测）

### Negative AC（KD-2 安全边界）
- [ ] AC-N1: Finance MCP/工具不暴露任何交易类 API（buy/sell/transfer）
- [ ] AC-N2: 分析报告不包含可一键执行的交易指令
- [ ] AC-N3: 报告中提到具体操作时必须使用"由你在 XX App 中执行"而非"我帮你"

## Eval / Tracking Contract

**Primary users + activation signal**：
- team lead投资学习（主动查询财经问题）
- 猫猫回答财经相关问题时自动查数据层
- 定期 brief（周报/季度评估进入 inbox）

**Friction metrics**：
- WebFetch fallback 率（数据层 MCP 不可用时退回 WebFetch 的次数）
- 无 source/asOf 的财经回答数（应趋近 0）
- 数据 freshness 偏差超 24h 的查询占比

**Safety metrics**：
- "紧急/行动"类推送次数（应为 0，除team lead显式订阅外）
- approve/reject 比例（reject 过低可能说明 CVO 角色错位）
- 无 CVO approve 的操作清单生成次数（应为 0）

**Regression fixtures**：
- 美股/A股/港股 quote 可用性
- QDII 基金净值延迟
- 宏观利率/CPI 更新
- 数据源失败时 fallback 切换
- Panic 场景（模拟大跌）语气合规

**Sunset signal**：如果连续 4 周使用率为 0（无主动查询 + 无 brief 审阅），降级为手动查询模式，暂停自动 brief。

## Dependencies

- **Builds on**: F188（图书馆联邦知识系统 — 知识层载体）
- **Blocked by**: Deep research 结果（2026-05-18 已发三路，等待回收）

## Risk

| 风险 | 缓解 |
|------|------|
| 数据源不稳定（yfinance 非官方 API 可能 break） | Phase B 选型时要求每个域有 fallback |
| 猫猫分析质量不可靠（训练数据 ≠ 专家判断） | 所有分析标注置信度 + 强制包含反方观点章节，低置信度建议team lead找专业人士 |
| **CVO 角色错位**（team lead信任猫过头，review 流于形式） | 每季度强制 1 次"盲测"——team lead先独立判断，再看猫猫报告，对比偏差 |
| team lead可能过度依赖猫猫判断 | Phase D 的 AUDHD 护栏 + 定期提醒"猫是分析师不是基金经理" |
| 中国市场数据获取有法律灰区 | 仅个人使用 + 不公开 + deep research 标注 ToS 风险 |
| F188 知识 Collection 可能还没准备好接入 | Phase A 先确认 F188 当前状态再动手 |
| 数据 cost 失控（多个付费源叠加超 500 元/年） | Deep research 选型时给 cost ceiling，Phase B 逐项标注年费 |
| 模型偏见放大（猫猫可能放大 FIRE 圈乐观偏见） | AC-C4 强制反方观点章节 + 季度盲测对比 |
| **敏感数据泄露**（投资者画像含 PII + 财务数据） | 本地加密存储 + .gitignore + 报告默认百分比 + 禁止云端同步 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 架构分五层（画像/知识/数据/分析/决策） | team lead + 三猫讨论收敛 + CVO 补充画像层 | 2026-05-18 |
| KD-2 | 猫猫是分析师不是基金经理，交易由team lead自己执行 | AUDHD 护栏 + 风险控制 | 2026-05-18 |
| KD-3 | 默认年度再平衡，不做高频操作 | AUDHD 多巴胺护栏 + team lead非交易员 | 2026-05-18 |
| KD-4 | 数据层工具选型由 deep research 驱动 | 我们是金融外行，Agent Team Leadership 7 步法 | 2026-05-18 |
| KD-5 | 投资者画像：静态加密 + 授权制访问（类比 GPT/Claude App 银行授权） | 安全目标是设备丢失保护 + 访问需 consent — CVO 指令 | 2026-05-18 |

## Review Gate

- Phase A: Maine Coon review（知识 Collection 结构）
- Phase B: Maine Coon + 47 review（provider stack 选型）
- Phase C/D: team lead signoff（报告格式和 AUDHD 护栏）
