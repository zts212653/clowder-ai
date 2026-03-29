/**
 * Rich Block Usage Rules (Progressive Disclosure)
 *
 * F-BLOAT: Extracted from SystemPromptBuilder.MCP_TOOLS_SECTION and
 * McpPromptInjector.buildMcpCallbackInstructions to avoid duplicating
 * ~950 chars in every single invocation prompt.
 *
 * Full rules available via (in priority order):
 *   1. Skill: cat-cafe-skills/rich-messaging/SKILL.md (primary SOT)
 *   2. MCP tool: cat_cafe_get_rich_block_rules (fallback for Claude)
 *   3. HTTP endpoint: GET /api/callbacks/rich-block-rules (fallback for Codex/Gemini)
 *
 * System prompts contain only a short reference.
 */

export const RICH_BLOCK_RULES = `### 富消息块使用规则（B 风格：平衡）

**核心原则**：结构化信息默认用富块，普通对话不用。先写 1-2 句自然语言摘要，再发富块。

**适用场景**：不只是对话！定时任务唤醒、主动触发、connector 通知等场景中，猫同样拥有全部 rich block 能力。

**何时使用**（默认触发）：
- **card** (tone: info/success/warning/danger)
  - review 结论（P1/P2 列表 + 放行/阻塞决策）
  - 任务/阶段状态报告（当前进度、关键指标）
  - 决策摘要（What/Why/Tradeoff）
  - 游戏状态面板（角色信息、回合状态）
- **diff**
  - 代码修改建议（具体的补丁片段）
  - 重构前后对比
- **checklist**
  - 待办事项 / 下一步行动
  - review 要点清单
  - 验证步骤 / 测试计划
- **media_gallery**（图片展示 — 不一定要现场生成！）
  - 发送已有图片（头像 \`/avatars/\`、照片 \`/uploads/\`、设计稿）
  - 截图展示、多图对比
  - 定时任务/主动触发中展示图片
- **audio**（语音消息 — 你"说出来"的话）
  - 打招呼、表达情感、庆祝、鼓励
  - 定时任务中用语音播报（如早安问候、新闻速递）
  - 只填 \`text\`，系统会自动合成语音
  - 不要每条消息都发语音，只在你觉得"说出来比打字更好"时用
- **interactive**（用户可交互选择/确认）
  - 让用户选方案（select/multi-select）、选卡片（card-grid）、确认操作（confirm）
  - \`interactiveType\` + \`options\`(id+label) 必填，\`title\`/\`description\`/\`maxSelect\`/\`allowRandom\`/\`messageTemplate\` 可选
  - option 优先用 \`icon\`（café SVG 图标名）而不是 \`emoji\`。可用图标：sparkle/idea/game/chart/coffee/cat/heart/paw/star/check/cross 等
  - option 可加 \`customInput: true\` + \`customInputPlaceholder\`，选中后展开文本输入框（如"我有其他想法"选项）
  - 发多个 interactive block 时用相同 \`groupId\` 实现批量提交（用户选完所有再一次提交）
  - 用户选择后 block 自动 disabled，选择结果持久化（刷新不丢）
- **html_widget**（内嵌交互 HTML 小组件 — 你自己写的 HTML 直接挂上去）
  - 数据可视化（图表、仪表盘）、交互 demo、mini 工具
  - 定时任务中动态生成数据面板（如 repo 活跃度图表）
  - \`html\` 必填（完整 HTML 文档，含内联 CSS/JS）
  - \`title\` 可选（显示在 widget 顶部标题栏）
  - \`height\` 可选（像素，默认 300，范围 50-2000）
  - 沙盒隔离：allow-scripts 但无 allow-same-origin，无法访问宿主页面

**何时不用**（保持纯文本）：
- 日常聊天、闲聊、打招呼
- 简短回答（一两句话能说清的）
- 技术讨论、长篇回复
- 提问和讨论（除非需要结构化选项）
- 不确定用哪种 → 不用

**字段要求**（⚠️ 注意 kind 不是 type！）：
- 每个 block 必须有 \`"kind"\`（不是 \`"type"\`！）和 \`"v": 1\`，以及唯一 \`id\`
- card: \`title\` 必填，\`bodyMarkdown\`/\`tone\`/\`fields\` 可选
- diff: \`filePath\` + \`diff\` 必填，\`languageHint\` 可选
- checklist: \`items\` 必填（每项需 \`id\` + \`text\`），\`title\` 可选
- media_gallery: \`items\` 必填（每项需 \`url\`），\`title\`/\`alt\`/\`caption\` 可选
- audio: \`text\` 必填（你想说的话，简短口语化，1-2 句）
- interactive: \`interactiveType\` + \`options\` (id+label) 必填，优先用 \`icon\` 不用 emoji，多块用 \`groupId\` 批量提交
- html_widget: \`html\` 必填（完整 HTML），\`title\`/\`height\`(50-2000) 可选`;

/**
 * Condensed rich block reference for injection into system prompts.
 * Full rules: load `rich-messaging` skill (primary).
 * Fallback: MCP tool `cat_cafe_get_rich_block_rules` or HTTP endpoint.
 */
export const RICH_BLOCK_SHORT = `富消息块：结构化信息用富块，普通对话不用。先写 1-2 句摘要再发。
⚠️ 字段名是 "kind"（不是 "type"！），必须有 "v": 1 和唯一 id。
支持: card / diff / checklist / media_gallery / audio / interactive / html_widget。
interactive: 用户可交互选择（select/multi-select/card-grid/confirm），详见 rich-blocks rules。`;
