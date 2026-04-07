---
feature_ids: [F063]
related_features: [F060, F058]
topics: [hub, ux, workspace, file-browser, code-preview, collaboration]
doc_kind: spec
created: 2026-03-05
---

# F063: Hub Workspace Explorer — team lead不用打开 IDE 也可以和猫猫们优雅协作

> **Status**: done | **Owner**: Ragdoll (Opus 4.6, Leader)
> **Created**: 2026-03-05
> **Completed**: 2026-03-09

## Why

team lead和猫猫是**共创伙伴**，但目前协作时team lead被挡在 IDE 门外：

1. 猫猫说"看 `codex-event-transform.ts:172`"→ team lead要切 WebStorm、搜文件、找行号、读不是自己写的代码
2. 猫猫改了 spec/提示词模板 → team lead要去 IDE 翻文件才能看到内容
3. 遇到反复出现的系统问题需要team lead协助梳理时 → "所有和提示词注入有关的代码在哪？"要猫猫回答或自己搜关键词
4. 审计日志/session 事件目前只能在 VSCode 里看，team lead帮忙定位问题需要在 IDE 和 Hub 之间反复切换

**核心判断**：Claude.ai 的 Project Context + Artifacts 能力证明了"在对话旁边直接操作文件和预览"是可行的。以前做这个要人类开发一个月，现在猫猫一天就能做——**没有理由先做临时方案再做正式方案**（team experience："绕路了"）。

## What

### Phase 1: Workspace File Explorer（P0）

在 Hub 侧边栏或面板中展示当前仓库的文件系统：

1. **文件树浏览**
   - 当前猫猫所在仓库的目录树（如 `cat-cafe/`、`dare-framework/`）
   - 展开/折叠目录，点击查看文件内容
   - 文件图标按类型区分（.ts/.md/.json/.png 等）

2. **文件内容查看**
   - 代码文件：语法高亮 + 行号
   - Markdown 文件：渲染后展示（或 raw + rendered 双模式）
   - 图片文件：直接预览
   - 大文件：按需加载（只加载可视区域）

3. **搜索**
   - 全文搜索：输关键词 → 搜遍仓库 → 返回匹配文件+行号+上下文
   - 文件名搜索：快速定位（fuzzy match）
   - team lead的典型用法："所有和提示词注入有关的代码" → 搜 `system prompt` / `SystemPromptBuilder` → 直接看结果

4. **猫猫联动**
   - 猫猫提到文件路径/行号时 → Hub 自动识别 → 点击跳转到文件内容面板
   - 猫猫发 `diff` rich block → 点击可在文件面板中查看完整文件上下文
   - team lead在文件面板中选中代码 → 可直接引用到对话中问猫猫

### Phase 2: Code Preview & Rendering（P0-P1，与 Phase 1 不冲突就并行）

在 Hub 中直接渲染前端代码预览：

1. **HTML/JSX 预览**
   - 猫猫输出的 React/HTML 组件 → 在 Hub 内 iframe sandbox 渲染
   - 类似 Claude.ai Artifacts 的实时预览能力
   - 支持 Tailwind CSS（我们的设计系统基础）

2. **设计稿预览**
   - `.pen` 文件 → 调用 Pencil MCP 渲染预览
   - 图片文件 → 直接展示
   - SVG → 直接渲染

3. **Diff 可视化**
   - 文件变更的 side-by-side 或 unified diff 视图
   - 比 rich block 里的纯文本 diff 更易读

### Phase 3: Runtime & Audit Explorer（P1）

运行时数据的查看能力：

1. **Session 事件查看器**
   - 当前已在 VSCode 中以"109 条事件 · 24 个日志文件"方式查看
   - Hub 内提供同等查看体验 + 过滤/搜索
   - 和对话上下文联动（"这个 session 出了什么问题？"→ 直接看事件）

2. **日志浏览**
   - API 日志、agent 日志按时间线展示
   - team lead协助定位问题时不需要切到 VSCode

3. **上传文件管理**
   - runtime 的 uploads 目录浏览
   - 图片预览、文件下载

## Technical Direction

### 后端：文件系统 API（Maine Coon安全模型 v1）

**API 端点**：

```
GET  /api/workspace/tree?worktreeId={id}&path={dir}&depth={n}
GET  /api/workspace/file?worktreeId={id}&path={filePath}
POST /api/workspace/search  { worktreeId, query, type: "content"|"filename", limit }
PUT  /api/workspace/file    { worktreeId, path, content, baseSha256, editSessionToken }
```

**Worktree 映射**：服务端用 `git worktree list --porcelain` 建映射 `worktreeId → realRoot`，前端只传 `worktreeId`，**绝不接受前端传绝对路径**。

**P0 安全模型（Maine Coon review 通过的强约束）**：

