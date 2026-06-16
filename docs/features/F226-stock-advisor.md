---
feature_ids: [F226]
related_features: [F129, F139]
topics: [stock-advisor, business-agent, skill, scheduled-task, portfolio]
doc_kind: spec
created: 2026-06-12
updated: 2026-06-12
---

# F226: Stock Advisor — 投资助手（基于猫猫能力的定制业务 Agent）

> **Status**: doing (Phase 2) | **Owner**: 宪宪 + 小红
> **Created**: 2026-06-12

## Why

铲屎官需要一个**不侵入系统代码、不占大厅**的股票行情分析和仓位管理助手。这是 Cat Cafe 上第一个"基于猫猫能力构建的定制业务 Agent"——验证 Skill + 状态文件 + 独立 Thread + 定时任务的组合能否承载非 coding 场景。

## What

一个完整的投资助手系统：
- **投资者定义 boundaries（反规则 — 不能做什么）**
- **猫在 boundaries 内自主判断（应该做什么）**
- 定时推送行情分析（开盘 9:35 + 盘后 15:35）
- 持仓状态持久化，跨 session 不丢
- 支持多组合 DIY、多投资人（一人一文件）

## 设计哲学

```
人类定义"不能做什么"（boundaries）
猫负责"应该做什么"（analysis + judgment）
系统记录"做了什么"（ops_log）
时间推动"下次怎么做更好"（eval — 二期）
```

### 权责边界

| 层 | 谁负责 | 内容 | 可变性 |
|---|---|---|---|
| boundaries | 投资者 | 不可逾越的红线 | 很少变 |
| philosophy | 投资者 | 为什么持有（一句话） | 偶尔调 |
| 持仓数据 | 猫维护 | code/shares/amount | 每次操作后更新 |
| 分析判断 | 猫 | 支撑位/驱动因子/买卖时机 | 每次推送实时生成 |
| eval | 猫记录（二期） | 判断质量+教训 | 累积 |

### 投资者不需要定义

- ❌ reference_points（支撑位/阻力位 — 猫自己算）
- ❌ key_drivers（关注哪些因子 — 猫自己判断）
- ❌ rules/triggers（触发条件 — 猫自己决定）

## 三层架构

```
Layer 1: 投资者（Investor）
  ├── 投资风格（自然语言）
  ├── boundaries（红线列表）
  ├── correlation_groups（相关性分组）
  └── 总资产

Layer 2: 持仓组合（Portfolio）× N
  ├── 组合名称 + 风格
  ├── holdings（持仓 + philosophy）
  ├── cash
  └── ops_log（操作记录）

Layer 3: 分析（Analysis — 猫的工作）
  ├── 读 boundaries + holdings + philosophy
  ├── 拉实时行情 + 算指标
  ├── 综合判断 → 建议 + 理由 + 置信度
  └── 自检 boundaries
```

## 技术接入（零代码侵入）

| 组件 | 位置 | 职责 |
|---|---|---|
| 状态文件 | `.cat-cafe/stock-advisor-state.json` | 持仓 + 红线 + 操作记录 |
| Skill | `cat-cafe-skills/stock-advisor/SKILL.md` | 分析方法论 + 输出规范 + 数据源 |
| 独立 Thread | `thread_mqaoirycwxwyfjjj` | 推送和交互的专属空间 |
| 定时任务 | reminder 模板 | cron 9:35 + 15:35 |
| 专属猫 | 青玉（俄罗斯蓝猫）`cat-9qxnn39j` | 投资分析师 |

### 数据源

- 实时行情：腾讯 `qt.gtimg.cn`
- K 线：腾讯 `web.ifzq.gtimg.cn`
- 国际金价/铜价：`hf_GC` / `hf_HG`

### 多投资人方案（B：一人一文件）

```
.cat-cafe/stock-advisor-state.json              ← 默认投资人
.cat-cafe/stock-advisor-state-{id}.json         ← 其他投资人
```

## 状态文件 Schema (V6)

