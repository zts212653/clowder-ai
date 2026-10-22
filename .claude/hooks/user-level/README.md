# 用户级 Hooks（跟着人走，所有项目生效）

这些 hook 放在 `~/.claude/hooks/`（用户级），不是项目级。
项目里这份是安装模板。安装器从当前部署档案绑定称谓；安装后的脚本不依赖当前项目、API 或配置文件。

## 部署方式

### Claude Code
```bash
pnpm --filter @cat-cafe/api build
node desktop/scripts/sync-agent-hooks-offline.mjs --project-root "$PWD" --target-root "$HOME"
```
此入口与 Hub 的 Sync hooks 共用 producer，会写入 SessionStart 和 Stop 条目。
可参考同目录的 `claude-settings.template.json`；模板只使用 `$HOME`，不携带维护者机器上的绝对路径。
也可以用 Hub 的 Sync hooks 一键修复。不要直接复制 `.sh` 模板；称谓变量必须由安装器作为数据绑定，不能在 shell 中求值执行。

> **Windows 用户**：需要安装 [Git for Windows](https://gitforwindows.org/)（提供 Git Bash）。
> Hook 命令通过 `bash` 显式调用，确保跨平台执行。如果不装 Git Bash，
> `.sh` 文件会被 VS Code 等编辑器打开而不是执行。

### Codex CLI
创建 `~/.codex/hooks.json`，引用同一份脚本：
```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "bash \"$HOME/.claude/hooks/session-start-recall.sh\"" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "bash \"$HOME/.claude/hooks/session-stop-check.sh\"" }] }]
  }
}
```

## 架构：用户级 vs 项目级

| 层 | 位置 | 生效范围 | 内容 |
|---|---|---|---|
| 用户级 | `~/.claude/hooks/` | 所有项目（出征也带着走） | SessionStart/Stop 通用纪律 |
| 项目级 | `.claude/hooks/` | 只在 cat-cafe | evidence guard、runtime sanctuary 等项目特有守卫 |

这样猫猫出征时基础纪律跟着走，项目特有的不会误触发。
