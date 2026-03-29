# Agent Browser Reference

## 是什么

- Vercel 的 CLI-first 浏览器工具
- 面向 coding agent / CLI agent，常见动作是 `open` / `snapshot -i` / `click @e1`
- 官方有第一方 Claude Code skill，可作为我们内部路由的外部参考

## 什么时候优先

- 猫没有 `webfetch`
- 猫没有 VL，但能跑 shell 命令
- 想要 token 更省的 ref 工作流
- 任务是外部网站的常规导航、表单、按钮点击、简单登录流程

## 接入前提

- 客户端能执行 shell 命令
- 目标环境允许访问真实浏览器或远端浏览器 provider
- 如果任务涉及登录态，先明确 session 由谁持有

## 不适合

- 当成 localhost 预览方案
- 当成通用搜索引擎 / 文档抓取替代
- 服务化浏览器后端

## 额外提示

- 支持 frame 切换，但 iframe-heavy 站点通常不如完整 Playwright API 顺手
- 如果客户端已经有稳定 Playwright MCP，常规任务不一定要切到它

## 在家里的定位

- 默认给 CLI-only / 无 `webfetch` / 无 VL 的猫
- 是 specialist backend，不取代 `browser-preview`
- **MCP ID**: `agent-browser`（capabilities.json 中注册）
- **启动命令**: `npx agent-browser-mcp`（社区 MCP wrapper，封装 Vercel CLI 为标准 MCP）
- 工具前缀：`mcp__agent-browser__*`

## 安装

```bash
# 自动按需下载（npx），无需预装
# 首次使用时 npx 会下载 agent-browser-mcp 包
# 底层依赖 Vercel agent-browser CLI
```

## 官方来源

- https://github.com/vercel-labs/agent-browser
- https://agent-browser.dev/
- MCP wrapper: https://github.com/minhlucvan/agent-browser-mcp