```json
{
  "version": 6,
  "investors": [{
    "id": "string",
    "name": "string",
    "style": "string",
    "total_asset": "number",
    "push_config": {
      "signal_threshold": "watch|action",
      "include_normal_summary": "boolean",
      "max_im_length": "number"
    },
    "boundaries": ["string"],
    "correlation_groups": { "group_name": ["code"] },
    "portfolios": [{
      "id": "string",
      "name": "string",
      "style": "string",
      "holdings": [{
        "code": "string",
        "name": "string",
        "shares|amount": "number",
        "avg_cost": "number (optional)",
        "target_pct": "number (optional)",
        "philosophy": "string",
        "strategy": "object (optional, for structured triggers)"
      }],
      "cash": "number",
      "ops_log": [{"date","code","action","shares|amount_delta","price?","reason"}],
      "strategy_changelog": [{"date","code","field","old_value","new_value","reason","source"}],
      "agent_auto_adjust": {
        "enabled": "boolean",
        "allowed_fields": ["string"],
        "max_adjust_pct": "number",
        "require_changelog": "boolean",
        "require_next_push_report": "boolean"
      }
    }]
  }],
  "monitor": { "schedules", "thread_id", "scheduled_task_ids", "assigned_cat", "intraday_check" }
}
```

## 交互协议

| 投资者说 | 系统做 |
|---|---|
| "我买了 XX N股 价格Y" | 更新 holdings + cash + ops_log |
| "加一只 XX 到主仓" | holdings 加一条 |
| "XX 不要了" | holdings 移除 |
| "建组合：名称，风格，资金" | portfolios 加一项 |
| "红线改一下：..." | 更新 boundaries |
| "推送" / "看看" | 立刻出一份行情分析 |
| "分析 XX" | 单票详细分析 |

## Phase 划分

### Phase 1（一期 — done）

- [x] 状态文件 V4
- [x] Skill 文件
- [x] 独立 Thread
- [x] 定时任务（开盘 + 盘后）
- [x] 新猫"青玉"注册（现改名小红/鸿瑞 cat-9qxnn39j）
- [x] boundaries 哲学确立
- [x] 多投资人方案 B 确认
- [x] 定时推送端到端跑通

### Phase 2（二期 — 当前）

- [x] 盘中异动检测（每 30 分钟轮询 + 阈值触发）
- [x] 多投资人状态文件合并（V5: investors[] 数组）
- [x] 推送分层架构（V6: per-investor 信号过滤 + 判断依据标签）
- [x] 策略可观测机制（strategy_changelog + agent_auto_adjust）
- [ ] Eval 管线（猫建议 → 投资者执行 → 结果反馈 → 长期观察 → 进化）
- [ ] 跨投资人风险汇总
- [ ] ops_log 归档策略（保留近 30 天，更早存独立文件）

### Phase 3（三期）— IM 推送 + 群聊交互 + 权限管理

**依赖**：Cat Cafe 已有 IM 基础设施（F088/F132/F134/F137 全部 done）。

#### 3a: IM 推送（复用 OutboundDeliveryHook）

- [ ] 投资助手 Thread 绑定飞书群 / 钉钉群
- [ ] 定时推送消息自动同步到绑定的 IM 群聊
- [ ] 零代码——只需在 Hub 里配绑定关系

**原理**：猫在 thread 里发的消息通过 F088 OutboundDeliveryHook 自动投递到绑定的 IM connector。

**已验证的 IM 通道**：

| IM | Feature | DM | 群聊 | sender 身份 |
|---|---|---|---|---|
| 飞书 | F088+F134 | ✅ | ✅ | ✅ |
| 钉钉 | F132 | ✅ | ✅ | ✅ |
| 企微 bot | F132 | ✅ | ✅ | ✅ |
| 企微 agent | F132 | ✅ | ✅ | ✅ |
| 微信 iLink | F137 | ✅ | — | ✅ |
| Telegram | F088 | ✅ | — | ✅ |

