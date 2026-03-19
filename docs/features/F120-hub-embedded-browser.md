---
feature_ids: [F120]
related_features: [F063, F089]
topics: [hub, ux, browser, preview, dev-server, frontend]
doc_kind: spec
created: 2026-03-14
---

# F120: Hub Embedded Browser — 在 Hub 内嵌浏览器预览运行中的前端应用

> **Status**: done | **Owner**: Ragdoll | **Priority**: P1 | **Completed**: 2026-03-15

## Why

team lead截图展示了 Claude Code 的 embedded browser panel：猫猫跑 `pnpm dev` 后，旁边直接嵌一个浏览器看 `localhost:3847` 的完整应用，改代码 → HMR 热更新 → 浏览器实时刷新。

Cat Café 目前的差距：

1. **F063 AC-5 只做了静态渲染**：单文件 HTML/JSX 通过 esbuild-wasm + iframe sandbox 渲染，不是运行中的应用
2. **看前端效果要切浏览器**：猫猫在 worktree 写前端代码，team lead想看效果必须切到 Chrome 打开 localhost——这和 F063 愿景（"不用打开 IDE 也能协作"）同源，但 scope 是全新的
3. **F089 Terminal 已有**：猫猫可以在 Hub 里跑 `pnpm dev`，但跑起来后看不到效果，体验断裂

team experience（2026-03-14）：
> "我想要的其实是这个能力"（指 Claude Code 截图中的 embedded browser）
> "让你们把前端启动起来，你们能在这里直接看到"
> "a + b，按照咱的家规，我们要面向最终的状态开发"

team experience（2026-03-14，Phase C 讨论）：
> "我希望的是你打开那个浏览器不是我手动输入...别手动让我输入，你最好打开浏览器，把页面放出来"（猫必须能主动打开浏览器，不能只靠用户点 toast 或手动输 URL）
> "简单的用富文本，复杂的用猫主动打开浏览器"（两层策略：轻量可视化走 rich block 内联，复杂应用走浏览器面板）
> "这种能力我们能搞吗？"（指 Claude.ai 的 `visualize:show_widget` — 在聊天中内联渲染可交互 HTML/JS 组件）
> "你不是120就是这些？120的 Phase 3 你都没做！"（Phase C 就是这些能力的归属，不需要另起 feature）

## What

### Phase A: Embedded Browser Panel（P0 — 核心能力）

在 Hub 右侧（复用 F063 workspace 面板区域或新增 tab）嵌入一个浏览器 panel，能访问 `localhost:xxxx` 的运行中应用：

1. **浏览器 Panel**
   - iframe 或 WebView 嵌入，显示指定 `localhost:port` 的页面
   - 支持基础浏览器交互：点击、滚动、表单输入、导航
   - URL 栏可手动输入/修改地址
   - 刷新按钮、前进/后退导航
   - 响应式：panel 宽度变化时页面自适应（或可切换 viewport 尺寸模拟移动端）

2. **端口自动发现**
   - 猫猫在 F089 Terminal 里跑 `pnpm dev` / `npm start` / `vite` 等 → 检测到新的 listening port
   - Hub 弹出提示："检测到 localhost:3847 启动，是否预览？"
   - 点击确认 → 自动打开 browser panel 并加载该地址
   - 多端口场景：前端 3001 + 后端 3000 → 列表选择

3. **HMR/Live Reload 支持**
   - WebSocket 穿透：dev server 的 HMR WebSocket 连接必须正常工作
   - 猫猫改代码 → dev server 热更新 → browser panel 内页面实时刷新
   - 不需要手动刷新（但也提供手动刷新按钮兜底）

4. **与 Workspace 联动**
   - browser panel 和 file explorer 可同时打开（三栏：聊天 | 文件 | 浏览器，或 tab 切换）
   - 猫猫说"看看首页效果"→ 自动切到 browser panel

### Phase B: 安全与隔离（P0 — 与 Phase A 并行）

**核心架构决策（Design Gate Maine Coon结论）**：反向代理为主，不做 iframe 直连作为默认路径。

1. **Preview Gateway（反向代理）**
   - Hub 后端启动 preview gateway，iframe 永远打开网关 URL，不直接连 `localhost:xxxx`
   - **独立预览 origin**：网关必须和 Hub 主站不同 origin（不同端口），避免 `allow-same-origin + allow-scripts` 暴露 Hub 存储
   - 代理层可控地剥离/重写目标 dev server 的 `X-Frame-Options` / `CSP frame-ancestors` 响应头
   - WebSocket 代理：HMR/Hot Reload 的 WebSocket 连接必须穿透代理层

