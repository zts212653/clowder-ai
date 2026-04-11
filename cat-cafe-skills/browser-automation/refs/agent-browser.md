# Agent Browser Reference

## 是什么

- Vercel 的 CLI-first 浏览器自动化工具（Apache-2.0）
- 面向 coding agent / CLI agent，核心工作流：`open` → `snapshot -i` → `click @e1`
- 基于 accessibility tree + stable refs，不需要视觉模型
- **不是 MCP server** — 猫通过 Bash tool 直接调 CLI 命令使用

## 什么时候优先

- 猫没有 `webfetch`
- 猫没有 VL，但能跑 shell 命令
- 想要 token 更省的 ref 工作流
- 任务是外部网站的常规导航、表单、按钮点击、简单登录流程

## 接入前提

- 客户端能执行 shell 命令（Bash tool）
- 全局安装：`npm install -g agent-browser`
- 需要代理时：`AGENT_BROWSER_PROXY=http://127.0.0.1:7897 agent-browser open <url>`
- 如果任务涉及登录态，先明确 session 由谁持有

## 不适合

- 当成 localhost 预览方案
- 当成通用搜索引擎 / 文档抓取替代
- 服务化浏览器后端（那是 PinchTab 的活）

## 典型用法

```bash
agent-browser open https://example.com        # 打开页面
agent-browser snapshot -i                      # 拿可交互元素的 accessibility tree
agent-browser click @e2                        # 点击 ref=e2 的元素
agent-browser fill @e5 "hello"                 # 填写输入框
agent-browser screenshot                       # 截图
agent-browser get text                         # 提取页面文本
agent-browser close                            # 关闭浏览器
```

## 在家里的定位

- 默认给 CLI-only / 无 `webfetch` / 无 VL 的猫（如 opencode 上的 glm）
- 是 CLI 工具，不走 MCP — 猫直接用 Bash tool 调命令
- 不取代 `browser-preview`（localhost）或 Playwright MCP（MCP 型猫的默认）

## 官方 Skill

Vercel 提供了第一方 Claude Code skill，可作为我们路由的外部参考：
- https://github.com/vercel-labs/agent-browser/tree/main/skills/agent-browser

## 官方来源

- https://github.com/vercel-labs/agent-browser
- https://agent-browser.dev/
- https://agent-browser.dev/security
