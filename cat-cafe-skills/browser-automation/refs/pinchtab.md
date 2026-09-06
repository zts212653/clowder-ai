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
- **启动命令**: 优先本机 binary 的 `pinchtab mcp`
- 工具前缀：`mcp__pinchtab__*`

## 代理与网络边界

部分代理环境使用 fake-IP，可能使导航的地址预检与实际连接路径不一致。这是需要查证的兼容性问题，不是绕过 SSRF/内网目标校验的许可。

遇到 403 或 private/internal IP 拒绝时，先核对目标、重定向与已授权网络范围。使用保留等效目标校验的受支持代理配置；若切换浏览器后端，也必须保留相同网络与权限边界。不得用 eval、脚本导航或另一个后端规避真实拒绝。

工具不可达或缺配置时如实报告。配置是否允许 evaluate 以当前实例为准，不假定用户 HOME 中已启用，也不擅自修改运行配置。

## 安装

```bash
# 优先使用 pinchtab 自带 MCP 模式
# 旧的 pinchtab-mcp npm wrapper 可能落后于当前 binary 命令集
# 使用前先验证 `pinchtab mcp` 能完成 initialize 握手
```

## 官方来源

- https://pinchtab.com/
- https://pinchtab.com/docs/
- https://github.com/pinchtab/pinchtab
- MCP server: https://www.npmjs.com/package/pinchtab-mcp
