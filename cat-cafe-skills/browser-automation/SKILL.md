---
name: browser-automation
tips_exempt: "2026-10-28: background browser defaults and agent routing repair an existing workflow; no new end-user entry or setup action."
description: >
  浏览器工作流总路由：为外部网站浏览、登录态流程、浏览器自动化、证据采集选择合适后端。
  Use when: 需要操作外部网站、登录页、JS 重页面、没有 webfetch/VL 但需要浏览器、或需要在多种浏览器工具之间路由。
  Not for: localhost 页面预览（用 browser-preview）、本地 WebApp 确定性测试（用 webapp-testing）、简单网页抓取/搜索。
  Output: 选定浏览器后端 + 执行路径 + 证据/结果。
triggers:
  - "浏览器自动化"
  - "browser mcp"
  - "用浏览器"
  - "登录网站"
  - "登录态"
  - "agent-browser"
  - "pinchtab"
  - "playwriter"
  - "playwright mcp"
  - "没有 webfetch"
  - "无 webfetch"
  - "没有 vl"
---

# Browser Automation

这是家里的**上层浏览器路由 skill**。

它只做三件事：
- 判断这次任务该不该用浏览器
- 选择合适的浏览器后端
- 把任务转给更具体的 skill / ref，而不是在这里重复厂商文档

## 先按目的选入口

- **自动验证、Alpha 自验、截图取证**：使用猫自有的无头浏览器；本地 WebApp 走 `webapp-testing`，外部网页按下面的后端路由。运行服务和验证页面都不需要激活桌面。
- **给operator看 localhost 成品**：走 `browser-preview` 展示 Hub 内嵌面板。面板排队或未确认送达时保留原回执，不改用系统浏览器。
- **明确要求看着操作，或当前任务明确包含自有 profile 的可见首次登录**：走 `refs/playwright-mcp.md` 的显式可见分支；已有明确请求就直接执行该分支，不再索要一次工具配置批准。
- **接手人的已登录浏览器**：只有本任务明确需要并已获授权接手那个会话，才走 `refs/playwriter.md`。需要登录态、iframe 或无头执行失败，都不是自动接管人的 Chrome 的理由。

普通自动化默认无头。不要用系统 `open`、应用 activate、可见窗口或真实 Chrome 接管来自动兜底。账号必须本人确认时，交付可点击入口与恢复点，由人主动打开。

## 执行前四问

在真正执行浏览器操作前，先明确这四件事；已知答案直接沿用：

1. **真的需要浏览器吗？**
   如果只是读文档、抓纯文本、做搜索，不要默认上浏览器。
2. **目的是自动验证、展示成品，还是外部交互？**
   先按上面的目的选入口，再看目标主机；localhost 自测也走无头验证，不能一律路由成展示。
3. **这只猫的客户端能力是什么？**
   MCP 原生、CLI-only、是否有 `webfetch`、是否能跑 shell、是否有 VL。
4. **这次任务的 session 属于谁？**
   是匿名访问、猫自己的浏览器会话、还是接手人类已登录会话。

## 什么时候用

- 目标是**外部网站**，需要真实浏览器执行 JS、登录、点按钮、下载、截图
- 猫没有 `webfetch`，或者 `webfetch` 不足以完成交互
- 需要在 `agent-browser` / `Playwright MCP` / `Playwriter` / `PinchTab` 之间做路由
- 需要明确“这类浏览器任务的默认打法是什么”

## 不要用在这里

- `localhost` 页面预览、HMR、给operator看效果
  → 用 `browser-preview`
- 本地 WebApp 的确定性测试、Console、截图、回归验证
  → 用 `webapp-testing`
- 简单网页抓取、官方文档阅读、搜索结果整理
  → 优先用更轻量的搜索 / fetch 工具，不要先上浏览器
- 已有领域专用浏览器 skill 的任务
  → 专用 skill 优先

## 默认路由顺序

1. **先问：真的需要浏览器吗？**
   如果只是读文档、抓纯文本、做搜索，不要默认上浏览器。
2. **目标是本地 WebApp 验证吗？**
   是 → `webapp-testing`
3. **目的是给人展示 localhost 页面吗？**
   是 → `browser-preview` 的 Hub 内嵌面板
4. **客户端已经有稳定可用的 Playwright MCP 吗？**
   是 → `refs/playwright-mcp.md`（MCP ID: `playwright`）
5. **本任务明确获准接手人类现有 Chrome 会话吗？**
   是 → 用 `claude-in-chrome` MCP（工具前缀 `mcp__claude-in-chrome__*`），参考 `refs/playwriter.md`；复杂 iframe、多 tab 本身不要求接管人的会话
6. **这是 CLI 型猫，没 webfetch / 没 VL，但能跑命令吗？**
   是 → `refs/agent-browser.md`（MCP ID: `agent-browser`，社区 wrapper，使用前先做本机验活）
7. **需要长驻 daemon、持久 session、HTTP-first 服务吗？**
   是 → `refs/pinchtab.md`（MCP ID: `pinchtab`，优先 native binary `pinchtab mcp`，不要默认相信 npm wrapper）

