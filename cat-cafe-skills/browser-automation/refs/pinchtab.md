# PinchTab Reference

## 是什么

- HTTP-first 的本地浏览器控制服务
- 自带 CLI，但核心心智更像“常驻浏览器后端”
- 适合持久 session、批量重复任务、服务化接入

## 什么时候优先

- 需要长驻 daemon
- 需要持久 cookies / tabs / auth state
- 需要 HTTP-first 集成，而不是 MCP-first / CLI-first
- 同一类网站任务会反复跑很多次

## 接入前提

- 这不是临时交互，而是准备长期运行的浏览器后端
- 需要明确 token / auth / session 的存放和轮换方式
- 最好有专门的 specialist skill 或脚本包裹

## 不适合

- 做大家的默认日常浏览器入口
- 替代 localhost 页面预览
- 临时一两次的轻量网页操作

## 额外提示

- 我这轮没有查到第一方 `SKILL.md` / `AGENTS.md`
- 如果家里后面采用它，建议再补一份我们自己的 specialist skill

## 在家里的定位

- 不是默认入口
- 适合”服务化浏览器能力”这一条专门 lane
- **MCP ID**: `pinchtab`（capabilities.json 中注册）
- **启动命令**: `npx pinchtab-mcp`（专用 MCP server 包）
- 工具前缀：`mcp__pinchtab__*`

## 安装

```bash
# 自动按需下载（npx），无需预装
# pinchtab-mcp 是专用 MCP server，底层控制 Chrome via accessibility tree
# 特点：token 高效（~800 tokens/page），支持 headless/headed、多实例并行
```

## 官方来源

- https://pinchtab.com/
- https://pinchtab.com/docs/
- https://github.com/pinchtab/pinchtab
- MCP server: https://www.npmjs.com/package/pinchtab-mcp
