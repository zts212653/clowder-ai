---
name: enterprise-workflow
description: >
  企业 IM 工作流自动化：文档、表格、待办/任务、会议/日程一键创建。
  Use when: 铲屎官要求创建企微/飞书的文档/表格/待办/会议/日程/幻灯片，或"一句话生成完整工作流"。
  Not for: 普通聊天、消息收发（那是 F088 Transport Plane 的活）。
  Output: 资源链接（文档 URL、企微会议链接、日程 summary 等）通过 callback 返回。
triggers:
  - "创建文档"
  - "写个文档"
  - "create doc"
  - "建个表格"
  - "创建表格"
  - "smart table"
  - "多维表"
  - "bitable"
  - "建个待办"
  - "创建待办"
  - "todo"
  - "创建任务"
  - "task"
  - "约个会"
  - "创建会议"
  - "create meeting"
  - "创建日程"
  - "calendar event"
  - "幻灯片"
  - "slides"
  - "deck"
  - "整理成文档"
  - "拆成任务"
  - "golden chain"
  - "黄金链路"
  - "工作流"
  - "enterprise workflow"
  - "飞书"
  - "feishu"
  - "lark"
  - "企微"
  - "wecom"
  - "企业微信"
---

# Enterprise Workflow — 企业 IM 工作流自动化

F162：通过厂商官方 CLI 驱动企业操作。
架构决策：ADR-029 — ActionService + CliExecutor + callback route。

两条腿并行：
- **Phase A（企业微信）**：`wecom-cli`（Rust）→ callback `/api/callbacks/wecom-action`
- **Phase B（飞书/Lark）**：`lark-cli`（Go，@larksuite/cli）→ callback `/api/callbacks/lark-action`

## 如何选平台

| 铲屎官提到 | 用哪边 |
|-----------|--------|
| 企微 / wecom / 企业微信 / 腾讯 IM | **WeCom** (`/api/callbacks/wecom-action`) |
| 飞书 / feishu / lark / 字节 IM | **Lark** (`/api/callbacks/lark-action`) |
| 只说"企业 IM"没指定 | **先问一句**哪个平台；demo 场景默认 WeCom |

**所有操作都必须走 callback route，不要裸调 CLI**（ADR-029 Decision 2）。

```
POST /api/callbacks/{wecom|lark}-action
Content-Type: application/json

{
  "invocationId": "<your invocationId>",
  "callbackToken": "<your callbackToken>",
  "action": "<action_name>",
  ...action-specific params
}
```

---

## 🟩 WeCom（企业微信）能力

| 操作 | action | 说明 |
|------|--------|------|
| 创建文档 | `create_doc` | Markdown 文档 |
| 创建智能表格 | `create_smart_table` | 自定义字段 + 数据行 |
| 创建待办 | `create_todo` | 分发给指定人员 |
| 创建会议 | `create_meeting` | 预约会议，自动邀请 |
| **黄金链路** | `golden_chain` | 一句话 → 文档 + 表格 + 待办 + 会议 |

### WeCom golden_chain 示例

```json
{
  "action": "golden_chain",
  "docName": "Q2 产品 PRD",
  "docContent": "# Q2 产品规划\n...",
  "tableName": "Q2 任务跟踪表",
  "tasks": [
    { "content": "完成 API 设计", "assigneeUserId": "zhangsan", "remindTime": "2026-04-20 09:00:00" }
  ],
  "meetingTitle": "Q2 PRD 评审会",
  "meetingStart": "2026-04-20 14:00",
  "meetingDurationSeconds": 3600,
  "meetingInviteeUserIds": ["zhangsan", "lisi"]
}
```

### WeCom 单独操作

```json
// create_doc
{ "action": "create_doc", "docName": "会议纪要", "content": "..." }

// create_smart_table
{
  "action": "create_smart_table",
  "tableName": "Bug 跟踪表",
  "fields": [
    { "fieldTitle": "Bug", "fieldType": "FIELD_TYPE_TEXT" },
    { "fieldTitle": "优先级", "fieldType": "FIELD_TYPE_SINGLE_SELECT" }
  ],
  "records": [{ "Bug": "登录超时", "优先级": "P1" }]
}

// create_todo
{ "action": "create_todo", "content": "Review PRD", "followerUserIds": ["zhangsan"], "remindTime": "2026-04-20 09:00:00" }

// create_meeting
{ "action": "create_meeting", "title": "评审", "startDatetime": "2026-04-20 14:00", "durationSeconds": 3600, "inviteeUserIds": ["zhangsan"] }
```