1. **路径遍历防护**：`resolve(realRoot, userPath)` → `realpath` → 必须满足 `target.startsWith(realRoot + path.sep)`，否则 403
2. **符号链接逃逸防护**：读写都做 `lstat + realpath`，跨根 symlink 直接拒绝
3. **默认只读**：编辑模式需显式开启（UI toggle），签发短期 `edit_session_token`（30 分钟有效）
4. **敏感文件 denylist**（读写都拦）：`.env*`、`*.pem`、`*.key`、`id_rsa*`、`.git/**`、`**/secrets/**`
5. **大文件/二进制限制**：文本查看上限 1MB，超限只给摘要；二进制不走文本编辑接口
6. **并发控制**：写入必须带 `baseSha256`，不一致返回 `409 Conflict`
7. **全链路审计**：`workspace_file_read / search / write / conflict / denied` 全记录（threadId、worktreeId、path、actor）

**搜索后端**：Phase 1 直接用 `grep -r`（受限于 worktree root），关键词长度和结果条数有上限。后续评估是否需要索引。

### 前端：UX 设计（Siamese提案 + team lead拍板）

**布局：「猫咖全景工坊」**

```
┌─────────────────────────────────────────────────────┐
│  顶栏  [Thread列表] [Thread名]  ... [📁 Workspace]  │
├──────────────────────┬──────────────────────────────┤
│                      │  🌿 feat/f060  (worktree)    │
│                      │  ┌──────────────────────────┐│
│    💬 聊天区域        │  │ 📂 packages/             ││
│    (50%)             │  │   📂 api/src/             ││
│                      │  │     📄 codex-event-...    ││
│                      │  │   📂 hub/src/             ││
│  猫猫消息            │  ├──────────────────────────┤│
│  [file:172] ← 可点击  │  │ codex-event-transform.ts ││
│                      │  │ 172│ const imageItems =   ││
│                      │  │ 173│   contentArr.filter  ││
│                      │  │     ← 高亮跳转到此行      ││
│                      │  │                    [编辑🔓]││
├──────────────────────┴──────────────────────────────┤
│  输入框                                              │
└─────────────────────────────────────────────────────┘
```

**交互细节**：

| 元素 | 设计 | 来源 |
|------|------|------|
| 顶栏按钮 | 📁 图标，点击切换分栏显示/隐藏 | team lead拍板 |
| Worktree 指示器 | 文件面板顶部醒目标签：`🌿 feat/f060` + branch + short sha | Maine Coon(安全)+Siamese(UX) |
| 文件树 | 极简风格，悬浮显示操作按钮，类型图标区分 | Siamese |
| 编辑器 | **CodeMirror 6**（轻量、可扩展、语法高亮+行号） | Siamese提议 |
| 只读/编辑切换 | 默认只读🔒，点击切换编辑🔓（签发 edit_session_token） | Siamese(UX)+Maine Coon(安全) |
| 文件路径联动 | 聊天中 `file:line` 格式自动变为可点击链接 → 右侧跳转高亮 | Siamese |
| 正在编辑指示 | 文件图标旁显示 🐾（team lead）或猫猫头像 | Siamese |
| 代码引用 | team lead在编辑器选中代码 → 引用到对话输入框 | spec 原始需求 |
| 文件头信息 | `branch + worktree + last_commit_short_sha` | Maine Coon |

**技术选型**：

| 组件 | 选择 | 理由 |
|------|------|------|
| 代码编辑器 | **CodeMirror 6** | 比 Monaco 轻量，语法高亮+行号+基础补全，适合"辅助编辑"场景 |
| 前端预览 | **iframe sandbox** | Phase 2，安全隔离好，CSP 策略可控 |
| Markdown 渲染 | **react-markdown** | 已在 Hub 中使用 |
| 文件搜索 | 后端 `grep -r` | Phase 1 够用，后续可升级 |

### 安全测试清单（Maine Coon门禁）

| # | 测试场景 | 期望 |
|---|---------|------|
| 1 | `../` 路径遍历 | 403 |
| 2 | 绝对路径 `/etc/passwd` | 403 |
| 3 | URL 编码绕过 `%2e%2e%2f` | 403 |
| 4 | Symlink 逃逸 | 403 |
| 5 | Denylist 文件读取 `.env` | 403 |
| 6 | Denylist 文件写入 `.env` | 403 |
| 7 | 并发编辑 → 409 Conflict | 后写者收到 409 |
| 8 | 切换 worktree 后同路径文件内容不同 | 内容确实变化 |
| 9 | 无 edit_session_token 写入 | 401 |
| 10 | 过期 edit_session_token 写入 | 401 |

## Acceptance Criteria