#### 3b: 群聊双向交互（复用 ConnectorRouter）

- [ ] 群成员 @机器人 "我买了 XX" → 路由到投资助手 thread → 青玉处理
- [ ] 青玉回复自动同步回群聊（@发送者）
- [ ] 支持通过群聊完成：操作记录、新增持仓、建组合

**已有能力**：F134 飞书群聊已验证 @机器人 → 路由 → 回复 @发送者 的完整链路。

#### 3c: 权限管理（新增）

**新增配置文件**：`.cat-cafe/stock-advisor-access.json`

```json
{
  "bindings": [
    {
      "im_platform": "feishu",
      "im_user_id": "ou_xxxxx",
      "im_display_name": "铲屎官",
      "state_file": "stock-advisor-state.json",
      "role": "owner"
    },
    {
      "im_platform": "feishu",
      "im_user_id": "ou_yyyyy",
      "im_display_name": "家人",
      "state_file": "stock-advisor-state-family1.json",
      "role": "member"
    }
  ]
}
```

**权限规则**：
- 每个 IM 用户映射到一个投资人状态文件
- member 只能操作自己的文件
- owner 可以管理所有绑定 + 看所有人持仓
- 未绑定用户发消息 → 回复"请 owner 绑定"

**新增投资人群聊流程**：
1. 群成员 @机器人 "我想加入"
2. 青玉 → @owner "有新成员，需要你确认"
3. owner → "绑定用户C，风格保守，总资产10万"
4. 青玉 → 建 access binding + 新 state file

## 设计迭代历程

| 日期 | 版本 | 关键变化 |
|---|---|---|
| 6/8 | V1 | 固定触发价 + 硬规则 |
| 6/10 | V2 | 左右侧双逻辑 + 量价判断 + 自包含 prompt |
| 6/12 | V3 | 多组合 + 策略解耦（后被否决） |
| 6/12 | V4 | 策略内聚在组合里 → 再精简为 philosophy |
| 6/12 | V4 Final | 删 reference_points + key_drivers + rules；boundaries = 反规则；猫完全自主判断 |

## Key Decisions

1. **boundaries = 反规则**：投资者只定义"不能做什么"，猫负责"应该做什么"。这是人类-Agent 协作的通用权责边界设计。
2. **策略内聚在组合里**：不做独立策略层。组合是自包含的原子单位。
3. **philosophy 而非 rules**：一句话投资逻辑，不是 if-then 触发条件。保留大模型的判断力和进化能力。
4. **方案 B（一人一文件）**：隔离 > 汇总。每个投资人独立文件，互不影响。
5. **轻量级组装优先**：优先用 Skill + 状态文件 + Thread + 定时任务组装。当 eval 闭环需要时，可扩展 F153 adapter / predicates（零代码不是 KD，是早期 tradeoff）。
6. **推送分层（V6）**：按投资人隔离 + 按信号分级过滤（ACTION/WATCH/NORMAL），无信号标的不展示，只计入"其余 N 只正常"。判断依据标签区分策略规则触发 vs agent 自主分析。
7. **策略可观测（V6）**：strategy_changelog 记录每次策略变更（含 source 标签），agent_auto_adjust 允许 agent 在 ±5% 范围内自主微调观察价位（需 changelog + 下次推送汇报）。
8. **agent 自主微调授权**：投资人2 开启 agent_auto_adjust（stop_watch/left_buy_zone/right_buy_above），投资人1 未开启（philosophy 模式不需要结构化策略微调）。
9. **K 线铁律**：没有 K 线数据不做分析。开盘/盘后推送必须拉腾讯 20 日 K 线，算出 MA5/MA20/量比/MACD/成交密集区后再分析。
10. **eval 路径选型**：复用 F192 `eval:sop` 管线（domain-generic from day 1），写 `sop-definitions/stock-advisor.yaml` 定义 stages + hard_rules + predicates，不写独立 adapter。需扩展 2 个通用 predicate types（`content_pattern_predicate` / `file_diff_predicate`），所有未来业务 agent 可复用。