---

## 🟦 Lark（飞书）能力

| 操作 | action | 说明 |
|------|--------|------|
| 创建文档 | `create_doc` | Markdown 飞书文档（docx） |
| 创建多维表 | `create_base` | Bitable 多维表格 app |
| 创建任务 | `create_task` | 任务 v2，支持 assignee + due |
| 创建日程 | `create_calendar_event` | Calendar 事件（lark-cli v1.x 不暴露 VC/meeting URL；需要会议链接时另用 `vc +create`） |
| 创建幻灯片 | `create_slides` | 飞书专属 — 企微 demo 没有 |
| **黄金链路** | `golden_chain` | 一句话 → 文档 + 多维表 + 任务 + 日程（+ 可选幻灯片） |

> Lark 的 assignee 用 `open_id`（`ou_xxx`），日历参会人支持 `ou_xxx`（用户）、`oc_xxx`（群）、`omm_xxx`（会议室）。

### Lark golden_chain 示例

```json
{
  "action": "golden_chain",
  "docTitle": "Q2 产品 PRD",
  "docMarkdown": "# Q2 产品规划\n...",
  "baseName": "Q2 任务跟踪表",
  "tasks": [
    { "summary": "完成 API 设计", "assigneeOpenId": "ou_xxx", "due": "+3d" }
  ],
  "calendarSummary": "Q2 PRD 评审会",
  "calendarStart": "2026-04-20T14:00:00+08:00",
  "calendarEnd": "2026-04-20T15:00:00+08:00",
  "calendarAttendeeOpenIds": ["ou_xxx", "ou_yyy"],
  "includeSlides": true
}
```

### Lark 单独操作

```json
// create_doc
{ "action": "create_doc", "title": "会议纪要", "markdown": "# 纪要\n..." }

// create_base（多维表）
{ "action": "create_base", "name": "Bug 跟踪表", "timeZone": "Asia/Shanghai" }

// create_task
{ "action": "create_task", "summary": "Review PRD", "assigneeOpenId": "ou_xxx", "due": "2026-04-20" }

// create_calendar_event
{
  "action": "create_calendar_event",
  "summary": "评审",
  "start": "2026-04-20T14:00:00+08:00",
  "end": "2026-04-20T15:00:00+08:00",
  "attendeeOpenIds": ["ou_xxx"]
}

// create_slides（飞书专属）
{ "action": "create_slides", "title": "Q2 Deck" }
```

---

## 回贴格式（两边通用）

拿到 callback 返回的链接后，组织成简洁回复：

**WeCom**：
```
已完成工作流创建：

📄 文档: Q2 产品 PRD — https://doc.weixin.qq.com/xxx
📊 表格: Q2 任务跟踪表 — https://doc.weixin.qq.com/yyy
✅ 待办: 2 条已分发（张三、李四）
🎥 会议: Q2 PRD 评审会 — https://meeting.tencent.com/dm/zzz
```

**Lark**：
```
已完成工作流创建：

📄 文档: Q2 产品 PRD — https://feishu.cn/docx/xxx
📊 多维表: Q2 任务跟踪表 — https://feishu.cn/base/yyy
✅ 任务: 2 条已分发
🗓 日程: Q2 PRD 评审会（开始 2026-04-20 14:00）
🎞 幻灯片: Q2 Deck — https://feishu.cn/slides/www
```

## 取用户 ID

- **WeCom**：如果不知道 `userId`，先让 Hub 查通讯录（走 TypeScript import，不走 callback）。demo 场景下用铲屎官自己的 userId。
- **Lark**：`searchUsers` 需要 `contact:contact.search` 授权；没授权就优先拿已知 `open_id`，或铲屎官自己的。

## 注意事项

- **权限**：需要对应应用有 API 权限（文档/表格/待办/会议/通讯录）
- **≤10 人企业限制**（WeCom）：部分功能可能受限，遇到降级处理
- **错误码**：
  - `502 { error: "..., code, msg }`：厂商 API 报错
  - `503 { error: "<cli> unavailable" }`：CLI 未安装或未登录
- **不要裸调 CLI**：审计链会断裂（ADR-029 Decision 2）
- **飞书黄金链路比企微多一层 Slides**（飞书专属），展示时可强调此差异
