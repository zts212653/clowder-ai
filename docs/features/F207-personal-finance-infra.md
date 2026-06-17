---
feature_ids: [F207]
related_features: [F188]
topics: [finance, knowledge, infrastructure, cron, data-pipeline]
doc_kind: spec
created: 2026-05-18
---

# F207: AI Family Office — 个人投资学习基建

> **Status**: in-progress | **Owner**: Ragdoll | **Priority**: P2

## Why

operator从 2026-04-22 开始投资学习（FIRE / ESOP / Bogleheads 资产配置），目前已完成：
- 财务画像（85%+ 储蓄率、200 万净资产、FIRE 目标 500 万）
- 人生路线图（"任性底气"模型 — 2026-2031 华为任性工作 + 分散化）
- 学习路径设计（5 层 + Layer 0 快照）

但猫猫团队在辅助过程中暴露了一个结构性缺陷：**没有金融数据基础设施**。WebFetch 对金融网站大量 403，模型知识库过时，导致猫猫只能"用老数据坐而论道"。

operator experience（2026-05-18）：
> "我们家要干的第一件事，不是这样疯狂的 webfetch，而是干我们最擅长的事情——基建！"
> "我养猫，猫变成专家！我和猫贴贴！"
> "书不是我学，是你们学。"

operator的愿景不是"自己学理财"，是**养一个 AI 家族办公室**：猫猫是分析师团队，operator是 operator，看报告拍板。

## What

**五层架构**（Phase 0 + 四层），Phase 0 是所有后续层的前置：

### Phase 0: 投资者画像 — Investor Profile

在做任何分析之前，猫猫必须先了解operator是**什么类型的投资者**。不同风格/风险偏好/资产倾向决定了后续所有层的行为。

画像内容：
- 投资风格识别（保守/稳健/进取 — 基于问卷 + 行为观察）
- 风险承受能力（年龄、收入稳定性、负债、心理承受力）
- 资产类别倾向（股票/债券/基金/黄金/房产 — 偏好权重）
- 当前资产配置快照（各类别占比、具体标的、成本基）
- FIRE 参数（目标金额、时间线、年支出、安全边际）
- AUDHD 特质标注（影响操作频率、报告风格、护栏强度）

**数据安全模型**（授权制，类比 GPT/Claude App 银行数据授权流程）：

投资者画像包含个人财务数据（净资产、收入、资产配置），属于**敏感 PII**。安全目标是**数据静态加密 + 访问授权制**——不是"猫猫永远看不到"，而是"operator授权后才能看到"。

- **静态加密**：本地存储文件使用 GPG 或系统级加密（macOS FileVault / 加密卷）——保护场景是物理设备丢失
- **访问授权**：猫猫读取画像数据前需通过 `request_permission` 获得operator授权（类似 OAuth consent）。授权后猫猫可在当前分析会话中使用完整数据（含绝对金额）
- **默认脱敏视图**：未授权时，猫猫只能访问派生摘要（"风险等级=稳健""权益目标区间=40-60%""当前权益偏离=+8%""FIRE 安全边际=充足"），不含绝对金额和具体账户明细
- **报告默认脱敏**：分析报告中默认使用百分比和相对值；operator显式要求时可包含具体数字
- **授权告知**：授权时明确提示"你的财务数据将发送给 [provider name] 的 AI 模型进行分析"

交付物：本地加密的 `investor-profile.json`（或等效结构化文件）+ 对应的 MCP 工具（含 permission gate）。

### Phase A: 知识层 — F188 金融知识 Collection

在 F188 联邦图书馆里新增金融知识 Collection，把operator学习路径里的书和框架结构化为猫猫可查询的知识库。

内容范围：
- README 里列的 5 层学习书单（《金钱心理学》《漫步华尔街》《原则》《黑天鹅》等）
- operator新增的 3 本中国实操书（《解读基金》《指数基金投资指南》《漫步华尔街》）
- 核心框架：Bogleheads 三基金、4% 法则、FIRE 测算、AUDHD 投资护栏
- operator的个人决策文档（trilemma、Layer 0 快照、任性底气模型）

交付物：F188 Library 里一个 `finance` Collection，猫猫用 `search_evidence` 可查到书里的框架和operator的决策历史。

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

#### Provider Stack（spike 后更新 2026-05-20）