- [x] AC-A1: 本文档需在本轮迁移后维持模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。
- [x] AC-1: team lead在 Hub 中可浏览当前仓库目录树（至少 3 层深度）
- [x] AC-2: 点击文件可查看内容（代码文件有语法高亮+行号）
- [x] AC-3: 全文搜索可搜到文件内容并展示匹配上下文
- [x] AC-4: 猫猫消息中的文件路径可点击跳转到文件查看
- [x] AC-5: HTML/React 组件可在 Hub 内预览渲染效果（Phase 2, PR #251 HTML + PR #256 JSX esbuild-wasm + PR #257 real bundling）
- [x] AC-6: 文件查看面板和对话面板可同时可见（50:50 分栏）
- [x] AC-7: 路径安全（不能访问仓库外的系统文件）
- [x] AC-8: 图片文件可直接预览
- [x] AC-9: team lead可在 Hub 内编辑文件，猫猫可直接 commit 编辑结果
- [x] AC-10: 文件系统感知 worktree（显示猫猫当前 worktree 的文件，而非只有 main）
- [x] AC-11: 顶栏有切换按钮，点击后聊天窗口缩小 + 右侧文件面板展开
- [x] AC-12: 搜索栏支持文件名搜索模式（输入文件名/路径片段 → 快速定位 + 显示相对路径 → 点击导航）
- [x] AC-13: 猫猫消息中的文件路径点击后自动切换到 workspace 面板并打开该文件（当前 AC-4 的完整体验闭环）
- [x] AC-14: team lead可拖拽调整三视图比例（聊天区 | 文件树 | 文件查看器），含最小宽度/高度限制
- [x] AC-15: team lead可在文件查看器中选中代码行/文件路径，点击"引用到聊天"按钮插入到输入框（类似 Claude.ai 的 "Add to chat"）
- [x] AC-16: team lead可在文件树或文件查看器中点击 "Open in Finder" 在系统文件管理器中打开文件（Gap 5, PR #307）
- [x] AC-17: 音频文件（mp3/wav/m4a/ogg）可在文件查看器中内嵌播放预览（Gap 5, PR #307）
- [x] AC-18: 视频文件（mp4/webm）可在文件查看器中内嵌播放预览（Gap 5, PR #307）
- [x] AC-19: 面板宽度（sidebar/chat-workspace/tree-viewer）刷新后保持，双击 resize handle 重置（Gap 6, PR #308）
- [x] AC-20: 深层目录（depth≥4）展开时按需加载子节点（Gap 7, PR #311）
- [x] AC-21: 切换线程后恢复该线程上次的文件树展开状态和打开的文件标签（Gap 7, PR #311）

## 需求点 Checklist

| ID | 需求点（team experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | "我得打开 vscode 或者 webstorm 然后搜索你说的文件" | AC-1, AC-2 | manual: Hub 内查看文件 | [x] |
| R2 | "所有和提示词注入有关的代码？我就得想好久得搜什么关键字" | AC-3 | manual: Hub 内全文搜索 | [x] |
| R3 | "猫猫提到了个文件，此时我翻半天，还得找行号" | AC-4 | manual: 点击文件路径跳转 | [x] |
| R4 | "claude ai 里面前端他们也能帮你直接打开文件系统 html jsx 直接展示" | AC-5 | manual: Hub 内渲染预览 | [x] |
| R5 | "如果定位问题遇到困难team lead一起帮忙会很有用" | AC-1, AC-2, AC-3 | manual: team lead在 Hub 内查看代码协助排查 | [x] |
| R6 | "审计日志...事实上确实很多时候需要协助查看" | — (Phase 3) | Phase 3 实现后验证 | [x] |
| R7 | "文件系统指的是你们的运行仓库的文件" | AC-7 | test: 仅暴露仓库内文件 | [x] |
| R8 | "这个是我们非常重要的一环体验？如何 ux 如何布局？" | AC-6, AC-11 | visual: Siamese review 布局 | [x] |
| R9 | "聊天窗口变小 文件系统右边代替状态栏出来 五五开" | AC-6, AC-11 | manual: 顶栏按钮切换分栏 | [x] |
| R10 | "如果是可以编辑的话 那有什么我帮你们编辑 复制进来" | AC-9 | manual: team lead编辑+猫猫 commit | [x] |
| R11 | "咱项目是有 worktree 的！所以这点也得考虑" | AC-10 | manual: 切换查看不同 worktree | [x] |
| R12 | "搜索我可以搜文件名吗？比如贴他的相对路径帮我导航一下？" | AC-12 | manual: 搜文件名 → 显示路径 → 点击导航 | [x] |
| R13 | "你们发的文本里的那些地址我点击 右边这里能打开吗？" | AC-13 | manual: 点消息中路径 → workspace 面板自动打开文件 | [x] |
| R14 | "要允许我能够调整两个的占比？或者说三个？聊天 然后文件系统 然后打开的文件" | AC-14 | manual: 拖拽分隔条调整三视图比例 | [x] |
| R15 | "直接点击一个文件然后在 chat 里 mention，或者选中某些行某个文件点击 add to chat" | AC-15 | manual: 选中代码/文件 → 点击引用 → 插入到聊天输入框 | [x] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [x] 前端需求已准备需求→证据映射表（若适用）— 23 PR 全量映射

## Key Decisions

