# Rich Blocks Reference

> 降级自 `rich-messaging` skill。按需查阅。

## 何时用 Rich Block

结构化信息默认用 rich block；随意聊天用纯文本。发 block 前先写 1-2 句自然语言摘要。

**适用场景**：不只是对话！定时任务唤醒、主动触发、connector 通知等场景中，猫同样拥有全部 rich block 能力。

### 用 rich block

| Kind | 场景 |
|------|------|
| card | Review 结论、状态报告、决策摘要 |
| diff | 代码修改建议、重构前后对比 |
| checklist | 待办项、检查清单、验证步骤 |
| media_gallery | 发送已有图片（头像、照片）、截图、设计稿、多图对比 — 不需要现场生成！ |
| audio | 问候、情感表达、定时播报（系统自动合成语音） |
| interactive | 需要用户选择/确认的场景（选方案、选猫、确认操作） |
| html_widget | 数据可视化、自己写的 HTML 面板、交互 demo、mini 工具（沙盒 iframe） |

### 不用 rich block

随意聊天、短回答、技术讨论、不确定用哪种时。

## 字段规格

**关键：字段是 `"kind"` 不是 `"type"`！每个 block 必须有 `"v": 1` 和唯一 `id`。**

| Kind | 必填 | 可选 |
|------|------|------|
| card | title | bodyMarkdown, tone (info/success/warning/danger), fields |
| diff | filePath, diff | languageHint |
| checklist | items (id+text) | title |
| media_gallery | items (url) | title, alt, caption |
| audio | text | — |

### media_gallery 图片 URL 规范

`items[].url` 只接受以下四种格式（路径遍历 `../` 会被 `safeResolve` 拦截）：

| 格式 | 示例 | 说明 |
|------|------|------|
| `/uploads/xxx.png` | `/uploads/opus-happy.png` | **推荐**，文件在 `packages/api/uploads/` |
| `/api/connector-media/xxx` | `/api/connector-media/img.jpg` | 文件在 `data/connector-media/` |
| `data:image/png;base64,...` | 完整 base64 编码 | 小图可用，会自动转临时文件上传 |
| `https://...` | `https://example.com/img.png` | 外部链接 |

**禁止**：`/api/connector-media/../assets/...` 等含 `../` 的路径 — 会被路径遍历保护拒绝，前端裂图。
| interactive | interactiveType, options (id+label) | title, description, maxSelect, allowRandom, messageTemplate |
| html_widget | html | title, height (50-2000, default 300) |

## 创建方式

1. **HTTP Callback（推荐）** — 见 `refs/mcp-callbacks.md` create-rich-block 端点
2. **MCP Tool** — `cat_cafe_create_rich_block`
3. **Inline Text（fallback）**：
````
```cc_rich
{"v":1,"blocks":[{"id":"b1","kind":"card","v":1,"title":"标题","tone":"info"}]}
```
````

优先用 HTTP callback。`cc_rich` 仅在 HTTP 不可用时使用。

### interactive 类型

| interactiveType | 说明 | 用户操作 | 自动发送消息 |
|-----------------|------|---------|-------------|
| select | 单选列表 | 点一个选项 | "我选了：方案 A" |
| multi-select | 多选列表 | 勾选多个→确认 | "我选了：Node.js, pnpm" |
| card-grid | 卡片网格 | 点一张卡片 | "我选了：🎲 猫猫盲盒" |
| confirm | 确认/取消 | 点按钮 | "确认" / "取消" |

- `messageTemplate`：自定义模板，`{selection}` 占位符。例："我选了 {selection} 作为引导猫"
- `allowRandom`：card-grid 显示"🎲 随机抽"按钮
- `maxSelect`：multi-select 最大选择数
- 用户选择后 block 自动变 disabled，选择结果持久化（刷新不丢）

### card tone 语义

| Tone | 用途 |
|------|------|
| info | 一般信息 |
| success | 成功/通过 |
| warning | 需注意 |
| danger | 错误/阻塞 |
