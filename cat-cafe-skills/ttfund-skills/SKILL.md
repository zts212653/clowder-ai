---
name: ttfund-skills
description: >
  天天基金官方 Skills 网关调用封装。
  Use when: 查询天天基金/天天财富基金数据、基金搜索、基金净值、基金持仓、基金经理、指数、黄金、债市、活期宝或官方 ttfund skills。
  Not for: 交易执行、券商/银行账户操作、FRED/Tushare/yfinance/AKShare 结构化数据源、投资建议。
  Output: 通过官方网关返回的结构化 JSON 事实数据，带 source/asOf 后再进入 F207 数据层。
  GOTCHA: 必须有本机 `TTFUND_APIKEY`，且 key 只放环境变量或 gitignored `.env`，绝不写入 git 或回复全文。
triggers:
  - "天天基金 skills"
  - "ttfund"
  - "TTFUND_APIKEY"
  - "天天基金净值"
  - "天天基金搜索"
  - "天天基金经理"
  - "天天基金持仓"
  - "天天黄金"
  - "天天债市"
---

# TTFund Skills

天天基金官方 Skills 是一个 HTTP 网关，不是开源 GitHub 包。所有能力共用 `TTFUND_APIKEY`，调用统一网关：

```text
https://skills.tiantianfunds.com/ai-smart-skill-service/openapi/skill/invoke
```

官方安装说明：`https://skills.tiantianfunds.com/ttfund-skills/ttfund-all-skills.md`

## When to Use

用它查天天基金体系内的基金事实数据：基金信息、历史净值、重仓持仓、基金经理、基金/指数搜索、黄金行情、债市行情、活期宝和模拟组合回测。

不要用它做真实交易、账户读取、买卖建议，也不要替代 FRED / Tushare / yfinance / AKShare 的市场宏观数据职责。F207 里它是基金数据 connector，进入 `cat-cafe-finance` 包装层后才能给分析层使用。

## Quick Reference

```bash
# 列出已知 skill_id 和版本
node cat-cafe-skills/ttfund-skills/scripts/ttfund-call.mjs list

# 基金搜索
node cat-cafe-skills/ttfund-skills/scripts/ttfund-call.mjs FUND_SEARCH \
  '{"query":"沪深300","search_type":"fund","page_index":1,"page_size":5}'

# 基金综合信息
node cat-cafe-skills/ttfund-skills/scripts/ttfund-call.mjs FUND_BASE_INFOS \
  '{"fcode":"000001","nav_range":"n"}'

# 基金净值
node cat-cafe-skills/ttfund-skills/scripts/ttfund-call.mjs FUND_NAV_INFO \
  '{"fund_id":"000001","range":"n"}'
```

脚本会按顺序读取：

1. 当前进程环境变量 `TTFUND_APIKEY`
2. 仓库根目录 `.env`
3. 仓库根目录 `.env`

`.env` 已被 `.gitignore` 忽略；不要把 key 写进任何 tracked 文件。

## Skill IDs

| skill_id | version | 用途 |
|---|---:|---|
| `FUND_BASE_INFOS` | 1.2.0 | 基金综合信息 |
| `FUND_MANAGER_INFO` | 1.0.0 | 基金经理信息 |
| `FUND_CONDITION_SELECT` | 1.1.0 | 条件选基 |
| `FUND_HOLDING_INFO` | 1.0.0 | 基金持仓 |
| `FUND_HUAAN_GOLD_INFO` | 1.0.0 | 黄金行情 |
| `FUND_TG_STRATEGY_INFO` | 1.0.0 | 投顾策略 |
| `FUND_INDEX_INFO` | 1.0.0 | 指数行情 |
| `FUND_NAV_INFO` | 1.0.0 | 基金净值 |
| `MODEL_PORTFOLIO` | 1.0.0 | 模拟组合回测/预览 |
| `FUND_FAVOR_ZX` | 1.2.0 | 自选管理 |
| `BOND_MARKET` | 1.0.0 | 债市行情 |
| `FUND_GROUP_BACKTEST` | 1.0.0 | 组合回测 |
| `FUND_SEARCH` | 1.0.0 | 基金/指数/经理/投顾搜索 |
| `FUND_STOCK_PRICE_QUERY` | 1.0.0 | 股票实时行情 |
| `FUND_THEME_INFO` | 1.0.0 | 基金主题 |
| `FUND_HUOQIBAO_LIST` | 1.0.0 | 活期宝 |

## Common Mistakes

| 错误 | 后果 | 修复 |
|---|---|---|
| 把 API key 写进命令历史、文档或 git | 凭证泄露 | 只放环境变量或 `.env`，回复中只写 masked key |
| 让猫猫直接长期调用裸 ttfund 网关 | 缺 source/asOf/cache/audit | Spike 可以直连；正式 Phase B 走 `cat-cafe-finance` 包装层 |
| 忘记 `_skill_version` | 网关可能拒绝或走旧版本 | 让脚本自动补版本，手写 curl 必须带版本 |
| 把 `MODEL_PORTFOLIO` 当真实交易 | 违反 F207 交易边界 | 只允许模拟/预览，不连接真实交易执行 |
| 把返回数据当投资建议 | 越过分析师边界 | 只作为事实数据，建议必须走 F207 分析/决策护栏 |

## 下一步

F207 B-spike 验证通过后，把这个 connector 纳入 `cat-cafe-finance` 的统一 schema / cache / provenance 层。