| 决策 | 选项 | 结论 | 决策者 |
|------|------|------|--------|
| 文件浏览 vs 前端预览优先级 | 分开做 / 一起做 | **不冲突就一起做，冲突则文件先行** | team lead (2026-03-05) |
| 方案选择 | A 猫猫主动发 / B 侧边栏 / C 完整 Project | **直接做 B/C，不做临时方案 A** | team lead (2026-03-05) |
| 文件系统范围 | 仓库文件 / 仓库+runtime | **仓库文件为主，runtime 辅助** | team lead (2026-03-05) |
| 布局方案 | 侧边栏 / Tab / Modal / 可拖拽 | **顶栏按钮切换，右侧文件系统取代状态栏，聊天:文件 = 50:50** | team lead (2026-03-05) |
| 文件编辑能力 | 只读 / 可编辑 | **可编辑** — team lead帮忙编辑后猫猫可直接 commit | team lead (2026-03-05) |
| Worktree 感知 | 忽略 / 感知 | **必须感知 worktree** — 猫猫可能在不同 worktree 工作，文件系统需显示对应 worktree 的文件 | team lead (2026-03-05) |
| 参考实现 | 自研 / 参考现有 | **参考 Claude.ai Project + Codex 布局**，取其精华 | team lead (2026-03-05) |
| UI 设计语言 | 通用 / 猫猫化 | **对齐 F056 Cat Café 设计语言（猫猫化不是猫化）** | team lead (2026-03-05) |
| 设计稿工具 | Figma / Pencil | **Pencil MCP**（用 `pencil-design` skill） | team lead (2026-03-05) |
| 设计稿协作 | 单猫 / 多猫 | **Siamese出灵感（不画），GPT-5.2 可协助画设计稿，Ragdoll用 Pencil 落地** | team lead (2026-03-05) |

## Dependencies

- **Related**: F060（图片渲染能力）
- **Related**: F058（运行时状态展示）
- **Related**: F056（设计语言——UI 猫猫化风格必须对齐）
- **Evolves to**: F082（Git Health Panel — repo 状态可视化，从 workspace 基础设施衍生）
- **UX Design**: Siamese出灵感 + GPT-5.2 协助画设计稿 + Ragdoll用 Pencil MCP 落地

## Design Workflow（team lead指定）

实施前的设计稿流程：

1. **灵感**：Siamese/Siamese提供 UX 灵感和方向建议（**不让他画**，幻觉多）
2. **设计稿**：Ragdoll用 **Pencil MCP**（`pencil-design` skill）画设计稿；如需协助可 @gpt52 一起画
3. **设计语言**：所有 UI 元素对齐 **F056 Cat Café 设计语言**（猫猫化不是猫化）
4. **前端实现**：设计稿确认后用 `pencil-to-code` skill 导出 React/Tailwind 代码

## Risk

| 风险 | 影响 | 缓解 |
|------|------|------|
| 文件系统 API 路径遍历漏洞 | 安全隐患 | 白名单 + 路径规范化 + Maine Coon安全 review |
| 大仓库文件树加载慢 | 体验差 | 懒加载 + 深度限制 + 缓存 |
| 前端预览的代码注入风险 | XSS | iframe sandbox + CSP 策略 |
| 布局影响现有聊天体验 | 回归 | 渐进式：先做可收起的侧边栏 |

## Review Gate

- **Self-check**: `quality-gate`
- **Reviewer**: 跨 family（Maine Coon关注安全，Siamese关注 UX）
- **Cloud review**: 合入前必须

## Phase 1 UI 改进需求（team lead反馈 2026-03-05）

team lead评价 Phase 1 UI："有点丑不够猫猫，感觉没有设计感"。以下是具体问题和改进方向。

### 当前问题

| # | 问题 | 当前实现 | 参考 |
|---|------|---------|------|
| U1 | 文件树缺乏视觉层次 | 纯文本 emoji（📂📄），无颜色区分，hover 只有灰色背景 | Claude.ai Artifacts: 文件类型图标有颜色区分，hover 有微妙渐变 |
| U2 | 搜索栏太工具化 | 蓝色按钮 + 小 icon，像 admin 后台 | Cursor/Claude: 搜索栏内嵌，圆角大，placeholder 有引导性 |
| U3 | 文件头区域太暗太突兀 | `bg-gray-800` 深色头 vs `bg-white` 面板体，割裂感 | Codex: 文件头用浅色高对比 + 文件类型 badge |
| U4 | 没有 Cat Café 设计语言 | 通用灰/蓝配色，和 Hub 其他面板风格不统一 | F056 要求：猫猫化不是猫化，温暖而专业 |
| U5 | worktree 指示器太小 | `text-[10px]` 绿色 badge，几乎看不到 | 应该醒目：分支名 + 短 SHA + 状态色 |
| U6 | 空状态不友好 | "加载中..." 纯文字 | 应有骨架屏 / 猫猫插图 / 引导提示 |
| U7 | 没有动画过渡 | 面板切换、文件展开/折叠无动画 | Claude.ai: 面板 slide-in，树节点 fade-in |
| U8 | 搜索结果缺乏上下文感 | 只显示路径:行号 + 匹配行 | Cursor: 高亮关键词，显示文件类型图标，分组显示 |

### 设计参考笔记

