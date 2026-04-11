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

## Clash TUN 环境注意事项

家里用 Clash TUN 代理，所有域名解析到 `198.18.x.x` 虚拟 IP。pinchtab 的 `nav` 命令在 Go 层做 DNS 预检，会把这些 IP 判定为 reserved 而 403 拒绝。

**workaround**：用 `eval` 让浏览器自己导航（浏览器带 `--proxy-server`，DNS + 连接都走代理）：

```bash
# ✗ nav 被 Go 层 SSRF 预检拦截
pinchtab nav https://example.com  # → 403 blocked private/internal IP

# ✓ eval 绕过 Go 层，浏览器走代理正常到达
pinchtab eval 'window.location.href = "https://example.com"'
pinchtab text  # 正常读取页面
```

localhost 导航不受影响，`pinchtab_navigate` 对 localhost 正常工作。

需要 `security.allowEvaluate = true`（已在 `~/.pinchtab/config.json` 启用）。

### MCP 工具用法

猫通过 MCP 使用 pinchtab 时，外网导航用 `pinchtab_eval` 替代 `pinchtab_navigate`：

```
# ✗ pinchtab_navigate → 403
mcp__pinchtab__pinchtab_navigate({ url: "https://example.com" })

# ✓ pinchtab_eval → 浏览器自己走代理
mcp__pinchtab__pinchtab_eval({ expression: 'window.location.href = "https://example.com"' })

# 导航后正常用其他工具读取
mcp__pinchtab__pinchtab_get_text()
mcp__pinchtab__pinchtab_screenshot()
mcp__pinchtab__pinchtab_snapshot()
```

### 根因

pinchtab Go 进程在把 URL 交给浏览器前，先用 `net.LookupHost()` 做 DNS 解析。Clash TUN 把所有域名解析到 `198.18.0.0/15`（RFC 2544 reserved），Go 层判定为 private IP → 403。但浏览器带 `--proxy-server`，DNS 和连接都走 Clash 代理，完全能到达目标。这是 pinchtab 上游的 limitation — SSRF 预检没考虑浏览器有自己的代理配置。

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