2. **端口白名单**
   - Host 只允许：`localhost`、`127.0.0.1`、`::1`（解析后再校验必须是 loopback）
   - 端口策略：默认允许 `1024-65535`，只自动推荐"检测到的 dev server 端口"
   - 强制排除（从配置动态读取 + 固定保底）：`3003/3004`（Hub）、`6398/6399`（Redis）、`18888/19999`（MCP/API）、`9876/9878/9879`（服务端口）、preview gateway 自身端口（防递归代理）

3. **iframe sandbox 策略**
   - 基线：`sandbox="allow-scripts allow-forms allow-popups allow-downloads allow-same-origin"`
   - **前提**：仅在"独立预览 origin"下使用 `allow-same-origin`；若同 origin 则不安全
   - 明确禁止：`allow-top-navigation`（默认禁），避免预览页劫持顶层 Hub
   - 配套：`referrerpolicy="no-referrer"`，`allow` 权限白名单（摄像头/麦克风/地理位置默认禁）

4. **审计**
   - `browser_preview_open / close / navigate` 事件记录（threadId、port、url）

### Phase C: 增强体验（P1 — Phase A 稳定后）

1. **猫主动打开浏览器（AC-C1）**
   - 猫通过 API 调用 `POST /api/preview/auto-open` → 后端 emit `preview:auto-open` socket 事件 → 前端直接打开 browser panel（跳过 toast 确认）
   - 支持指定 `{ port, path?, html? }`：
     - `port + path`：打开已运行的 dev server 特定页面（如"看看首页效果"）
     - `html`：后端临时托管猫生成的 HTML，分配临时端口，自动打开浏览器渲染
   - 前端 `WorkspacePanel.tsx` 监听 `preview:auto-open` → 直接 `setViewMode('browser')` + `setPreviewPort()`，不走 toast
   - 技术要点：复用现有 Preview Gateway 反向代理，临时 HTML 用 express static serve 即可

2. **内联可视化 Widget（AC-C2，html_widget rich block）**
   - 新增 rich block kind = `html_widget`，payload 包含 HTML/JS/CSS 代码字符串
   - 前端用 sandboxed iframe 渲染：`sandbox="allow-scripts"`，**禁止** `allow-same-origin`（内联 widget 不需要访问 Hub 存储）
   - iframe `srcdoc` 直接注入 HTML（不走 Preview Gateway），零额外网络请求
   - 适合简单可视化：Chart.js 图表、计算器、CSS 动画等纯前端组件
   - 类似 Claude.ai 的 `visualize:show_widget` 能力
   - team lead决策："简单的用富文本，复杂的用猫主动打开浏览器"——两层策略共存

3. **DevTools 精简版**
   - Console 输出面板：显示 iframe 内页面的 console.log/warn/error
   - Network 概览：请求列表（URL、状态码、耗时）
   - 不做完整 DevTools，够定位问题即可

4. **截图与分享**
   - 一键截图当前 browser panel 内容
   - 截图自动附到对话中（复用 F060 图片能力）
   - team lead可以在截图上标注"这里有问题"

5. **多 Tab 浏览**
   - 同时打开多个 localhost 页面（前端 + 后端 Swagger 等）
   - Tab 切换，每个 tab 独立 URL 和状态

## Acceptance Criteria

### Phase A（Embedded Browser Panel） ✅
- [x] AC-A1: Hub 内可打开一个 browser panel，输入 `localhost:xxxx` 后显示运行中的页面
- [x] AC-A2: 猫猫在 Terminal（F089）启动 dev server 后，Hub 自动检测端口并提示预览
- [x] AC-A3: dev server HMR 热更新在 browser panel 内正常工作（改代码 → 页面自动刷新）
- [x] AC-A4: browser panel 有 URL 栏、刷新、前进/后退基础导航控件
- [x] AC-A5: browser panel 和 workspace file explorer 可同时可见或 tab 切换

### Phase B（安全与隔离） ✅
- [x] AC-B1: browser panel 只能访问 localhost，尝试访问外部 URL 被拦截
- [x] AC-B2: iframe 内页面无法访问 Hub 的 Cookie/Storage/DOM
- [x] AC-B3: 禁止访问 Cat Café 自身 API 端口（可配置排除列表）

