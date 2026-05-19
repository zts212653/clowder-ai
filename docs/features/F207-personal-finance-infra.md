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

#### 设计原则（KD-6, KD-7, KD-8）

1. **Provider orchestration, not provider monogamy** — 分层、分市场、分可信度，不追求单一万能数据源
2. **Convenience layer ≠ truth source** — 免费工具好用但不权威，付费工具权威但覆盖有限
3. **猫猫不直接调裸 provider** — 所有数据源包一层（缓存 + 错误处理 + 来源标签），猫猫调我们的工具

#### v0.1 资产观察清单

| 资产 | 数据需求 | 对应数据域 |
|------|---------|-----------|
| 华为 ESOP | 无公开行情，需分红/估值参考 | 内部文档 + 同行业对标 |
| 沪深 300 / 中证 500 | PE 百分位、日线、成分股 | A 股指数（Tushare） |
| VTI / VXUS / BND | 日线、费率、持仓 | 美股 ETF（yfinance） |
| QQQ / VOO | 日线、费率 | 美股 ETF（yfinance） |
| QDII 基金（待选） | 净值、费率、溢价 | 基金（AKShare） |
| 黄金 ETF（518880 / GLD） | 日线、溢价 | A 股（Tushare）/ 美股（yfinance） |
| 港股科技 ETF（513130） | 日线、溢价 | A 股跨境 ETF（Tushare） |
| **中国国债收益率 / 大额存单利率** | **时间序列（5/30 低风险配置决策急需）** | **中国宏观（AKShare / Tushare）** |
| 美债收益率 / CPI / PMI | 时间序列 | 美国宏观（FRED）/ 中国宏观（AKShare） |
| USD/CNY | 日线 | 汇率（yfinance + FRED） |

#### Provider Stack（四猫共识）

| 数据域 | 主源 | 补洞/Fallback | 预算 |
|--------|------|-------------|------|
| A 股 + 中国证券 | Tushare Pro 2000 分 | AKShare | ~200 元/年 |
| 美国宏观 | FRED API | — | 免费 |
| 美股 + 全球 ETF | yfinance（MCP wrapper） | Alpha Vantage 免费层 | 免费 |
| 中国宏观 | AKShare macro_china_* | Tushare 宏观接口 | 免费 |
| 基金 + QDII | AKShare 基金接口 | Tushare fund_basic | 免费 |
| 汇率 | yfinance CNY=X + FRED DEXCHUS | — | 免费 |

**总预算**：~200 元/年（留 300 元升级余量）

#### 实施：Spike → 三刀切

**B-spike（先验证，再承诺）**：云端报告说能用 ≠ 真能用。在定契约之前，先跑通每个数据源。

| Spike | 验证目标 | 通过标准 |
|-------|---------|---------|
| S1: Tushare | 2000 分能拉沪深 300 日线 + PE + fund_basic + 财报接口 | 返回 DataFrame；asOf ≥ 最近应发布交易日（按 Tushare 各接口 SLA，不以墙钟 24h 一刀切）；验证 fund_basic / fina_indicator 在 2000 分是否可用（OQ-7） |
| S2: FRED | 拉美国 CPI 月度序列（CPIAUCSL） | 返回时间序列，最新月有数据 |
| S3: yfinance | 连续拉 20+ 标的日线 + 费率，间隔重复 3 天 | 不触发封禁/rate limit，数据齐全；验证持续可用性而非单次成功 |
| S4: AKShare | 拉 QDII 净值 + 中国 PMI + 国债收益率 + 大额存单利率，间隔重复 3 天、跨多个接口 | 接口稳定可用（非单次快照）；覆盖基金 + 宏观 + 利率三类 |
| S5: MCP 集成 | FinanceMCP / fred-mcp-server 在 Claude Code 中可调 | 验证 raw provider 连通性（spike 证据）——**不是最终工具面**，B0 会在此基础上包装 `cat-cafe-finance` 事实层 |

