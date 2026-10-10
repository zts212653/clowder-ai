# Environment Variables

> Copy `.env.example` to `.env` before your first run:
>
> ```bash
> cp .env.example .env
> ```
>
> Most defaults work out of the box. You only need to edit `.env` if you want to change ports, enable LAN access, or configure Redis.
>
> **API keys** should be added through the UI after launch, not in `.env`. See [FAQ](../faq.md#where-do-i-add-api-keys).

---

## Core Ports

| Variable                     | Default       | Description |
|------------------------------|---------------|-------------|
| `FRONTEND_PORT`              | `3003`        | Web UI port (Hub 前端端口) |
| `API_SERVER_PORT`            | `3004`        | API server port. Convention: Frontend port + 1 (API 服务端口) |
| `API_SERVER_HOST`            | `127.0.0.1`   | Bind address. Set to `0.0.0.0` for LAN, Tailscale, or Docker access (绑定地址，设为 0.0.0.0 以允许局域网访问) |
| `CORS_ALLOW_PRIVATE_NETWORK` | *(unset)*     | Set to `true` to allow phones/tablets on your local network. Requires `API_SERVER_HOST=0.0.0.0` (允许局域网内设备访问) |
| `MCP_SERVER_PORT`            | `3011`        | MCP (Model Context Protocol) server port |

## Owner Identity

| Variable                 | Default          | Description |
|--------------------------|------------------|-------------|
| `DEFAULT_OWNER_USER_ID`  | `default-user`   | Owner identity for privileged operations. Required for sensitive env writes -- requests without a matching identity receive 403 (所有者身份标识，敏感操作需匹配此值) |

## Workspace

| Variable                 | Default | Description |
|--------------------------|---------|-------------|
| `ALLOWED_WORKSPACE_DIRS` | *(unset)* | Comma-separated list of directories the MCP server is allowed to access. Example: `/home/me/projects,/home/me/notes` (MCP 服务可访问的目录白名单) |

## Redis

| Variable              | Default                    | Description |
|-----------------------|----------------------------|-------------|
| `REDIS_PORT`          | `6399`                     | Redis port |
| `REDIS_URL`           | `redis://localhost:6399`   | Full Redis connection URL |
| `MESSAGE_TTL_SECONDS` | `0`                        | Message retention in seconds. `0` = permanent (消息保留时长，0 为永久) |
| `THREAD_TTL_SECONDS`  | `0`                        | Thread retention in seconds. `0` = permanent (线程保留时长) |
| `TASK_TTL_SECONDS`    | `0`                        | Task retention in seconds. `0` = permanent (任务保留时长) |

> If you run with `pnpm start --memory`, Redis is not used and these settings have no effect.

## Model API Keys

API keys are best managed through the UI after launch:

> **Hub --> System Settings --> Account Configuration**

The `.env` file supports key variables as a legacy fallback, but the UI approach is recommended for most users. Keys added through the UI are stored securely and made available to all agents automatically.

## Other

| Variable                  | Default          | Description |
|---------------------------|------------------|-------------|
| `NEXT_PUBLIC_API_URL`     | *(auto-derived)* | API URL used by the frontend. Normally computed automatically from `API_SERVER_PORT`; override only if you use a reverse proxy or custom domain |
| `NEXT_PUBLIC_BRAND_NAME`  | `Clowder AI`     | Brand name shown in the UI (界面显示的品牌名称) |
| `CLI_TIMEOUT_MS`          | `0`              | Member no-output timeout in milliseconds: a member with no output (text, tool calls, thinking) for this long is stopped as if by Stop, and its reply fails as timed out; a member whose process is still using CPU gets at most twice as long. `0` (default) disables it, so only a manual stop ends a silent turn (成员无输出超时，默认 0 即不超时) |