| 数据域 | 主源 | 补洞/Fallback | 预算 |
|--------|------|-------------|------|
| 基金 + QDII + 指数估值 + 黄金 + 债券 | **ttfund-skills**（天天基金官方 API） | AKShare 基金接口 | **免费** |
| 美国宏观 | FRED API | — | 免费 |
| 美股 + 全球 ETF | yfinance | Alpha Vantage 免费层 | 免费 |
| 中国宏观（PMI/国债收益率/M2） | AKShare macro_china_* / bond_china_yield | ttfund BOND_MARKET | 免费 |
| 汇率 | yfinance CNY=X + FRED DEXCHUS | — | 免费 |
| A 股个股（如需扩展） | Tushare Pro（可选升级） | — | ~200 元/年 |

**总预算**：**0 元/年**（ttfund spike 通过后 Tushare 降为可选升级，500 元预算全作余量）

> **KD-9**: ttfund-skills 替代 Tushare 成为中国基金/指数估值主源（2026-05-20 spike 验证：沪深 300 PE 百分位 + 成分股 + 行业分布全覆盖）。Tushare 降为可选升级——若operator未来需要 A 股个股财报/交易日历再买。

#### 实施：Spike → 三刀切

**B-spike（先验证，再承诺）**：云端报告说能用 ≠ 真能用。在定契约之前，先跑通每个数据源。

| Spike | 验证目标 | 通过标准 | 状态 |
|-------|---------|---------|------|
| S1: Tushare | ~~2000 分能拉沪深 300 日线 + PE~~ | ~~已被 ttfund 替代~~ | **降级** — ttfund 覆盖指数估值，Tushare 变可选 |
| S2: FRED | 拉美国 CPI 月度序列（CPIAUCSL） | 返回时间序列，最新月有数据 | **PASS** — CPI/美债/联邦利率全通（2026-05-20） |
| S3: yfinance | 连续拉 20+ 标的日线 + 费率，间隔重复 3 天 | 不触发封禁/rate limit，数据齐全 | **PASS**（Day 1 + Day 2 间隔 13 天）— BND/QQQ/VOO/GLD/沪深300 稳定；VTI/VXUS 需用日期范围查询（`period=` 偶发报 delisted）；费率字段 N/A（已知限制） |
| S4: AKShare | 拉 QDII 净值 + 中国 PMI + 国债收益率，间隔重复 3 天 | 接口稳定可用（非单次快照） | **PASS（有条件）**（Day 1 + Day 2 间隔 13 天）— 国债收益率/GDP 连续稳定；LPR Day 1 SSL 挂→Day 2 恢复（暂时性）；Shibor Day 1 失败是参数错误（`上海银行同业拆借市场` 非 `中国银行间`）；CPI Day 2 jin10.com SSL 新暴露。**结论**：东方财富系后端基本可靠，jin10.com 后端不稳定——connector 实现需按后端分 SLA |
| S5: MCP 集成 | `cat-cafe-finance` 本地事实层通过 MCP split server 暴露 | `cat_cafe_finance_query` 在 managed split server 可发现；猫猫不直接调裸 provider | **PASS** — B0 已合入 PR #2071（2026-06-03） |
| **S6: ttfund-skills** | **天天基金官方 API 16 个 skill 端点** | **基金信息/NAV/指数估值/持仓/黄金/债券可用** | **PASS** — Maine Coon验证 3 个端点 + Ragdoll验证指数估值（PE 百分位全覆盖） |

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

operator朋友（蛋散）的实战反馈：Agent 只做数据搬运，分析是人脑做。数据源包括天天基金 skill、腾讯自选股、东方财富、同花顺、金投网。

### Phase C: 分析层 — 定期报告 + 事件触发

猫猫用知识层 + 数据层产出结构化分析：

1. **周报**（cron，每周一早）：市场快照 + 宏观变化 + 对operator配置的影响评估
2. **季度评估**（cron，每季度初）：资产配置再平衡建议 + 置信度 + 证据链
3. **事件捕获**（财经新闻命中operator关注的标的时）：进入 Hub inbox 待阅，**默认不主动 push**。operator可在周报中集中审阅，或显式订阅低频 brief（最多每日 1 条摘要）

所有分析输出必须包含：
- 数据来源 + asOf 时间
- 置信度（高/中/低）
- 证据链（可追溯到数据层的具体查询）
- 明确建议（行动/观望/需要更多信息）

### Phase D: 决策层 — operator 审批工作流

operator（operator）的操作界面：

1. 收到猫猫的分析报告（rich block / 文档）
2. 审阅：同意 / 拒绝 / 追问
3. 如果同意再平衡 → 猫猫生成具体操作清单（"买 X 基金 Y 元"）
4. operator自己执行交易（猫猫不碰交易操作）