**B0 — 定契约 + `cat-cafe-finance` 本地事实层骨架**（spike 通过后）：
- `cat-cafe-finance` 包：统一 schema + provider adapter interface + 缓存 + normalized errors
- 统一 schema（每条数据带 source / asOf / confidence / sourceTier / **snapshot_id**）
- snapshot_id：每次重大查询生成哈希，决策可追溯（5 年后能重现"我当时看到了什么数据"）
- **presentationHint 字段预留**（compactSummary / avoidWords / detailLevel — AUDHD 适配层在 Phase C 填充，B0 先占位）
- **queriesInLast7Days 埋点**（按 ticker 计数，供频率监测护栏读取）
- 错误分类（rate_limited / not_entitled / source_down / schema_drift / no_data）
- 缓存策略（日线按交易日历 TTL；宏观按发布频率；基金 NAV 标注 T+1/T+2 延迟）
- **猫猫只通过 `cat-cafe-finance` 工具查数据，不直接调裸 provider MCP**

**B1 — 接稳定源**：FRED + Tushare（spike 验证最稳的先接）

**B2 — 接脆弱源**：yfinance + AKShare（加缓存 + 重试 + fallback）

**Decision Gate**：如果 spike 发现某数据源不可用（如 Tushare 2000 分不够 / yfinance 被封），重新评估 scope。工作量上限 5 人天。

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

**v0.1 scope（对应 v0.1 资产观察清单）**：
- [ ] AC-B1: 猫猫能查询 v0.1 清单内标的的最新行情（A 股指数 / 美股 ETF / A 股跨境 ETF / 黄金 ETF — 均为交易所 ETF/指数，非个股）
- [ ] AC-B2: 猫猫能查询中美国债收益率 / CPI / PMI / 大额存单利率（宏观时间序列）
- [ ] AC-B3: 猫猫能查询指定基金的净值和费率（QDII + 指数基金）
- [ ] AC-B4: 数据查询结果包含 source + asOf + 置信度；freshness 以各数据源 SLA 为准（日线 ≥ 最近交易日收盘；基金 NAV 允许 T+1/T+2 延迟；月度宏观按发布日历）——不以墙钟 24h 一刀切
- [ ] AC-B5: 所有数据通过 `cat-cafe-finance` 本地事实层返回（统一 schema + 缓存 + 错误处理），猫猫不直接调裸 provider MCP
- [ ] AC-B6: B0 schema 包含 snapshot_id（查询哈希），任意历史查询可通过 snapshot_id 重现当时数据快照
- [ ] AC-B7: B0 schema 预留 presentationHint 字段（AUDHD 适配层占位）+ queriesInLast7Days 按 ticker 埋点（频率监测护栏数据源）

**Phase B 完整目标（v0.1 之后扩展）**：
- [ ] AC-B8: 猫猫能查询港股个股行情（当前 v0.1 仅通过 A 股跨境 ETF 覆盖港股暴露）
- [ ] AC-B9: 猫猫能查询指定公司最近一季财报（公司基本面，v0.1 不含个股）

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
- 数据 freshness SLA violation rate（按各数据源 SLA 判定，非墙钟 24h）

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
| KD-6 | Provider orchestration, not provider monogamy | 三路 deep research + 四猫综合共识 | 2026-05-19 |
| KD-7 | Tushare 2000 分起步（~200 元），留 300 元升级余量 | 四猫投票 3:1（Siamese推荐 5000 分），spike 验证后再决定是否升级 | 2026-05-19 |
| KD-8 | Phase B 先 spike 再定契约 | team lead指令："云端猫猫们说能用真的能用吗？" | 2026-05-19 |

## Review Gate

- Phase A: Maine Coon review（知识 Collection 结构）
- Phase B: Maine Coon + 47 review（provider stack 选型）
- Phase C/D: team lead signoff（报告格式和 AUDHD 护栏）
