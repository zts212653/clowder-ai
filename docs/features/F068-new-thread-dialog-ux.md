---
feature_ids: [F068]
related_features: [F063]
topics: [hub, ux, directory-picker, new-thread]
doc_kind: spec
created: 2026-03-06
status: done
completed: 2026-03-12
---

# F068 — 新建对话弹窗 UX 优化

> **Status**: done | **Completed**: 2026-03-12 | **Owner**: 三猫

## Why

team lead反馈"新建对话"弹窗**太难用**：
- 项目目录选择栏太小，底部根本看不到
- 没有文件系统浏览器（Finder 风格），只能在当前目录层级选
- 无法快速跳转到上级或任意目录
- 整体界面不够美观

## What

重新设计"新建对话"弹窗，用**三种入口**覆盖所有场景：

1. **系统原生文件选择器** — 后端通过 `osascript` 调用 macOS 原生 NSOpenPanel（Finder 风格），用户体验与上传文件完全一致
2. **路径输入框** — 常驻输入框，直接粘贴/输入完整路径（如 `/home/user
3. **最近项目快捷入口** — 底部显示历史项目 + 大厅，一键直达

**删除**自建目录浏览器 — 有原生选择器后不再需要。

## Acceptance Criteria

- [x] AC-A1: 本文档需在本轮迁移后维持模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。
- [x] 系统原生选择器：点击「选择文件夹」按钮，弹出 macOS 原生目录选择器（NSOpenPanel），选中后返回绝对路径
- [x] 后端 API：`POST /api/projects/pick-directory`，通过 `osascript -e 'POSIX path of (choose folder)'` 实现
- [x] 路径输入框：常驻显示，支持粘贴完整路径 + 回车/箭头按钮跳转
- [x] 最近项目列表：显示已有项目 + 大厅入口，一键创建对话
- [x] 删除自建目录浏览器（`browseExpanded` 折叠面板等）
- [x] 猫猫选择器保留（现有 CatSelector 组件）
- [ ] 移动端仍可用（响应式，移动端降级为路径输入 + 最近项目）— 待验证
- [x] 视觉设计经team lead确认

## 需求点 Checklist

| # | 需求 | AC 映射 | 状态 |
|---|------|---------|------|
| R1 | 系统原生文件选择器（osascript） | AC-1, AC-2 | ✅ |
| R2 | 路径输入框（常驻） | AC-3 | ✅ |
| R3 | 最近项目快捷入口 | AC-4 | ✅ |
| R4 | 删除自建目录浏览器 | AC-5 | ✅ |
| R5 | 移动端响应式降级 | AC-7 | 🟡 待验证 |
| R6 | 视觉设计确认 | AC-8 | ✅ |
| R7 | 两步创建流程：选项目→填选项→确认 | AC-9 | ✅ |

## Key Decisions

1. **用 `osascript` 调用系统原生选择器** — 因为我们是本地应用（localhost），可以通过后端执行 `osascript -e 'POSIX path of (choose folder)'` 弹出 macOS 原生 NSOpenPanel。Web API (`showDirectoryPicker()`) 无法获取绝对路径，不适用。
2. **删除自建目录浏览器** — 有原生选择器后，自建浏览器体验始终不如系统原生，删掉简化代码。
3. **三入口设计** — 原生选择器（浏览）+ 路径输入（精准）+ 最近项目（快捷），覆盖所有使用场景。

## Dependencies

- **Evolved from**: F063（Hub Workspace Explorer）
- Evolved from: F063 (Hub Workspace Explorer)

## Risk

- Low — 改动集中在一个弹窗组件 + 一个新 API 端点
- `osascript` 仅 macOS 可用，Linux/Windows 部署需降级方案（保留路径输入 + 最近项目）
- 原生选择器是阻塞调用，用户取消时 API 需正确处理超时

## Review Gate

- 视觉设计：team lead确认
- Code review：跨家族 peer review

## Completion

### 愿景三问（跨猫签收）

| 问题 | 结论 | 签收猫 |
|------|------|--------|
| 核心问题是否被解决？ | 是 — 原生 Finder 体验 + 路径直输 + 快捷入口 | gpt52, codex, opus |
| 交付物是否对齐原始需求？ | 是 — team lead"像上传图片那样选文件夹"完全命中 | gpt52, codex, opus |
| team lead实际体验是否改善？ | 是 — 三入口 vs 旧版折叠浏览器 | gpt52, codex, opus |

### 残留项
- R5 移动端响应式降级：当前 Cat Café 仅桌面使用，移动端验证待 F010 手机端功能推进时一并确认

### 反思胶囊
