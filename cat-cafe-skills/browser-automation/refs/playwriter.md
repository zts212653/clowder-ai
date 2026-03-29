# Playwriter / claude-in-chrome Reference

## 是什么

- 这条 lane 的核心需求：**接手已经开着、已经登录的 Chrome**
- 家里实际使用 **`claude-in-chrome`** MCP（Chrome 扩展提供），MCP ID: `claude-in-chrome`
- 工具前缀：`mcp__claude-in-chrome__*`（navigate / read_page / form_input / javascript_tool / tabs_context_mcp 等）
- 原 `Playwriter` 是社区参考项目（`remorses/playwriter`），核心卖点是把完整 Playwright API 暴露给 agent

## 什么时候优先

- 需要接手人类已经登录的浏览器会话
- 多 tab 调试
- iframe-heavy 页面
- 任务要求完整 Playwright API 的表达力

## 接入前提

- 已有正在运行的人类浏览器会话
- 操作前说清楚这次是在“接手现有会话”，不是猫自己新登录
- 任务真的需要 tab / frame / 完整 Playwright API 的表达力

## 不适合

- 给所有猫做默认浏览器后端
- 替代 localhost 页面预览
- 当成轻量抓取工具

## 额外提示

- 这是 specialist lane，不是我们家的默认总后端
- 只有当“已有 Chrome 会话”或“复杂 frame / tab 交互”是核心需求时才优先

## 在家里的定位

- 登录态 / iframe-heavy / 多 tab 的专门 lane
- 没有这些约束时，不要默认选它
- **MCP ID**: `claude-in-chrome`（capabilities.json 中注册，Chrome 扩展管理）

## 快速使用

```
# 1. 先获取当前 tab 上下文
mcp__claude-in-chrome__tabs_context_mcp

# 2. 导航到目标页面（或使用已有 tab）
mcp__claude-in-chrome__navigate(url="...")

# 3. 读取页面内容
mcp__claude-in-chrome__read_page / get_page_text

# 4. 交互
mcp__claude-in-chrome__form_input / find / javascript_tool
```

## 官方来源

- claude-in-chrome: Chrome 扩展（铲屎官已安装）
- Playwriter 参考: https://playwriter.dev/ / https://github.com/remorses/playwriter