**数据源配置管理**（类似 Memory Hub 的前端界面）：
- Connector 开关：启用/禁用各数据源（Tushare / FRED / yfinance / AKShare）
- API key / token 配置：加密存储，前端只显示脱敏后的 `****65e5`
- 数据源状态看板：在线 / 限流 / 过期 / 异常
- Tushare 积分余量 + 年费续费提醒
- 未来扩展：一键添加新 connector（如社区 ttfund-skills）

**硬约束**：Cat Café 不直连任何交易 API——所有交易由operator在券商/银行 App 中自行执行。

AUDHD 护栏设计：
- 默认年度再平衡，不鼓励频繁操作
- 报告简洁，核心结论在前，详细数据在后
- 不推送"紧急"信号（避免触发焦虑/多巴胺追逐）
- 除非偏离阈值超 10%，否则季度报告建议"继续持有不动"
- **24h 冷却期**：任何"建议买入/卖出"操作清单生成后，24 小时内标记为"冷却中"，次日再确认"还想做吗？"
- **Panic 防护**：市场大幅下跌（单日 ≥5% 或累计 ≥15%）时，报告语气强制"持有/观望"基调，禁止传递焦虑（禁用"担心""不利""注意风险"等负面情绪词），正文首行固定为"长期投资者不需要对短期波动做任何操作"
- **频率监测**：检测operator 7 天内查询同一标的 >3 次时，主动提醒"你已经关注 X 多次了，要不要先做点别的？"

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
- [ ] AC-A3: `search_evidence("operator FIRE 决策")` 能找到 trilemma + Layer 0 文档
- [ ] AC-A4: README 中列出的所有书都有对应知识条目

### Phase B（数据层）

**v0.1 scope（对应 v0.1 资产观察清单）**：
- [ ] AC-B1: 猫猫能查询 v0.1 清单内标的的最新行情（A 股指数 / 美股 ETF / A 股跨境 ETF / 黄金 ETF — 均为交易所 ETF/指数，非个股）
- [ ] AC-B2: 猫猫能查询中美国债收益率 / CPI / PMI / 大额存单利率（宏观时间序列）
- [ ] AC-B3: 猫猫能查询指定基金的净值和费率（QDII + 指数基金）
- [ ] AC-B4: 数据查询结果包含 source + asOf + 置信度；freshness 以各数据源 SLA 为准（日线 ≥ 最近交易日收盘；基金 NAV 允许 T+1/T+2 延迟；月度宏观按发布日历）——不以墙钟 24h 一刀切
- [x] AC-B5: 所有数据通过 `cat-cafe-finance` 本地事实层返回（统一 schema + 缓存 + 错误处理），猫猫不直接调裸 provider MCP（B0 / PR #2071）
- [x] AC-B6: B0 schema 包含 snapshot_id（查询哈希），任意历史查询可通过 snapshot_id 重现当时数据快照（B0 / PR #2071）
- [x] AC-B7: B0 schema 预留 presentationHint 字段（AUDHD 适配层占位）+ queriesInLast7Days 按 ticker 埋点（频率监测护栏数据源）（B0 / PR #2071）

**Phase B 完整目标（v0.1 之后扩展）**：
- [ ] AC-B8: 猫猫能查询港股个股行情（当前 v0.1 仅通过 A 股跨境 ETF 覆盖港股暴露）
- [ ] AC-B9: 猫猫能查询指定公司最近一季财报（公司基本面，v0.1 不含个股）

### Phase C（分析层）
- [ ] AC-C1: 每周一自动产出市场周报
- [ ] AC-C2: 每季度初自动产出再平衡评估
- [ ] AC-C3: 报告建议格式为"行动/观望/需要更多信息"三选一，附置信度 + 证据链
- [ ] AC-C4: 分析报告包含"反方观点"章节（对冲模型偏见）

### Phase D（决策层）
- [ ] AC-D1: operator能在 Hub 中看到分析报告并做 approve/reject/追问（追问进入对话循环，最多 3 轮后强制收敛为建议）
- [ ] AC-D2: approve 后生成具体操作清单，标记"冷却中"24 小时，次日确认后才标记为"待执行"
- [ ] AC-D3: 默认无实时 push（事件进 inbox 不主动推送）
- [ ] AC-D4: 报告标题/正文禁止"紧急、立刻、马上买/卖"类措辞
- [ ] AC-D5: 除年度再平衡窗口外，不生成交易操作清单，只生成"观察项"；偏离阈值超 10% 也仅标记为"建议审阅"
- [ ] AC-D6: 所有操作清单必须在 operator approve 后才生成
- [ ] AC-D7: AUDHD 护栏生效（24h 冷却期、Panic 防护、频率监测）

