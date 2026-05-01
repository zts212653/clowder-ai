# 用户级 Hooks（跟着人走，所有项目生效）

这些 hook 放在 `~/.claude/hooks/`（用户级），不是项目级。
项目里这份是**参考副本**，方便其他猫或新环境部署。

## 部署方式

### Claude Code
```bash
cp .claude/hooks/user-level/session-*.sh ~/.claude/hooks/
chmod +x ~/.claude/hooks/session-*.sh
```
然后在 `~/.claude/settings.json` 的 `hooks` 里加 SessionStart 和 Stop 条目。
可参考同目录的 `claude-settings.template.json`；模板只使用 `$HOME`，不携带维护者机器上的绝对路径。
建议优先用 Hub 的 Sync hooks 一键修复；手动复制 template 后，Hub 可能因路径规范化差异继续提示 stale，此时按提示再 sync 一次即可。

### Codex CLI
创建 `~/.codex/hooks.json`，引用同一份脚本：
```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "~/.claude/hooks/session-start-recall.sh" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "~/.claude/hooks/session-stop-check.sh" }] }]
  }
}
```

## 架构：用户级 vs 项目级

| 层 | 位置 | 生效范围 | 内容 |
|---|---|---|---|
| 用户级 | `~/.claude/hooks/` | 所有项目（出征也带着走） | SessionStart/Stop 通用纪律 |
| 项目级 | `.claude/hooks/` | 只在 cat-cafe | evidence guard、runtime sanctuary 等项目特有守卫 |

这样猫猫出征时基础纪律跟着走，项目特有的不会误触发。
