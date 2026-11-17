---
feature_ids: [F190]
topics: [architecture, console, navigation, settings]
doc_kind: guide
created: 2026-05-12
---

# Feature Placement Decision Tree

新增前端能力先决定入口层级，再决定组件和路由。

```
New feature:
  L1 Activity Bar    — daily core workflow, use sparingly
  L2 /settings       — management / configuration
  L3 /settings subtab — read-only dashboard or analytics inside a section
  L4 standalone route — unique interaction that needs its own layout
```

## L1-L4 Criteria

| Level | When to use | Approval |
|-------|-------------|----------|
| L1 | Chat, memory, signals, settings 等每日核心入口 | operator decision |
| L2 | 管理、配置、连接器、凭据、偏好设置 | Maintainer decision |
| L3 | 某个 settings section 内的只读视图、监控、排行、日志摘要 | Maintainer decision |
| L4 | 工作流/游戏/设计器等需要独立布局的体验 | Discuss before build |

## Current Settings Section Map

| Section | Content | Keywords |
|---------|---------|----------|
| members | 成员名册、默认协作对象与编排顺序 | cat, roster, member |
| accounts | 模型账户、凭据和执行身份归属 | key, credential, account |
| im | 飞书、钉钉、企微和外部消息入口 | feishu, wecom, connector |
| skills | Skill 管理、安装计划、本地能力预览 | skill, capability |
| mcp | MCP 服务、工具目录和自动化依赖 | MCP, tool |
| plugins | 插件状态、外部集成、安装结果 | plugin, GitHub, email |
| marketplace | 搜索和安装 MCP、Skill、插件等能力包 | marketplace, search |
| voice | 语音输入输出、术语表和 TTS 服务状态 | voice, whisper, TTS |
| system | 环境选项、默认行为和运行时总开关 | env, config, bubble |
| rules | 家规、协作 SOP 和模型提示词入口 | rules, SOP, prompt |
| notify | 推送订阅、提醒策略与设备联动 | push, notification |
| ops | 服务健康、命令工具和运行态观测 | usage, monitoring |

## New Section Checklist

A section is declared in the theme packages, gets its view model and actions from the app layer, and reaches the back end through the host. What each layer owns: [engine](../../packages/web/public/pdl/engine/README.md), [library](../../packages/web/public/pdl/library/README.md), [platform](../../packages/web/public/pdl/platform/README.md), [themes](../../packages/web/public/pdl/themes/README.md).

1. Add the entry to the `nav.settings` slot (`pdl.slots`) in `packages/web/public/pdl/themes/default/theme.yaml`: `id`, `title` (a `t:` copy key), `icon` (a name in `packages/web/public/pdl/library/icons.js`) and `open: { page: <id> }`. Detail pages opened from the section go in its `also` list, so the section stays selected.
2. Declare the page as the view `page.<id>` (`pdl.views`) in the same file: `vm`, `page: true` and `blocks` built from library components. An L3 view goes into the page of the section it belongs to, not into a new entry.
3. Put each `t:` key in `packages/web/public/pdl/themes/<theme>/i18n/zh/*.json` and the same key in `i18n/en/` (a missing key falls back to zh).
4. The v2 theme lists the settings entries in groups: add the id to the group lists next to each `slot: nav.settings` in `packages/web/public/pdl/themes/v2/theme.yaml`. If v2 draws the page with its own components (`themes/v2/components/`), declare its `page.<id>` there too.
5. In `packages/web/public/pdl-app/`, register `PAGES.<id>` (returning `pdlView('page.<id>')`), the view model `VM.<name>` named by `vm`, which shapes back-end data into the blocks' item format, and `A.<name>` for the page's own actions (`act`). Read and write through the `api` facade (`api.get` / `api.post` with back-end paths); the view model marks its source as needed (`projectionNeeded`) and the read runs on `sources:needed`, not on mount.
6. Host code in `packages/web/src/pdl` is only for what the app cannot do through `api`: host-held data in a `use*Bindings.ts` hook wired in `ProjectDataBinding.tsx`, and host-side writes in `settings-actions.ts`, which the app calls with `chatPort.action(name, args)` and `PdlAppHost.tsx` dispatches by name.
7. Add focused tests in `packages/web/src/pdl/__tests__/` for routing, isolation from sibling sections, and existing write-path invariants. Run `pnpm --filter @cat-cafe/web test:smoke` (all of `src/pdl`) while working and `pnpm --filter @cat-cafe/web test` (unit, smoke and guards) before review, and check the page in both built-in themes.

## Deferred High-Risk Areas

External service lifecycle management, refAudio upload, and secret write-back are not placement-only decisions. They are F190 Phase C high-risk slices and need security review plus focused proof.

Chat bubble rendering and read-model behavior are owned by F183/F184/F194. F190 placement work must not touch those surfaces.