### Negative AC（KD-2 安全边界）
- [x] AC-N1: Finance MCP/工具不暴露任何交易类 API（buy/sell/transfer）（B0 / PR #2071 白名单只读 skill）
- [ ] AC-N2: 分析报告不包含可一键执行的交易指令
- [ ] AC-N3: 报告中提到具体操作时必须使用"由你在 XX App 中执行"而非"我帮你"

## Eval / Tracking Contract

**Primary users + activation signal**：
- operator投资学习（主动查询财经问题）
- 猫猫回答财经相关问题时自动查数据层
- 定期 brief（周报/季度评估进入 inbox）

**Friction metrics**：
- WebFetch fallback 率（数据层 MCP 不可用时退回 WebFetch 的次数）
- 无 source/asOf 的财经回答数（应趋近 0）
- 数据 freshness SLA violation rate（按各数据源 SLA 判定，非墙钟 24h）

**Safety metrics**：
- "紧急/行动"类推送次数（应为 0，除operator显式订阅外）
- approve/reject 比例（reject 过低可能说明 operator 角色错位）
- 无 operator approve 的操作清单生成次数（应为 0）

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
| 猫猫分析质量不可靠（训练数据 ≠ 专家判断） | 所有分析标注置信度 + 强制包含反方观点章节，低置信度建议operator找专业人士 |
| **operator 角色错位**（operator信任猫过头，review 流于形式） | 每季度强制 1 次"盲测"——operator先独立判断，再看猫猫报告，对比偏差 |
| operator可能过度依赖猫猫判断 | Phase D 的 AUDHD 护栏 + 定期提醒"猫是分析师不是基金经理" |
| 中国市场数据获取有法律灰区 | 仅个人使用 + 不公开 + deep research 标注 ToS 风险 |
| F188 知识 Collection 可能还没准备好接入 | Phase A 先确认 F188 当前状态再动手 |
| 数据 cost 失控（多个付费源叠加超 500 元/年） | Deep research 选型时给 cost ceiling，Phase B 逐项标注年费 |
| 模型偏见放大（猫猫可能放大 FIRE 圈乐观偏见） | AC-C4 强制反方观点章节 + 季度盲测对比 |
| **敏感数据泄露**（投资者画像含 PII + 财务数据） | 本地加密存储 + .gitignore + 报告默认百分比 + 禁止云端同步 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 架构分五层（画像/知识/数据/分析/决策） | operator + 三猫讨论收敛 + operator 补充画像层 | 2026-05-18 |
| KD-2 | 猫猫是分析师不是基金经理，交易由operator自己执行 | AUDHD 护栏 + 风险控制 | 2026-05-18 |
| KD-3 | 默认年度再平衡，不做高频操作 | AUDHD 多巴胺护栏 + operator非交易员 | 2026-05-18 |
| KD-4 | 数据层工具选型由 deep research 驱动 | 我们是金融外行，Agent Team Leadership 7 步法 | 2026-05-18 |
| KD-5 | 投资者画像：静态加密 + 授权制访问（类比 GPT/Claude App 银行授权） | 安全目标是设备丢失保护 + 访问需 consent — operator 指令 | 2026-05-18 |
| KD-6 | Provider orchestration, not provider monogamy | 三路 deep research + 四猫综合共识 | 2026-05-19 |
| KD-7 | Tushare 2000 分起步（~200 元），留 300 元升级余量 | 四猫投票 3:1（Siamese推荐 5000 分），spike 验证后再决定是否升级 | 2026-05-19 |
| KD-8 | Phase B 先 spike 再定契约 | operator指令："云端猫猫们说能用真的能用吗？" | 2026-05-19 |
| KD-9 | ttfund-skills 替代 Tushare 成为基金/指数估值主源，Tushare 降为可选升级 | Spike S6 验证：PE 百分位/PB/ROE/行业权重全覆盖 + 官方 API 比 Tushare 稳 + 免费（年预算 200→0 元） | 2026-05-20 |

## Review Gate

- Phase A: Maine Coon review（知识 Collection 结构）
- Phase B: Maine Coon + 47 review（provider stack 选型）
- Phase C/D: operator signoff（报告格式和 AUDHD 护栏）