### Phase C（增强体验） ✅
- [x] AC-C1: 猫可通过 API 触发 `preview:auto-open`，前端自动打开 browser panel（无需用户点击 toast）
- [x] AC-C2: 新增 `html_widget` rich block，猫发送的 HTML/JS 代码在聊天中以 sandboxed iframe 内联渲染
- [x] AC-C3: browser panel 下方可查看页面的 console 输出
- [x] AC-C4: 一键截图 browser panel 并附到聊天消息
- [x] AC-C5: 支持同时打开多个 localhost tab

## 需求点 Checklist

| ID | 需求点（team experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | "让你们把前端启动起来，你们能在这里直接看到" | AC-A1, AC-A3 | manual: Hub 内看到运行中的前端页面 | [x] |
| R2 | "跟 Claude Code 这样能够有一个浏览器能够直接预览前端的能力" | AC-A1, AC-A4 | manual: embedded browser 有基础导航控件 | [x] |
| R3 | "a + b，面向最终的状态开发" — 自动检测 + 手动输入都要 | AC-A2, AC-A4 | manual: 自动检测弹提示 + 手动输入 URL 都能打开 | [x] |
| R4 | "你最好打开浏览器，把页面放出来" — 猫主动打开浏览器，不靠用户手动输入 | AC-C1 | manual: 猫调用 API 后 browser panel 自动打开指定页面 | [x] |
| R5 | "简单的用富文本，复杂的用猫主动打开浏览器" — 内联 widget + 浏览器两层策略 | AC-C1, AC-C2 | manual: 简单可视化在聊天内联渲染，复杂应用在浏览器面板打开 | [x] |
| R6 | "这种能力我们能搞吗？"（Claude.ai `visualize:show_widget`）— 聊天内联可交互 HTML | AC-C2 | manual: 猫发送 html_widget rich block，聊天中显示可交互组件 | [x] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [ ] 前端需求已准备需求→证据映射表（若适用）

## Dependencies

- **Related**: F063（Workspace Explorer — 文件浏览/静态预览基础设施，browser panel 复用面板区域）
- **Related**: F089（Hub Terminal & tmux — dev server 在 terminal 里启动，端口发现依赖 terminal 进程感知）

## Risk

| 风险 | 缓解 |
|------|------|
| dev server 的 X-Frame-Options/CSP 阻止 iframe 嵌入 | **反向代理剥离响应头**（Design Gate 决策：代理是必须的） |
| HMR WebSocket 被代理层阻断 | preview gateway 必须支持 WebSocket 升级代理（HTTP Upgrade） |
| 端口自动发现误报（非 dev server 的进程） | stdout 解析 + 端口可达性探测双重过滤；lsof 按 tmux pane pid 定向扫描 |
| 预览页访问 Hub Cookie/Storage | 独立预览 origin + iframe sandbox；不同 origin 天然隔离 Cookie |
| 递归代理（预览页访问 preview gateway 自身） | 端口排除列表强制包含 gateway 自身端口 |
| 预览页劫持 Hub 顶层导航 | sandbox 禁止 `allow-top-navigation` |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 独立立项（不挂 F063） | F063 已关闭（23 PR），技术栈完全不同（live server vs 静态渲染），独立 scope | 2026-03-14 |
| KD-2 | 自动检测 + 手动输入都要（不拆 A/B） | team lead："面向最终的状态开发"，只有其一是残缺体验 | 2026-03-14 |
| KD-3 | **反向代理为必选方案**（否决 iframe 直连作为默认路径） | X-Frame-Options/CSP 不可控 + 独立 origin 隔离安全 + WebSocket 代理可控。Maine Coon Design Gate 安全审查结论 | 2026-03-14 |
| KD-4 | 端口发现：stdout 解析 + lsof 兜底 + 可达性探测 | 快+通用+防误报三层保险。Maine Coon Design Gate 结论 | 2026-03-14 |
| KD-5 | 独立预览 origin（preview gateway 独立端口） | allow-same-origin + allow-scripts 同 origin 不安全。Maine Coon安全审查结论 | 2026-03-14 |
| KD-6 | **两层可视化策略**：简单走 `html_widget` rich block 内联，复杂走猫主动打开浏览器 | team lead拍板："简单的用富文本，复杂的用猫主动打开浏览器"。参考 Claude.ai `visualize:show_widget` | 2026-03-14 |
| KD-7 | `html_widget` 用 iframe `srcdoc` 渲染，不走 Preview Gateway | 内联 widget 是纯前端沙箱，不需要反向代理；sandbox 禁止 `allow-same-origin`（比 browser panel 更严格） | 2026-03-14 |

## Review Gate

- Phase A: Maine Coon review 安全模型（iframe sandbox + 端口白名单）+ Siamese review UX
- Phase B: Maine Coon review 安全隔离策略
