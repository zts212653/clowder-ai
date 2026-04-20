---
name: schedule-tasks
description: >
  定时任务注册、管理、能力指南。支持周期任务和一次性延迟任务。
  Use when: 用户想设定时任务、定期提醒、周期巡检、定时发送内容、延迟执行一次性操作。
  Not for: 已有 builtin 任务的手动触发。
  Output: 注册/管理定时任务，任务到点唤醒猫执行。
triggers:
  - "定时"
  - "每天"
  - "每小时"
  - "每隔"
  - "提醒我"
  - "remind me"
  - "schedule"
  - "cron"
  - "定期"
  - "周期"
  - "定时任务"
  - "分钟后"
  - "小时后"
  - "之后"
  - "later"
  - "in 5 minutes"
  - "once"
  - "删除"
  - "清理"
  - "移除"
  - "取消"
  - "停掉"
  - "remove"
  - "cancel"
  - "delete"
  - "stop task"
---

# Schedule Tasks — 定时任务注册与管理

用户在对话中表达"定时/定期/每天/提醒我"等意图时，引导他们通过对话注册定时任务。

## 你的能力

被定时任务唤醒后，你拥有**完整的 invocation 能力**——和用户 @ 你一模一样：

| 能力 | 示例 |
|------|------|
| **发图片** | media_gallery rich block（优先用已有图片 `/avatars/`、`/uploads/`） |
| **发语音** | audio rich block（早安问候、新闻播报） |
| **发卡片** | card rich block（状态报告、新闻摘要） |
| **发 HTML 面板** | html_widget rich block（数据可视化、图表） |
| **搜索** | WebSearch / WebFetch / search_evidence |
| **生成图片** | image-generation skill（Chrome MCP → Gemini） |
| **交互选择** | interactive rich block（让用户确认/选择） |

**重要**：不要只发纯文本！被唤醒后主动用 rich block 让输出更丰富。

## 注册流程（对话式，4 步）

### 1. 识别意图

用户说："每天早上 9 点提醒我喝水" / "每小时给我 anthropic 新闻"

### 2. 匹配模板

调用 `cat_cafe_list_schedule_templates` 查看可用模板：

| 模板 | 用途 | 关键参数 |
|------|------|----------|
| `reminder` | 定时提醒（唤醒猫处理提醒内容） | `message`: 提醒内容, `targetCatId`: 唤醒哪只猫（MCP 自动注入当前猫 ID，通常不需手动填） |
| `web-digest` | 网页摘要（定时抓取网页并总结；JS 重站点会唤醒猫走 browser-automation） | `url`: 目标网页, `topic`: 关注主题, `targetCatId`: 浏览器抓取时唤醒哪只猫（MCP 自动注入当前猫 ID，通常不需手动填） |
| `repo-activity` | 仓库动态（追踪 GitHub repo 新 issue/PR） | `repo`: owner/repo |

### 3. 预览确认

调用 `cat_cafe_preview_scheduled_task` 生成 draft，展示给用户确认：

```
模板: reminder
触发: 每天 09:00（cron: 0 9 * * *）
参数: message = "检查 backlog 并汇报进度"
投递: 当前 thread
```

### 4. 注册

用户确认后调用 `cat_cafe_register_scheduled_task` 持久化任务。

## Trigger 语法速查

### 周期触发（recurring）

| 用户说 | trigger JSON |
|--------|-------------|
| 每天早上 9 点 | `{"type":"cron","expression":"0 9 * * *"}` |
| 每小时 | `{"type":"interval","ms":3600000}` |
| 每 30 分钟 | `{"type":"interval","ms":1800000}` |
| 每周一早上 10 点 | `{"type":"cron","expression":"0 10 * * 1"}` |
| 每 5 分钟 | `{"type":"interval","ms":300000}` |

### 一次性触发（once — #415）

| 用户说 | trigger JSON |
|--------|-------------|
| 2 分钟后提醒我 | `{"type":"once","delayMs":120000}` |
| 1 小时后查天气 | `{"type":"once","delayMs":3600000}` |
| 30 秒后通知我 | `{"type":"once","delayMs":30000}` |

一次性任务执行后会**自动退役**（从 runtime 注销 + 从 SQLite 删除），不会重复触发。
路由层会将 `delayMs` 归一化为绝对时间 `fireAt`（epoch ms），确保重启后触发时间不漂移。

## 管理

| 操作 | 工具 |
|------|------|
| 查看所有任务 | SchedulePanel（Workspace 调度 Tab）|
| 暂停/恢复 | SchedulePanel UI（目前无 MCP 工具，只能在面板操作） |
| 删除 | `cat_cafe_remove_scheduled_task` |
| 手动触发 | SchedulePanel UI "立即执行" 按钮（目前无 MCP 工具） |

### 删除流程（3 步）

用户说"删除/清理/取消定时任务"时：

1. **确认目标** — 调用 `cat_cafe_list_tasks` 或让用户在 SchedulePanel 中查看，确认要删除的任务 `taskId`
2. **用户确认** — 展示任务详情（名称、触发规则、上次执行），让用户确认删除
3. **执行删除** — 调用 `cat_cafe_remove_scheduled_task`（参数：`taskId`），删除后告知用户结果

## 常见错误

| 错误 | 正确做法 |
|------|----------|
| 不知道能注册定时任务 | 用户说"每天/定期/提醒"→ 匹配本 skill |
| 被唤醒后只发纯文本 | 主动用 rich block（图片、语音、卡片、HTML） |
| 跳过 preview 直接注册 | **必须** preview → 用户确认 → 注册 |
| 发图只想到 image-generation | 先看 `/avatars/`、`/uploads/` 有没有现成图 |

## 和其他 skill 的区别

- `rich-messaging`: 如何发富媒体 — 本 skill 侧重何时/如何注册定时任务
- `worktree` / `tdd`: 开发工具 — 本 skill 是用户面向的功能
