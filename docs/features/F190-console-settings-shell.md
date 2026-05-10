---
feature_ids: [F190]
related_features: [F056, F041, F099, F145]
topics: [console, settings, layout, navigation, design-system]
doc_kind: spec
created: 2026-05-07
---

# F190: Console Settings Shell — 全局导航 + 设置面板骨架

> **Status**: Implemented (branch), pending merge | **Owner**: Ragdoll | **Priority**: P0

## Why

team experience:
> "我们的 Hub 承载了太多东西——成员配置、MCP 管理、IM 连接器、信号、记忆全塞在一个模态弹窗里。模态层叠越来越深，每次都要从 Hub 入口钻进去。"

F099 把 Hub 从 3 个 tab 扩到 8 个，但本质问题没变：一个 modal 不该是应用的主导航。需要一个正式的 shell 布局——ActivityBar 全局导航 + Settings 面板替代 Hub modal + 统一设计体系。

## What (PR #662)

- **AppShell**: ActivityBar rail（导航、置顶区、主题切换）+ ThreadSidebar + 内容区三栏布局
- **Settings skeleton**: SettingsShell + SettingsNav 侧边栏，`?s=` 参数路由 12 个 section，占位符内容
- **CSS tokens**: `console-shell.css`、`theme-tokens.css`，语义色变量（`--cafe-*`、`--console-*`、`--semantic-*`）+ 字体 token
- **Tailwind utilities**: `text-caption`、`text-label`、`text-compact`
- **Hook**: `usePinnedSections` 持久化 localStorage 置顶设置区

## Acceptance Criteria

- [x] AC-1: AppShell 三栏布局渲染（ActivityBar + ThreadSidebar + content）
- [x] AC-2: Settings 12 section 通过 `?s=` 路由可达（占位符内容）
- [x] AC-3: CI 全绿（Build/Lint/Test）
- [x] AC-4: 浏览器验证（theme toggle / pinned persistence / ActivityBar referrer）
- [ ] AC-5: 合入 main 后视觉回归验证

## Merge Plan (Two-PR Path)

| PR | 内容 | 状态 |
|----|------|------|
| #662 | F190 AppShell / Settings 骨架 | CI 绿，review 完成 |
| #669 | F190 完整功能迁移（Settings 内容、MCP、marketplace、Mission Hub 等） | CI 绿 |

#662 和 #669 计划同窗口合入。#645 保留为开发基线/参考。

## Dependencies

- F056: 设计 token 契约（被本 feature 迁移和扩展）
- F041: Capability Dashboard（被 Settings 面板整合）
- F099: Hub Navigation Scalability（被 Settings shell 替代）
- F145: MCP Portable Provisioning（MCP 管理面板基于此）

## Risk

- **Dual ThreadSidebar**: AppShell 和 ChatContainer 各有一个 ThreadSidebar，过渡期共存。后续 cleanup PR 跟进移除。
- **Planned API endpoints**: 部分 Settings 面板引用尚未实现的后端路由，前端已就绪，后端跟进。

## Sub-scope: Service Manifest (ML 服务统一管理)

ML sidecar 服务（ASR/TTS/Embedding）从 start-dev.sh 硬编码迁移到声明式 manifest + API 驱动管理。

**已完成**: ServiceManifest 类型 / ServiceConfig 持久化 / service-registry 运行时 / API 路由 (GET/POST /api/services) / ServiceStatusPanel UI / autostart / 启停脚本迁移到 scripts/services/

**待做**: 健康轮询 / 日志流 / 依赖排序 / 模型下载进度

## Open Questions

- ThreadSidebar 去重时机：合入后立即做还是观察一轮？