**Claude.ai Artifacts Panel:**
- 右侧面板 slide-in 动画，有 backdrop blur
- 文件类型通过彩色图标区分（不是 emoji）
- 代码查看器用自定义主题（不是纯 oneDark），和整体配色融合
- 顶部有面包屑导航 + 文件元信息（大小、最后修改）
- 滚动时顶部文件名 sticky + 渐变消融效果

**OpenAI Codex Workspace:**
- 左侧文件树 + 右侧代码查看器的经典 IDE 布局
- 文件树项有 monospace 字体，hover 有浅色高亮
- 搜索在文件树上方，内嵌式设计（不是独立表单）
- 代码查看器顶部有 tab 风格的文件选择器
- diff 视图是 inline，不是 side-by-side

**我们应该做的（对齐 F056 Cat Café 设计语言）:**
- 用项目色板（暖色系，不是纯灰蓝）
- 文件类型用小型彩色 SVG 图标（不是 emoji）
- 面板过渡用 Framer Motion（和 Hub 其他面板一致）
- 搜索栏内嵌化，大圆角，带 search icon
- 空状态展示猫猫相关的友好提示
- 文件树 indent guide（竖线）提升层次感

## Phase 2 计划

### Phase 2A: UI 美化（优先，解决team lead反馈）

| Task | 内容 | 复杂度 |
|------|------|--------|
| P2A-1 | 文件类型图标系统：替换 emoji 为 SVG 彩色图标（devicon 风格） | S |
| P2A-2 | 设计语言对齐：配色、圆角、间距对齐 Hub 整体风格 | M |
| P2A-3 | 文件树 indent guide + hover 效果 + 展开动画 | S |
| P2A-4 | 搜索栏重新设计：内嵌式、大圆角、关键词高亮 | S |
| P2A-5 | 面板过渡动画（Framer Motion slide-in） | S |
| P2A-6 | worktree 指示器重新设计：醒目标签 + 状态色 | S |
| P2A-7 | 空状态 + 加载骨架屏 | S |
| P2A-8 | CodeMirror 主题自定义：对齐 Cat Café 配色 | M |

### Phase 2B: 功能增强

| Task | 内容 | AC | 优先 |
|------|------|-----|------|
| P2B-1 | 文件名搜索模式：搜索栏支持 filename/path 模式切换，fuzzy match 文件名，结果显示相对路径，点击直接导航到文件树并打开 | AC-12 | **done** |
| P2B-2 | 消息路径点击 → workspace 联动：点击聊天消息中的文件路径，自动切换到 workspace 面板 + 打开该文件（含自动展开文件树到对应目录） | AC-13 | **done** |
| P2B-3 | 可拖拽分栏比例调整：横向（聊天 vs workspace）+ 纵向（文件树 vs 文件查看器），含最小宽度/高度限制（各不低于 20%），双击恢复默认 | AC-14 | **done** |
| P2B-4 | 图片文件预览（inline image rendering） | AC-8 | **done** |
| P2B-5 | 文件编辑模式 + edit_session_token | AC-9 | **done** |
| P2B-6 | Markdown 渲染模式（raw/rendered 切换） | — | **done** |
| P2B-7 | 代码选中 → 引用到对话输入框：选中文件/代码行后点击"Add to chat"按钮，将 `file:line` 引用或选中代码片段插入聊天输入框；也支持文件树右键"复制路径" | AC-15 | **done** |
| P2B-8 | 多 tab 文件查看（不是一次只看一个） | — | **done** |
| P2B-9 | **BUG**: 引用到聊天不带 worktree 信息 — 格式改为 `` `path` (🌿 branch) ``，让猫猫知道引用的是哪个 worktree | AC-15 | **done** |
| P2B-10 | **BUG**: "Add to chat" 按钮固定在文件查看器顶部，滚动到下方代码时按钮不可见 — 改为跟随选区浮动或 sticky 在可视区域 | AC-15 | **done** |
| P2B-11 | **BUG**: Markdown 渲染模式下相对链接不可跳转 — `[F046](features/F046-xxx.md)` 这样的相对路径链接在 Rendered 模式下点击无效（`target="_blank"` 打开的是无意义的浏览器 URL）。应拦截相对 `.md` 链接，解析为相对于当前文件的路径，用 `setWorkspaceOpenFile` 在 workspace 内打开目标文件 | — | **done** |

### Phase 2C: 预览能力

| Task | 内容 | AC |
|------|------|-----|
| P2C-1 | HTML/JSX iframe sandbox 预览 | AC-5 | **done** |
| P2C-2 | Diff 可视化（unified/side-by-side） | — | **done** |

### Phase 2C-fix: 愿景守护修复（2026-03-06 Maine Coon+GPT-5.4 审查）

两猫独立审查结论：主链路 80% 已打通，但有 3 条猫尾巴。

