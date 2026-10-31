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

1. Add an entry to `settings-nav-config.ts`.
2. Add keywords in `SettingsNav.tsx`.
3. Add a `SettingsContent.tsx` switch case.
4. Put the section component under `components/settings/`.
5. If the view is an ops subtab, add it to `ops-nav-config.ts`.
6. Add focused tests for routing, isolation from sibling sections, and existing write-path invariants.

## Deferred High-Risk Areas

External service lifecycle management, refAudio upload, and secret write-back are not placement-only decisions. They are F190 Phase C high-risk slices and need security review plus focused proof.

Chat bubble rendering and read-model behavior are owned by F183/F184/F194. F190 placement work must not touch those surfaces.
