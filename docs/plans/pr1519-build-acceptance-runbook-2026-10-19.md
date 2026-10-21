---
feature_ids: [PR1519]
topics: [desktop, installer, windows, acceptance, client-detection]
doc_kind: plan
created: 2026-10-19
---

# PR #1519 构建与安装验收门禁

这份门禁把源码、归档、安装器和运行实例绑定到同一个 exact HEAD。任何一步失败都不得把 EXE 交给用户，也不得用旧包的截图、日志或真实调用替代当前 HEAD 的证据。

## 构建前

1. 在 `worktrees/feat-onboarding-first-run` 执行 `git rev-parse HEAD`，记录 `sourceSha`；工作树必须没有未提交代码改动。`artifacts/` 只存证据，不进入发布输入。
2. 停止或复用同一任务台账中已确认归属的临时实例。不得按通用进程名批量结束 Electron、Node 或 Redis；保留用户正在验收的实例和所有 HOME、Redis、SQLite、会话及认证。
3. 清理构建输出后重新生成 Web/API、MCP、Electron、Node 和依赖 frozen archives。每个归档必须存在、大小大于 0，并通过归档校验；缺失、0 字节、SHA 不匹配立即 No-Go。
4. API 的运行时脚本、Electron `app.asar` 和 `app.asar.unpacked` 必须由构建后真实条目检查覆盖，不能只依靠源码字符串或依赖图测试。

## 安装器门禁

1. Inno 编译只使用本次 `sourceSha` 生成的归档。`build-manifest.json` 必须同时记录 source SHA、每个归档 SHA/大小、Setup SHA、版本和完整性标签。
2. 编译输出和最终交付副本都执行 `desktop/scripts/installer-integrity.mjs --check`。标签必须为 `High` 或普通无强制标签；Low/Medium、检查失败或无法纠正都阻止交付。纠正标签后再次核对 SHA 不变。
3. 交付副本只能通过脚本复制并写入最终路径，不能普通复制覆盖既有交付目录。最终 EXE、manifest、日志和验收记录放在任务专属 `artifacts/` 目录，不散落桌面。
4. 首装测试使用新的程序目录和新的实例 HOME，实例端口独立；安装参数中的 `/DIR` 必须完整引用，测试无快捷方式时使用 `/TASKS="!desktopicon"`。首装不能用覆盖升级冒充。
5. 安装日志必须包含所有归档 `EXTRACT|complete`、退出码 0、安装完成和关闭记录。出现 `is-*.tmp` 拒绝访问、MoveFile 183、帮助参数弹窗或提权失败均为 No-Go。
6. 生产安装器的默认目录必须保持 `{autopf}\ClowderAI`（Windows 通常为 `C:\Program Files\ClowderAI`）。自动化调用 `/DIR` 时必须把含空格的完整路径作为一个带引号的参数；未加引号会被 Inno 截断为 `C:\Program`，不能把该调用错误当作产品默认目录。安装后启动必须使用 `runasoriginaluser`，避免管理员安装上下文污染首次运行的用户 HOME。

## 首次启动与客户端检测

1. 首次启动必须读取 `startup-state.json` 为 `phase=ready`，记录启动耗时；`desktop.log` 必须包含 project mirror readiness、Redis、API、Web 和 all-services 完成记录。
2. 通过 API `/api/health`、`/api/ready`、Web 入口和 `/api/cats` 回读；干净实例的角色和历史为空。不得把认证或角色历史复制到测试 HOME。
3. 若要复用宿主机已登录客户端，只写入实例 `client-homes.json` 的明确映射，不复制令牌；映射目录只读验证。检测结果必须与实际配置一致：Claude 同时识别 CLI 凭据和 `settings.json.env.ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`，且任何返回值不得泄露凭据；Codex 等客户端必须以同样的实例 HOME 规则检测。
   普通非隔离安装也必须由 API 显式绑定当前用户实际存在的 Claude/Codex/DSH/Kimi/Pi 目录；这只是环境变量映射，不复制凭据、会话或历史。没有目录的客户端不应凭空标记为已登录。
4. 一键检测和手动添加是两个独立入口。取消一个客户端后不能阻塞其他已勾选客户端；创建后用 GET 回读角色和首条消息，失败原因必须可见。

## 托盘与退出生命周期

1. `main.log` 必须记录 `tray-create-requested`、`tray-created` 或带错误的 `tray-create-failed`，以及图标路径存在性。托盘失败不得静默降级成无入口进程。
2. 手动关闭窗口后必须记录 `window-close-requested` 和 `window-close-hidden`；5 秒后主 PID、API、Web、Redis 仍存活且端口仍监听。托盘“显示”恢复窗口后再验证。
3. 显式退出、更新器退出和安装器退出分别只能执行一次清理，记录 `before-quit`/`quit-requested`，并释放端口。第二次启动只能恢复已有实例，不得创建第二套服务。
4. 无法使用原生桌面控制时，只报告日志、PID、窗口句柄和端口证据，不声称已经视觉确认托盘图标。

## 交付与收尾

交付清单必须包含 exact HEAD、EXE SHA-256、完整性标签、归档清单、安装路径、实例 HOME、端口/PID、启动/托盘日志路径和未验证项。验收完成后停止作者临时进程，归档已核验的测试会话，保留用户环境、配置和历史；重复安装包、失效快捷方式和中间程序按台账清理。PR 评论只能引用当前 HEAD 的证据，并逐条说明已修复、仍阻塞和不在范围内的审查意见。