| Task | 内容 | 来源 | 优先 |
|------|------|------|------|
| P2C-fix-1 | untracked 文件 diff：`??` 文件在 Changes 列表可见但无 diff 内容（`git diff HEAD` 天然不覆盖未跟踪文件）→ 用 `git diff --no-index` 补充 | codex P2 + gpt52 P2 | **done** |
| P2C-fix-2 | worktree-aware chat link：聊天中文件引用带 `🌿 branch` 文本但点击不会切换 worktree，落到错工地 | gpt52 P1 | **done** |
| P2C-fix-3 | JSX/TSX 预览：当前只识别 `.html`，React 组件只能看源码不能渲染 → 需要 bundler (esbuild) → **提前到 Phase 2E** | codex P1 + gpt52 P1 | **done** (PR #256) |

### Phase 2D: 跨项目 Linked Roots（team lead 2026-03-06 提出）

team lead需求：猫猫帮外部项目（如 `studio-flow`）开发时，team lead想在 Hub 里看到那个项目的文件，但不想破坏安全隔离。

**方案**：安全隔离保持不变 + 手动 link 外部 project root

| Task | 内容 | 优先 |
|------|------|------|
| P2D-1 | API 支持 `WORKSPACE_LINKED_ROOTS` 配置（环境变量或配置文件），格式 `name:path`，每个 root 独立路径防护 | **done** |
| P2D-2 | worktree 列表 API 合并返回 git worktree + linked roots | **done** |
| P2D-3 | 前端 root 选择器（复用 worktree 选择器，区分 worktree vs linked root） | **done** |

### Phase 2E: JSX/TSX 组件预览（team lead 2026-03-06 批准提前）

愿景守护审查发现：HTML 预览已有，但 React 组件（`.tsx`/`.jsx`）只能看源码不能渲染，"不开 IDE 协作前端"在 React 场景断裂。

**技术方案**：esbuild WASM 浏览器端 bundling → iframe sandbox 渲染

| Task | 内容 | 优先 |
|------|------|------|
| P2E-1 | esbuild-wasm 集成：浏览器端 bundle JSX/TSX → 可执行 JS | **done** |
| P2E-2 | 预览 iframe：sandbox 渲染 bundled output + React/ReactDOM CDN 注入 | **done** |
| P2E-3 | 预览开关：`.tsx`/`.jsx` 文件支持 Preview/Code 切换（复用 HTML preview 模式） | **done** |
| P2E-4 | 错误处理：bundle 失败/运行时错误 → 友好提示（不是白屏） | **done** |

### Phase 3: 愿景守护 Gaps（codex + gpt52 独立审查 2026-03-06）

第二次愿景守护（Phase 2 全量合入后）两猫共识：主链路 85%+ 但 3 个 gap 阻止"愿景闭环"宣称。

#### Gap 1 (P1): JSX/TSX 预览从演示级升级到真实组件级

当前 `bundle: false`，只重写 React bare imports → 组件有本地依赖/UI 库/样式就掉线。

| Task | 内容 | 优先 |
|------|------|------|
| P3-1 | `bundle: true` + esbuild resolve plugin for workspace 内本地模块 | **done** |
| P3-2 | 常见 UI 库 (tailwindcss, shadcn/ui) 的 CDN fallback 策略 | **done** (esm.sh fallback) |
| P3-3 | 预览错误精准定位：区分 bundle error vs runtime error vs missing dep | **done** |

#### Gap 2 (P1): Linked Roots Hub 内自助管理

当前只能通过 `WORKSPACE_LINKED_ROOTS` 环境变量配置 + 重启生效，不够"优雅"。

| Task | 内容 | 优先 |
|------|------|------|
| P3-4 | API POST/DELETE `/api/workspace/linked-roots` 动态增删 | **done** |
| P3-5 | 前端添加/移除 linked root UI（路径选择 + 安全校验） | **done** |
| P3-6 | 持久化策略：写入配置文件（不依赖环境变量重启） | **done** (.cat-cafe/linked-roots.json) |

#### Gap 3 (P2): Runtime/Audit Explorer 进 Workspace — **done**

RightStatusPanel 内嵌 AuditExplorerPanel（审计事件 + Session 事件 + 搜索三 tab），
替代"在 VSCode 中打开"。SessionChainPanel 点击 sealed session → 跳转查看器。

| Task | 内容 | 优先 |
|------|------|------|
| P3-7 | AuditExplorerPanel 三 tab（审计事件/Session 事件/搜索） | **done** |
| P3-8 | 内联审计查看器替代 VSCode 跳转 + SessionChainPanel click-to-view | **done** |

#### Gap 4 (P1): File Management — VSCode 级文件操作 UX

team lead不打开 Finder/IDE 就能在 Hub 里新建文件、上传图片、管理文件。
交互对齐 VSCode：目录行 hover 出操作图标 + inline 输入框 + 拖拽上传。

| Task | 内容 | 优先 |
|------|------|------|
| P4-1 | 后端: POST /api/workspace/file/create（新建文件） | P0 |
| P4-2 | 后端: POST /api/workspace/dir/create（新建目录） | P0 |
| P4-3 | 后端: POST /api/workspace/upload（上传文件，multipart） | P0 |
| P4-4 | 后端: DELETE /api/workspace/file（删除文件/目录） | P1 |
| P4-5 | 后端: POST /api/workspace/file/rename（重命名/移动） | P1 |
| P4-6 | 前端: 目录行 hover 操作栏（新建文件/新建目录图标） | P0 |
| P4-7 | 前端: inline 输入框（创建文件/目录/重命名） | P0 |
| P4-8 | 前端: 上传按钮 + 拖拽到目录行 drop 上传 | P0 |
| P4-9 | 前端: 文件/目录行 hover 删除+重命名图标 | P1 |
| P4-10 | 新建文件后自动打开 + 进入编辑模式 | P0 |

### Gap 5: System Integration — Open in Finder + 媒体预览

team lead反馈（2026-03-08）："生成了音频/视频想 share，Hub 里不能直接打开，Open in Finder 是很常用的功能"

| Task | 内容 | 优先 |
|------|------|------|
| G5-1 | 后端: `POST /api/workspace/reveal` — 在系统文件管理器中打开文件（macOS `open -R`, Windows `explorer /select,`） | P0 |
| G5-2 | 前端: 文件树右键菜单 + 文件查看器顶部按钮 "Open in Finder" | P0 |
| G5-3 | 前端: 音频文件内嵌预览（HTML5 `<audio>` 标签，支持 mp3/wav/m4a/ogg） | P1 |
| G5-4 | 前端: 视频文件内嵌预览（HTML5 `<video>` 标签，支持 mp4/webm） | P1 |
| G5-5 | 安全: reveal/open 复用 `resolveWorkspacePath` + `isDenylisted` 检查 | P0 |

**Status**: Done (PR #307)

### Gap 6: Panel Width Persistence + Resizable Sidebar — done

team lead反馈（2026-03-08）："调整了右边文件栏的大小，切换走或 F5 就丢了" + "左侧栏也需要能调整宽度"

| Task | 内容 | 优先 |
|------|------|------|
| G6-1 | `usePersistedState` hook: localStorage-backed useState with SSR safety + reset | P0 |
| G6-2 | chatBasis / treeBasis / sidebarWidth 持久化到 localStorage，刷新后恢复 | P0 |
| G6-3 | ThreadSidebar 支持 className prop 覆盖宽度，ChatContainer 场景可拖拽 (180-480px) | P0 |
| G6-4 | 双击 resize handle 恢复默认比例 | P1 |

**Status**: Done (PR #308)

### Gap 7: Lazy Tree Loading + Per-Thread Workspace State

| Task | 内容 | 优先 | 设计思路 |
|------|------|------|----------|
| G7-2 | 切换线程后恢复文件树展开状态 + 打开的文件标签 | P2 | 每个线程的 `expandedPaths` + `openTabs` + `openFilePath` 存到 `Map<threadId, WorkspaceState>`，切换线程时 save/restore |

## Phase: Focus Mode（Intake from clowder-ai#362）

> **Status**: ✅ merged | **Source**: clowder-ai#362 → cat-cafe#966 | **Strategy**: manual-port
> **Date**: 2026-04-05 | **Owner**: Ragdoll (Opus)
> **Reviewer**: Maine Coon/Maine Coon (codex) + 云端 Codex

### Why

社区贡献者在 clowder-ai#362 实现了 workspace 专注模式——展开任意 pane（浏览器/文件/变更/git/终端）到全 workspace 区域，消除周围干扰。GPT-5.4 评估后建议 intake 回家并修复 UX 问题。

### What

| 组件 | 职责 | 行数 |
|------|------|------|
| `FocusModeButton` | per-pane toolbar 行内的专注按钮，空态自动禁用 | 25 |
| `WorkspaceFocusShell` | 共享壳：Escape 退出 + 暖色调半透明浮标退出按钮 + fade 过渡 | 55 |
| `WorkspacePreviewOnly` | 浏览器 focus 壳：Shell > BrowserPanel(previewOnly) | 20 |
| `WorkspaceFileViewer` | 从 WorkspacePanel 提取的文件查看器（tab bar + toolbar + 内容渲染 + 专注按钮） | 320 |
| `FileContentRenderer` | 从 FileViewer 提取的内容渲染（binary/md/html/jsx/code） | 154 |
| `BrowserPanel` 改动 | 新增 `previewOnly` + `onNavigate` props | 350 |
| `WorkspacePanel` 改动 | focusedPane 状态路由 + auto-exit + per-pane FocusModeButton 集成 | 1018 |

### UX 修复（相对上游）

| # | 级别 | 问题 | 修复 |
|---|------|------|------|
| 1 | P1 | 浏览器 focus 后切回丢失预览状态 | `onNavigate` 回调同步 port/path 到父层 |
| 2 | P1 | focus 按钮位置各 pane 不统一 | 统一放在 tab bar → **R2 移至 per-pane toolbar 行**（见 UX R2） |
| 3 | P2 | 空态时 focus 按钮可点（误导） | `disabled` 禁用（无预览/无 worktree/无文件） |
| 4 | P2 | 进出硬切无过渡 | `animate-fade-in` |
| 5 | P3 | 退出按钮可能被内容遮挡 | sticky header → **R2 暖色调半透明浮标**（见 UX R2） |

### Acceptance Criteria

- [x] AC-F1: 任意 workspace pane 可一键展开到全区域
- [x] AC-F2: 统一的退出方式（Escape + 可见退出按钮）
- [x] AC-F3: 浏览器预览状态在 focus 切换间保持
- [x] AC-F4: 空态（无预览/无文件/无 worktree）时 focus 按钮禁用
- [x] AC-F5: 上下文切换（viewMode/file/workspaceMode 变化）自动退出 focus
- [x] AC-F6: 10 个测试覆盖 FocusModeButton + WorkspaceFocusShell + WorkspacePreviewOnly

### UX R2（team lead视觉审查 2026-04-05）

team lead看到实际 UI 后指出两个层级问题：

| # | 级别 | 问题 | 修复 |
|---|------|------|------|
| 6 | P1 | 专注按钮放在 tab bar 与 view mode 同级，层级错误（它是 pane action 不是 view mode） | 移到 per-pane toolbar 行：文件 toolbar 同行（Copy/Path/Finder/编辑 旁）、浏览器右上角浮层 |
| 7 | P1 | 退出专注用暗色 sticky header，与 Cat Cafe 暖色设计语言冲突 | 改为暖色调半透明浮标：`bg-cocreator-light/70 rounded-full backdrop-blur-sm shadow-sm` |

### Review 记录

- Maine Coon(codex) R1: 2 P1（onNavigate 空态残留 + 测试 prop 名错误）→ 修复 → R2 放行
- 云端 Codex: "Didn't find any major issues" → 0 P1/P2
- **team lead UX R2**: 2 P1（按钮层级 + 退出样式）→ fix/focus-mode-ux 分支修复

## Known Bugs (Follow-up)

| Bug | 描述 | 根因 | 状态 |
|-----|------|------|------|
| B1 | 切换 Hub project 后 Workspace 仍显示 cat-cafe 文件 | 后端 `listWorktrees()` 用 `process.cwd()` 固定指向 cat-cafe，前端无 project context | **PR #266 已修（后端+hook）** |
| B1.1 | 切换已有 thread 或刷新页面后 workspace 不跟随项目切换 | `handleSelect` 只做路由跳转不恢复 `projectPath`；`ChatContainer` 首次挂载不从 thread 元数据恢复 `currentProjectPath` | **PR #269 已修** |
| B2 | Link External Folder "Network error" | `LinkedRootsManager.tsx` 用 raw `fetch` + `API_BASE` 而非 `apiFetch`，port 不匹配 | **PR #264 已修** |

## B1 Fix Plan — Project-Aware Workspace

**问题**：Workspace API 硬编码 `process.cwd()` 作为 git repo root，导致切换 Hub project 后文件树仍显示 cat-cafe。

**修复方案**（3 层改动）：

1. **后端 API**: `GET /api/workspace/worktrees` 接受 `?repoRoot=` 查询参数
   - `listWorktrees(repoRoot)` 已支持传入 root，只需从路由层透传
   - `linkedRootsConfigPath()` 也需要支持 project-specific config
   - 安全：`repoRoot` 必须是绝对路径 + 目录存在检查

2. **前端 hook**: `useWorkspace.fetchWorktrees()` 从 store 读 `currentProjectPath`，传给 API
   - `currentProjectPath === 'default'` 时不传（后端 fallback 到 `process.cwd()`）
   - 切换 project 时自动 re-fetch worktrees

3. **LinkedRootsManager**: 同样透传 `repoRoot`（add/remove linked roots 要知道归属哪个 project）

## B1.1 Fix Plan — Thread Switch/Refresh Project Restoration

**问题**：PR #266 修了后端 API 和 `useWorkspace` hook，但前端在以下场景不恢复 `currentProjectPath`：
- **切换已有 thread**：`handleSelect`（ThreadSidebar.tsx:227-236）只调 `navigateToThread(threadId)`，不读 thread 的 `projectPath`
- **页面刷新**：`currentProjectPath` 默认值是 `'default'`，ChatContainer 挂载时不从 thread 元数据恢复

**数据已具备**：`Thread` 接口已有 `projectPath: string` 字段，sidebar 的 `threads` 数组包含完整元数据。

**修复方案**（2 处改动）：

1. **`handleSelect`**：从 `threads` 数组找到目标 thread，取 `projectPath`，调 `setCurrentProject`
   ```ts
   const thread = threads.find(t => t.id === threadId);
   if (thread?.projectPath) setCurrentProject(thread.projectPath);
   ```

2. **`ChatContainer` 首次挂载**：从 API 获取当前 thread 的 `projectPath`（或从已加载的 threads 列表读取），写回 store
   - 方案 A：在 `useEffect([threadId])` 里调 `GET /api/threads/:id` 取 projectPath
   - 方案 B：让 `setCurrentThread` 同时接受 thread 元数据（需改 store 接口）
   - **推荐方案 A**：最小侵入，不改 store 接口
