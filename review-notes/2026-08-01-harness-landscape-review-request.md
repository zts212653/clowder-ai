---
feature_ids: []
topics: [coding-agent, harness, open-source, landscape]
doc_kind: review_request
created: 2026-08-01
---

# Review Request: Coding Agent Harness Landscape

Review-Target-ID: `research-harness-landscape-20260801`  
Branch: `research/harness-landscape-20260801`  
Research commit: `ba810a838accb0a030b55c9c92eedf57e31003fa`  
PR: `https://github.com/zts212653/clowder-ai/pull/1259`

## What

新增 coding-agent harness 市场调研、统一 research brief 和 34 个 GitHub 仓库的同日元数据快照。报告区分 harness 本体、任务型 harness、平台和上层编排器，并分开标注 OSI 开源、source-available 与专有核心。

## Why

原始需求：在 Claude Code、Codex、Gemini、Hermes、Kimi、OpenCode、AGY、Pi 之外补齐主流 harness，比较能力、优势、劣势和 Stars。  
需求落盘：`project-research/2026-08-01-coding-agent-harness-landscape/prompt.md`

## Tradeoff

- 不做总分排行榜：项目形态不同，Stars 也受年龄和受众影响。
- 能力以官方 README/文档证明“提供或声称”，不把 vendor claim 当效果 benchmark。
- 商业主流项目保留邻接表，但不混进开源源码推荐。

## Open Questions

1. harness / platform / orchestrator 的分类是否存在实质错位？
2. Claude Code、Crush、Copilot CLI 的许可证表述是否足够准确？
3. 是否漏掉会显著改变结论的主流开源 harness？
4. 优势/短板是否有超出一手证据的过强判断？

## Next Action

请独立阅读 `synthesis.md`、抽查 `github-snapshot.csv` 与官方来源，对以上四点给出 APPROVE 或 REQUEST-CHANGES。

## Quality Gate Evidence

- 原始点名项目覆盖：8/8。
- 快照：34 行，0 重复；8 个关键仓库身份复核一致。
- canonical prompt 与 `docs/prompts` 副本 byte-identical。
- `git diff --check` 通过；根目录媒体工件 0。
- CI：Build、Lint、Windows 通过。
- CI baseline blocker 1：10 个既有 Directory Size exceptions 于 2026-07-31 过期；本 PR 未改相关目录或 guard。
- CI baseline blocker 2：既有 public-test exclusion `redis` 于 2026-07-31 过期，resolver fail-closed；本 PR 未改 test config/runtime。
- `/simplify` 已在 PR comment 触发：`#issuecomment-5150346284`。
- Fresh-context：跳过，理由为 docs-only research；正式跨个体 review 不跳过。

## Architecture Ownership

- Architecture cell: none（research evidence only）
- Map delta: none
- Why: 不修改 runtime、API、storage 或 ownership boundary

---

`[砚砚/GPT-5.6🐾]`
