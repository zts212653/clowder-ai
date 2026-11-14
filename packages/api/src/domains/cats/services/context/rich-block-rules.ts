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

**HTML 交付先按用途选**：
- 随当前聊天解释局部的小图或控件用 \`html_widget\`；受托交付的自包含图解/原型，或要反复使用、持续改版的小工具，默认用 \`cat_cafe_work\` 保存作品。篇幅仅作提示，不设像素阈值，小型长期工具也可以是作品；复杂 localhost 应用走 browser-preview。
- widget 也持久保存在聊天历史中并有目录预览；作品增加稳定身份与版本链，作品卡仍回当前 Chat。由猫直接判断，只有真实用途或权限缺口才问，不增加每次选载体的审批卡。
- 新作品用 \`create\`：\`operationId\`、\`title\`、\`changeSummary\` 和 \`source:{kind:"html",html:"完整源码"}\`；保存成功后，用 \`publish-reference\` 携返回的 \`reference\`（\`contentRef\` + \`ownerRevision\`）附固定版本卡。保存与附卡分开；附卡失败重试同一引用，不重交一个版本。保存结果不明先 read/list 核实，必要时重试完全相同的 command/operationId。
- 已有作品先 \`read\` 核当前版本、\`read-body\` 取原版，沿同一 \`contentRef\` 带当前 \`expectedOwnerRevision\`、新 \`operationId\`、\`title\`、\`changeSummary\` 和完整 \`source\` 做 \`submit\`，再附新版卡，不按同名重建。分页保持 command/snapshot 不变，按 nextCursor 拼齐所有 json 后解析。
- widget 后来开始持续迭代：在现有权限内取回原 HTML，以原内容建作品首版并在 changeSummary 记原消息坐标，再沿同一作品出修改版；缺源码/来源先取原件，不捏造旧版。一次修字不必机械升级；已有作品小修仍沿原作品。“请修改”不授予别人的作品写权。操作约定见 rich-messaging skill 与 docs/guides/html-works.md。

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
- **file**（已有文件 / 成片视频）
  - 发送已有文件、导出物、成片视频
  - \`url\` + \`fileName\` 必填，\`mimeType\`/\`fileSize\` 可选
  - \`mimeType\` 以 \`video/\` 开头时，Web UI 渲染内联视频播放器
  - 本地视频使用已可访问 URL（Workspace raw 可展示媒体）；通用文件使用已发布 URL，不要手写 runtime uploads
- **media_gallery**（图片展示 — 不一定要现场生成！）
  - 发送已有图片（头像 \`/avatars/\`、照片 \`/uploads/\`、设计稿）
  - \`/uploads/xxx\` 的磁盘真身是 \`cat-cafe-runtime/packages/api/uploads/\`（运行中 API 的 uploadDir）；不要手动 cp 到源码仓 \`uploads/\` 或 \`packages/api/uploads/\`
  - 图片绝对路径仅在已登记 Workspace 内、文件现存可读且为图片（≤10MiB）时转换为 \`/api/workspace/file/raw?worktreeId=...&path=...\`；其他本机路径明确报错
  - 自动发布仅指原生 image_gen/Antigravity 结果接线；任意富块本机路径不会自动复制到 uploads。持久发布本地 PNG 用 \`cat_cafe_publish_image\`
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
  - 随当前聊天解释局部的数据可视化、控件或数据面板；作品交付按上面的用途路由
  - 定时生成的面板也按用途选；反复使用或持续改版时保存作品
  - \`html\` 必填（完整 HTML 文档，含内联 CSS/JS）
  - \`title\` 可选（显示在 widget 顶部标题栏）
  - \`height\` 可选（像素，默认 300，范围 50-2000）
  - 沙盒隔离：allow-scripts 但无 allow-same-origin，无法访问宿主页面
  - 内联 \`on*\` 事件属性（如 \`onclick=\`）会被消毒剥掉，按钮点了没反应也不报错；改在 \`<script>\` 里用 \`addEventListener\` 绑定（写法见 rich-messaging skill）

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
- file: \`url\` + \`fileName\` 必填，\`mimeType\`/\`fileSize\` 可选；\`video/*\` 会内联播放
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
支持: card / diff / checklist / file / media_gallery / audio / interactive / html_widget。
HTML：随聊天解释局部用 html_widget；交付图解/原型、复用小工具默认 cat_cafe_work 保存并 publish-reference 回 Chat，续改沿原 contentRef。详见 rich-messaging skill / 完整规则。
interactive: 用户可交互选择（select/multi-select/card-grid/confirm），详见 rich-blocks rules。`;
