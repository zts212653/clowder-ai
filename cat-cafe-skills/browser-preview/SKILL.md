---
name: browser-preview
description: >
  Hub 内嵌浏览器预览 localhost 应用。
  Use when: 写前端代码、跑 dev server、需要看页面效果、调 UI、铲屎官说"看看效果"。
  Not for: 后端纯 API 开发、不涉及页面的工作。
  Output: 前端页面在 Hub browser panel 中实时预览。
triggers:
  - "看效果"
  - "看看页面"
  - "preview"
  - "浏览器预览"
  - "打开浏览器"
  - "pnpm dev"
  - "dev server"
  - "localhost"
  - "前端效果"
  - "看看 UI"
  - "HMR"
  - "热更新"
---

# Browser Preview

Hub 内置了嵌入式浏览器面板（F120），可以直接预览运行中的 localhost 应用。猫猫写完前端代码不用让铲屎官切浏览器看效果。

## 工作流

### 基础流程（端口发现 → 预览）
1. **在 Terminal 启动 dev server**（`pnpm dev` / `npm start` / `vite` 等）
2. **Hub 自动检测端口** → 弹出 toast 提示"检测到 localhost:xxxx 启动"
3. **点击 Open Preview** → 自动打开 browser panel 并加载页面
4. **也可以手动**：切到 workspace 的 Browser tab，输入 `localhost:port` 按 Go

改代码 → HMR 热更新 → browser panel 内页面自动刷新，无需手动操作。

### 猫主动打开浏览器（Phase C — 必须掌握）
铲屎官说过："别手动让我输入，你最好打开浏览器，把页面放出来。"

**猫应该主动替铲屎官打开浏览器**，不要等铲屎官点 toast 或手动输 URL。

#### 调用步骤（按顺序执行，不要跳步）

```
Step 1: 确认目标服务器在跑
  curl -s -o /dev/null -w "%{http_code}" http://localhost:PORT
  → 200/301/304 = 可以继续
  → 000/connection refused = 服务器没起来，先启动再说

Step 2: 调用 auto-open API
  curl -X POST http://localhost:API_PORT/api/preview/auto-open \
    -H "Content-Type: application/json" \
    -d '{"port": PORT}'

Step 3: 等 1-2 秒，右侧 Browser panel 应自动打开
  → 如果没反应，检查 Step 1 是否真的返回了 200
```

#### API 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `port` | **是** | dev server 端口号 |
| `path` | 否 | 页面路径，默认 `/` |
| `worktreeId` | **建议传** | 传了保证精确送达；不传也能工作（走 global broadcast），但多 tab 场景可能误触其他 session |

> **怎么获取 worktreeId**：就是你当前工作的 worktree 目录名。例如你在 `cat-cafe-f120-fix` 目录里工作，worktreeId 就是 `cat-cafe-f120-fix`。如果你在主仓库 `cat-cafe` 里，就不需要传。

#### 常见错误

| 现象 | 原因 | 修法 |
|------|------|------|
| 右侧无反应 | 目标服务器没在跑 | 先 `curl localhost:PORT` 确认 |
| `{"error":"Proxy error","message":"socket hang up"}` | 目标服务器已退出 | 重启服务器，再刷新 Browser panel |
| 打开了系统 Chrome | 用了 Playwright/Chrome MCP 等外部工具 | **不要用外部浏览器工具！** auto-open 是 Hub 内嵌预览，不是系统浏览器 |
| 两个重复 tab | React Strict Mode（已修复） | 升级到最新代码 |

- 适用场景：写完前端代码后、铲屎官说"看看效果"、需要展示复杂页面
- ⚠️ **不要传 `html` 参数**（后端不支持）；简单 HTML 可视化用 `html_widget` rich block

### 两层可视化策略
铲屎官拍板："简单的用富文本，复杂的用猫主动打开浏览器。"

| 场景 | 方式 | 怎么做 |
|------|------|--------|
| 简单可视化（图表、动画、计算器） | `html_widget` rich block 内联渲染 | 用 `rich-messaging` skill 发 `html_widget` block |
| 复杂应用（完整页面、多组件交互） | 猫主动打开浏览器 | 调用 `auto-open` API |

## 技术要点（猫猫需要知道的）

| 项目 | 说明 |
|------|------|
| **Preview Gateway** | 独立端口（默认 4100），反向代理 localhost 应用 |
| **为什么不直连** | iframe 跨端口需要代理剥离 X-Frame-Options/CSP |
| **iframe sandbox** | `allow-scripts allow-forms allow-popups allow-downloads allow-same-origin`（安全：独立 origin） |
| **WebSocket/HMR** | 代理层支持 WebSocket 升级，Vite/Next/Webpack HMR 正常工作 |
| **端口排除** | Cat Cafe 自身端口（3003/3004/6398/6399/18888 等）自动排除 |
| **审计** | 每次 open/close/navigate 都有审计日志 |
| **Console 面板** | bridge script 注入到 iframe，捕获 console.log/warn/error，在面板展示 |
| **一键截图** | SVG foreignObject + canvas 截图，上传后端，toast 展示 |
| **多 Tab** | 同时预览多个 localhost 页面，Tab 切换独立状态 |
| **Socket room 隔离** | preview 事件按 worktree room 定向发送，不会全局广播 |

## 什么时候主动用

- 写完前端组件/页面 → **主动调 auto-open 打开浏览器展示**（不要等铲屎官点）
- 调样式/布局 → 改代码后在 browser panel 里实时查看
- 铲屎官说"看看效果"/"给我看看" → 主动打开 browser panel 展示
- dev server 已在 Terminal 跑着 → 主动打开浏览器，不要只提示
- 简单可视化（图表/动画） → 用 `html_widget` rich block 内联渲染
- Console 有报错 → browser panel 下方 Console 面板自动展开，可以看
- 需要截图 → browser panel 工具栏一键截图；默认先存到 `${TMPDIR}/cat-cafe-evidence/...`，不要落仓库根目录（见 `refs/evidence-output-contract.md`）

## 不要做的事

- **不要跳过 Step 1（验证服务器）直接调 auto-open** — 服务器没跑 = proxy error
- **不要用 Playwright / Chrome MCP / `open` 命令打开系统浏览器** — F120 是 Hub 内嵌预览，走 iframe，不走系统浏览器
- 不要手动去构造 gateway URL（让 Hub 前端处理）
- 不要尝试预览外部 URL（只支持 localhost）
- 不要预览 Cat Cafe 自身服务端口（会被端口验证拦截）
- 不要把临时截图顺手留在仓库根目录；要入库时再显式归档到正式目录

## 和其他 skill 的区别

| Skill | 关注点 |
|-------|--------|
| **browser-preview（本 skill）** | Hub 内预览 localhost 前端页面 |
| `tdd` | 写代码的测试驱动纪律 |
| `quality-gate` | 开发完成后的自检（含对照设计稿） |
