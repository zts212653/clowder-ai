---
name: browser-automation
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

## 执行前四问

在真正打开浏览器前，先回答这四个问题：

1. **真的需要浏览器吗？**
   如果只是读文档、抓纯文本、做搜索，不要默认上浏览器。
2. **需要既有人类登录会话吗？**
   是 → 在已有授权内选择该会话所属的浏览器后端，参考 `refs/playwriter.md`。
3. **目标是本地验证吗？**
   预览/展示 → `browser-preview`；确定性测试/回归 → `webapp-testing`。核对实际 worktree 与服务地址。
4. **需要长驻 daemon / 持久 session 吗？**
   是 → `refs/pinchtab.md`，保留网络、会话与权限边界。
5. **其余常规网页自动化**
   按当前可用能力选择 Playwright MCP（`refs/playwright-mcp.md`）；CLI 型工作可选 `refs/agent-browser.md`。后端可用不覆盖前面的任务/session 约束。

## 路由矩阵

| 场景 | 默认 | MCP ID | 状态 |
|------|------|--------|------|
| 本地前端页面预览 | `browser-preview` | — | 独立 skill |
| 本地 WebApp 测试 / 回归 | `webapp-testing` + Playwright | `playwright` | 已接入 |
| MCP 原生客户端的常规网页自动化 | `Playwright MCP` | `playwright` | ✅ 已接入 — `npx @playwright/mcp@latest` |
| 已登录 Chrome、iframe-heavy、手工接管 | `claude-in-chrome` | `claude-in-chrome` | ✅ 已接入 — Chrome 扩展管理，无需手动启动 |
| CLI 型猫、没 webfetch / 没 VL | `agent-browser` | — (CLI 工具) | ✅ 可用 — `npm i -g agent-browser`，通过 Bash tool 调 CLI |
| 服务化浏览器、持久化 session、重复批任务 | `PinchTab` | `pinchtab` | ✅ 已接入 — native binary `pinchtab mcp`（保留目标网络校验，见 ref） |

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
| 把本地测试和外部网站操作混成一个动作 | 路由混乱，证据链不清楚 | `localhost` 和外部网站分开处理 |
| 登录态责任不清楚就开干 | 容易误用人类 session | 先说清 session 属于谁，再动手 |
| 做完只说”好了”不留证据 | 后续无法验收或复现 | 至少交付 URL/截图/文本/日志中的一种 |
| 将网络拒绝当普通工具故障绕过 | 可能越过 SSRF/内网边界 | 核对目标与授权，使用保留等效校验的配置；不得用 eval 绕过 |

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
