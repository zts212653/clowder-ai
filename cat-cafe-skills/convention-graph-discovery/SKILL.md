---
name: convention-graph-discovery
description: >
  约定图发现方法论：进一个 repo 先识别 repo-specific conventions，再定义 domain/extractor 接
  Convention Graph 引擎。Use when: 进入陌生 repo、要画约定图、要找“改 X 影响谁”的约定层关联、
  F242/Convention Graph Layer 工作。Not for: 普通符号跳转/LSP、文档索引检索、记忆图谱、直接使用
  codegraph/GitNexus。Output: domain 定义 + extractor 计划 + gap/freshness/provenance 报告。
  GOTCHA: 沉淀的是“怎么画图”的方法，不是把 cat-cafe 的 extractor 硬搬到所有 repo。
triggers:
  - "约定图"
  - "convention graph"
  - "进陌生 repo"
  - "画规矩地图"
  - "改 X 影响谁"
  - "顺藤摸瓜"
  - "F242"
---

# Convention Graph Discovery

## 价值门禁 / Why This Is a Skill

这是 Cat Café 特有的方法论：把 repo 里的“约定层关联”（MCP tool、skill trigger、route、workflow callback、配置驱动注册）画成带 provenance/freshness 的图。它不是通用 AST 教程，也不是让猫依赖 codegraph/GitNexus；它把 F242 的 dogfood 经验沉淀成未来进 repo 的第一步。

## 核心知识 / Overview

LSP 看符号，grep 看文本；约定图看“这个 repo 的规矩”。每条边必须能回答三件事：它从哪个 source span 来、当前图新不新鲜、漏识别的 gap 在哪。

## When to Use

用在：

- 刚进入陌生 repo，需要先摸清“改 X 会影响谁”。
- 改动触及配置/注册/manifest/route/callback 等约定层，不只是函数调用。
- 改 MCP tool schema/name、skill manifest、FastAPI/API route、workflow callback 前，需要先找约定层消费方。
- F242 / Convention Graph Layer 相关实现、dogfood、review。

不要用在：

- 已经能用 LSP 精确跳转的普通函数调用。
- 只想找文档或历史讨论（用 memory-navigation / memory-search-best-practices）。
- 想把 codegraph/GitNexus 当外部依赖直接接入。
- 只是 cat-cafe 自家 extractor 的硬编码搬运。

## 流程 / Discovery Protocol

1. **定边界**：写清 repo、目标问题、要验证的 convention domain。例：MCP tool 消费方、FastAPI route、skill trigger。
2. **找显式锚点**：优先找名字/ID/typed import/config key/manifest field。禁止 name-only 跨语言合并。
3. **定义 domain**：列 `domainId`、node kinds、edge kinds、extractor inputs、invalidation scope、negative fixtures。
4. **写 extractor**：先用最小 fixture TDD，产出 nodes / edges / gaps。每条 edge 带 extractor/version/sourceFile/sourceLine/confidence。
5. **接引擎**：记录 index commit + indexed file hashes；查询必须带 freshness，pending changes 直接标 stale。
6. **对比基线**：用 grep/LSP 或人工查证对比，记录它们漏了什么、约定图多解释了什么。
7. **报 gap**：发现框架或约定但没覆盖时输出 gap/unknowns，不能静默 0 命中。

## Product Entry / Commands

在 Cat Café repo 根目录，先重建当前 repo 的图：

```bash
pnpm convention-graph:index -- --repo .
```

查某个 MCP tool 的约定层消费方：

```bash
MCP_TOOL_NAME=replace_with_tool_name
pnpm convention-graph:code-consumers -- --repo . --domain mcp-tool --kind mcp_tool --name "$MCP_TOOL_NAME"
```

输出是 JSON，包含 `targets`、`consumers`、每条 edge 的 `provenance`，以及 `freshness`。如果 `freshness.stale=true`，这次查询只能当 stale 证据；先重跑 `convention-graph:index`，再决定影响面。

当前内置 domain：`mcp-tool`、`skill-manifest`、`fastapi-route`。新 repo 的未知约定不要写 ad-hoc 查询脚本；按 Discovery Protocol 定义 domain plugin，再接同一个 CLI/engine。

## Quick Reference

| 阶段 | 必产物 | 不合格信号 |
|------|--------|------------|
| Domain 定义 | domainId / node kinds / edge kinds / invalidation scope | “先写死这三个文件”但没讲泛化 |
| Extractor | fixture + negative fixture + provenance | 同名对象被误连 |
| Query | targets + consumers + freshness | 结果没有 index commit / stale 状态 |
| Report | grep/LSP 对比 + gap 列表 | 0 命中却没解释是否漏识别 |

## Common Mistakes

| 错误 | 后果 | 修复 |
|------|------|------|
| 把 Phase A 的 cat-cafe extractor 当成方法论 | Phase B 进陌生 repo 失败 | 抽成“引擎 + domain plugin + discovery protocol” |
| name-only 消歧 | 前后端同名对象误连 | identity 必含 repo/pkg/lang/file/kind/domainId/name，并要求显式锚点 |
| 静默 0 命中 | 猫以为没有影响面，实际是 extractor 漏识别 | 输出 gap/unknowns |
| 不带 freshness | 猫拿过期图盲改 | 查询结果必须含 index commit + pending changes |
| 把聚类/启发式当 truth | 错边比漏边危险 | 聚类只能做 discovery 提示，authoritative edge 只来自可追源锚点 |

## 验证 / Pressure Test

- 至少两个 domain 通过 fixture：一个结构注册类，一个 manifest/config 类。
- 每个 domain 有 negative fixture，证明同名非约定对象不误连。
- 改一个已索引文件后，查询结果必须 `stale=true` 并列出 pending change。
- 对一个真实“改 X 找消费方”场景 dogfood，写出 grep/LSP 对比差异。

## 和其他 Skill 的区别

- `tdd`：写 extractor 代码时仍要用；本 skill 负责“该画什么图、怎样定义 domain”。
- `knowledge-engineering`：面向文档结构化；本 skill 面向代码约定层。
- `memory-navigation`：找历史知识；本 skill 建当前 repo 的实时工作 artifact。
- `open-source-teardown`：拆外部项目学习；本 skill 把学习结果落成自家 repo 的约定图方法。

## 下一步

Domain 定义收敛后 → `tdd` 写 extractor → `quality-gate` 做 spec/freshness/provenance 自检。