## Eval / Tracking Contract

参考 F192 Phase B Eval Contract 模板（Primary Users / Activation Signal / Friction Metric / Regression Fixture / Sunset Signal）。

### Primary Users
- 铲屎官（接收推送、执行操作）
- 投资人2（接收推送）

### Hard Rules（machine-checkable，每次推送后自检）

| Rule ID | 规则 | 检测方法 | 违规动作 |
|---------|------|---------|---------|
| SA-H1 | 开盘/盘后推送必须使用 K 线数据 | 推送后自检：确认 curl 过 K 线接口 | 补发降级声明到投资助手 thread |
| SA-H2 | 开盘/盘后推送必须发两条（速报+drilldown） | 推送后自检：确认两条 msgId | 立刻补发 drilldown |
| SA-H3 | 速报必须按投资人分层 | 推送后自检：确认含"📊 投资人{N}" | 重发 |
| SA-H4 | 每条 ACTION/WATCH 必须含依据标签+动作+触发 | 推送后自检：逐条检查 | 记录缺失项 |
| SA-H5 | 策略参数变更必须写 strategy_changelog | 推送后检查 state 文件 changelog | 补写 |

### Friction Metrics（weekly eval 聚合）

| 指标 | 数据源 | 预期 |
|------|--------|------|
| 推送合规率 | 自检结果统计 | ≥90% 各项通过 |
| K 线覆盖率 | 自检中 K 线拉取标的数 / 持仓标的数 | 100% |
| Drilldown 覆盖率 | 开盘/盘后推送中有 drilldown / 应有 drilldown | 100% |
| 策略 changelog 完整率 | 实际 strategy 变更 / 有 changelog 记录的 | 100% |

### Eval 执行机制

**两阶段演进**：

**Phase 1（当前）**：skill-level 自检 + thread 回验
1. 每次推送后：小红执行 SKILL.md 中的推送合规自检（SA-H1~H5），输出到当前 thread
2. 周度 eval：scheduled task 唤醒宪宪，读投资助手 thread 近 7 天推送消息，验证自检是否执行 + 合规率统计
3. 局限：自检是软约束，小红可以不执行或输出虚假结果

**Phase 2（eval:sop 接入）**：复用 F192 eval:sop 管线
1. 写 `sop-definitions/stock-advisor.yaml`——定义 data_fetch / push_delivery / state_update 三阶段 + SA-H1~H5 hard_rules + predicates
2. 现有 predicate types 覆盖 SA-H1（command_pattern: K 线 URL）和 SA-H2（command_sequence: post_message 次数）
3. 扩展 2 个通用 predicate types（`content_pattern_predicate` / `file_diff_predicate`）覆盖 SA-H3/H4/H5
4. 注册 `stock-advisor` domain 到 eval:sop registry
5. eval:sop 周度 scheduled task 自动检测 stock-advisor session violations
6. Verdict + Handoff + Re-eval closure 完全复用 E-sop 路径

### Sunset Signal

连续 8 周合规率 100% + 无 friction → 降低 eval 频率到月度。

### Regression Fixtures

| ID | 场景 | 预期结果 |
|----|------|---------|
| RF-1 | 开盘推送未拉 K 线 | SA-H1 violation |
| RF-2 | 盘后推送只发速报没发 drilldown | SA-H2 violation |
| RF-3 | 两个投资人混在一条消息里 | SA-H3 violation |

## Risk

1. 定时推送依赖猫被唤醒后正确加载 skill + 读状态文件。如果 invokeTrigger 失败，推送无输出。
2. 腾讯行情 API 是非官方接口，可能随时变更或被限流。
3. 持仓数据靠投资者主动报告更新，可能和实际券商账户不一致。

## Dependencies

- Cat Cafe 定时任务系统（F139）
- Cat Cafe Skill 体系
- Cat Cafe Thread 系统
- 腾讯行情 API（外部，非 Cat Cafe 控制）
