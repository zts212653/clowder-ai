---
cell_id: finance-data
title: Finance Data
summary: 金融数据事实层、provider adapter、缓存、snapshot、来源审计与只读查询工具。
canonical_features: []
code_anchors:
  - packages/finance/src/index.ts
  - packages/finance/src/fact.ts
  - packages/finance/src/providers/ttfund.ts
  - packages/finance/src/providers/fred.ts
  - packages/mcp-server/src/tools/finance-tools.ts
doc_anchors:
  - project-research/2026-05-18-finance-provider-stack/synthesis.md
static_scan_hints: [cat-cafe-finance, FinanceFact, snapshot_id, ttfund, FRED, sourceTier, presentationHint, queriesInLast7Days]
cited_by: []
---

# Finance Data

## Canonical Owner

This cell owns the read-only finance data layer: cats query financial facts through a local wrapper that normalizes source metadata, freshness, cache, snapshot replay, and presentation hints before any analysis layer consumes the data.

## Use This When

- Adding or changing market/fund/macro data providers for personal investment learning.
- Adding finance query schemas, provider adapters, snapshot IDs, source attribution, cache TTL, data freshness SLA, query frequency metrics, or finance MCP tools.
- Deciding whether cats can call an external financial data API directly.

## Extend By

- Add a provider adapter under `packages/finance/src/providers/`.
- Normalize every provider response into `FinanceFactEnvelope` before exposing it to cats or MCP.
- Preserve `snapshot_id`, `source`, `asOf`, `sourceTier`, `confidence`, `presentationHint`, and `queriesInLast7Days` as first-class fields.
- Keep API keys in environment/local config only; never persist credentials in snapshots or docs.

## Do NOT Unify With

- Do not put finance provider logic into Memory. Memory retrieves project evidence; Finance Data retrieves current external facts.
- Do not put finance provider logic into Action Plane. Finance Data is read-only and must not mutate external accounts or execute trades.
- Do not expose raw provider MCP tools to cats when `cat-cafe-finance` can provide a normalized envelope.
- Do not connect to broker, bank, buy/sell, transfer, or one-click execution APIs in this cell.

## Static Scan Hints

Watch for new or renamed `FinanceFact`, `snapshot_id`, `sourceTier`, `presentationHint`, `queriesInLast7Days`, `ttfund`, `fred`, `finance_query`, `cat_cafe_finance_query`, and finance provider API clients.
