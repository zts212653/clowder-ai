# Playwright MCP Reference

## 是什么

- Microsoft 官方 MCP server
- 面向 MCP 原生客户端，提供结构化浏览器工具
- 官方文档明确强调 accessibility snapshot 工作流，不要求 vision model

## 什么时候优先

- 客户端原生支持 MCP
- 任务是常规网页自动化、截图、Console、页面检查
- 想要稳定、标准化的浏览器工具面
- 本地 WebApp 验证需要和现有 Playwright 生态对齐

## 接入前提

- 客户端已经稳定接好 MCP
- 任务更偏工具面稳定，而不是“接手某个现有浏览器会话”
- 如果是本地 WebApp 验证，优先跟 `webapp-testing` 绑定使用

## 不适合

- 拿来做 localhost 页面“给铲屎官看效果”的预览入口
- 在 CLI-only 场景里硬替代更适合的 agent-browser

## 额外提示

- 我们家本地 WebApp 的确定性验证，优先和 `webapp-testing` 搭配
- 对“接手已登录的人类 Chrome”这条 lane，不一定是最顺手的默认

## 在家里的定位

- MCP 原生客户端的默认浏览器后端
- 不是 localhost 预览入口
- 不是登录态接管 lane 的默认解法

## 官方来源

- https://github.com/microsoft/playwright-mcp