## 路由矩阵

| 场景 | 默认 | MCP ID | 状态 |
|------|------|--------|------|
| 本地前端页面预览 | `browser-preview` | — | 独立 skill |
| 本地 WebApp 测试 / 回归 | `webapp-testing` + Playwright | `playwright` | 已接入 |
| MCP 原生客户端的常规网页自动化 | 无头 `Playwright MCP` | `playwright` | 受管描述符显式指定 `--headless` |
| 明确要求可见操作 / 明确包含自有 profile 可见首次登录 | 自有可见 Playwright 会话 | — | 按 `refs/playwright-mcp.md`，保持全局默认无头 |
| 明确获准接手人的已登录 Chrome | `claude-in-chrome` | `claude-in-chrome` | Chrome 扩展直接操作人的会话，后台导航也会改变其 tab |
| CLI 型猫、没 webfetch / 没 VL | `agent-browser` | — (CLI 工具) | ✅ 可用 — `npm i -g agent-browser`，通过 Bash tool 调 CLI |
| 服务化浏览器、持久化 session、重复批任务 | `PinchTab` | `pinchtab` | ✅ 已接入 — native binary `pinchtab mcp`（外网 URL 用 eval 导航，见 ref） |

## 常用组合打法

| 目标 | 组合 | 说明 |
|------|------|------|
| 外部网站调研 + 本地页面实现 | `browser-automation` + `browser-preview` | 前者看参考站，后者看我们自己的 localhost |
| 本地 WebApp 开发验收 | `browser-preview` + `webapp-testing` | 一个看效果，一个做确定性验证 |
| 接手人类已登录会话 | `browser-automation` + `refs/playwriter.md` | 明确是谁的 session，再做操作 |
| 重复批量抓取 / 长驻任务 | `browser-automation` + `refs/pinchtab.md` | 不是临时调试，而是服务化执行 |

## 读取哪些 refs

| Ref | MCP ID | 场景 |
|-----|--------|------|
| `refs/playwright-mcp.md` | `playwright` | 常规 MCP 原生网页自动化（默认） |
| `refs/playwriter.md` | `claude-in-chrome` | 已登录 Chrome / iframe-heavy / 多 tab（实际用 `mcp__claude-in-chrome__*` 工具） |
| `refs/agent-browser.md` | — (CLI 工具) | CLI 型猫 / 无 webfetch / 无 VL |
| `refs/pinchtab.md` | `pinchtab` | 服务化、持久 session、HTTP-first |

## 交付要求

每次真正使用浏览器后端，至少说清楚这四件事：

- **用了哪个后端**，为什么不是另一个
- **目标站点 / 路径** 是什么
- **是否涉及登录态**；如果涉及，是谁的 session
- **留下了什么证据**：截图、提取文本、Console、下载文件、操作结果

如果任务涉及人类账号：
- 不要默认代替人类登录敏感站点
- 明确说明是否是“接手现有已登录会话”
- 结束时说明是否保留了 session / cookie / tab 状态

## Common Mistakes

| 错误 | 后果 | 修复 |
|------|------|------|
| 把 `browser-preview` 并进本 skill | localhost 和外部网站边界糊掉 | 保持独立 skill，只在这里路由 |
| 默认所有猫都装同一套浏览器后端 | CLI/MCP/登录态需求互相打架 | 先按场景选，再按客户端能力落工具 |
| 在主 skill 里复制厂商文档 | 一改后端就大面积漂移 | 厂商细节压到 `refs/` |
| 简单抓取先上浏览器 | 成本高、速度慢、失败面更大 | 先判断是否能用更轻量工具 |
| 把所有 localhost 操作都路由成展示 | 自测被误当作要给人开页面 | 先按自动验证 / 展示 / 外部交互区分，再看主机 |
| 把需要登录或无头失败当作开窗许可 | 自动化打断人的桌面 | 保留无头默认；显式可见操作用自有 profile，本人确认交可点击入口 |
| 登录态责任不清楚就开干 | 容易误用人类 session | 先说清 session 属于谁，再动手 |
| 做完只说”好了”不留证据 | 后续无法验收或复现 | 至少交付 URL/截图/文本/日志中的一种 |
| PinchTab 外网用 `pinchtab_navigate` | Clash TUN 下 403（Go 层 DNS 预检拦截 `198.18.x.x`） | 用 `pinchtab_eval` + `window.location.href` 导航，详见 `refs/pinchtab.md` |

## 和其他 skill 的区别

| Skill | 关注点 |
|-------|--------|
| `browser-automation` | 外部网站浏览器工具的总路由和选型 |
| `browser-preview` | Hub 内预览 localhost 页面 |
| `webapp-testing` | 用 Playwright 做本地 WebApp 验证 |
| 领域专用浏览器 skill | 某个网站 / 某类提取任务的专用流程 |

## 下一步

- `localhost` 页面 → `browser-preview`
- 本地 WebApp 验证 → `webapp-testing`
- 其余外部网站任务 → 读取匹配的 `refs/*.md` 后执行
