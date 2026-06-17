---
feature_ids: [F147]
related_features: [F041, F190, F056]
topics: [i18n, hub, locale, ui]
doc_kind: spec
created: 2026-03-29
updated: 2026-05-19
---

# F147: i18n — Hub 界面中英文切换

> **Status**: idea | **Owner**: 待定 | **Priority**: P2（operator 2026-05-19 提出需求）

## operator愿景

Hub 界面支持中英文切换。operator本人习惯英文 UI，全量同步后发现大量界面已中文化，希望有切换选项。

## Why

- Hub 界面在 #723 视觉归一化（2026-05-19）后全面中文化（memory/signals/settings/ops 等页面）
- operator本人更习惯英文 UI（"不习惯了"）
- 开源社区（clowder-ai）面向国际用户，英文是基础需求
- 当前无 i18n 框架，UI 文案全部硬编码在组件中

## 现状（2026-05-19 更新）

### 中文化范围（#723 修复带入）

| 页面 | 中文化文件数 | 涉及内容 |
|------|-------------|---------|
| Memory | 12 | 按钮、状态文案、标题、空状态 |
| Signals | 7 | 信号源管理、文章列表、统计卡片 |
| Settings/Skills | 4 | Skill 管理、搜索、分类标签 |
| Ops/Members/System | 若干 | 运维面板、成员管理 |

### 技术现状

- **无 i18n 框架**：所有 UI 文案是 JSX 里的字面字符串
- **无 locale 状态**：没有用户语言偏好存储
- **混合语言**：部分页面仍有英文残留（技术术语、按钮等）
- **sanitizer 不做语言转换**：outbound sync 的 `_sanitize-rules.pl` 只做品牌/端口/路径转换，不管语言

## What

- Hub 前端 UI 支持中/英双语切换
- 语言偏好持久化（localStorage 或用户配置）
- 翻译覆盖关键交互路径（导航、设置、消息面板、Memory、Signals、Ops）

## Acceptance Criteria

- [ ] AC-A1: Hub 支持中文/英文语言切换
- [ ] AC-A2: 用户语言偏好持久化（页面刷新后保持）
- [ ] AC-A3: 切换入口在 Settings 或全局 header 可见
- [ ] AC-A4: 覆盖 Memory/Signals/Settings/Ops 四大页面区域
- [ ] AC-A5: 新增 UI 文案时有机制保证双语同步（lint 或 CI check）

## 技术方案候选

| 方案 | 优点 | 缺点 |
|------|------|------|
| **A: next-intl** | Next.js 官方推荐、SSR 友好、类型安全 | 改动面广（所有组件）、需要 middleware |
| **B: 自建轻量 dict** | 零依赖、渐进式迁移、改动可控 | 自建维护成本、缺生态 |
| **C: react-i18next** | 生态成熟、插件丰富 | 包体积较大、与 Next.js App Router 需要适配 |

## Dependencies

- F041（能力看板）— Hub 框架已成型
- F190（Console Settings）— Settings 页面结构已稳定

## Risk

- 翻译维护成本：每个新 Feature 增加 UI 文案时需同步双语
- 渐进式迁移期间会有中英混杂的过渡态
