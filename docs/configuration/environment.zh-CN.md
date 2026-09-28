# 环境变量

> 首次运行前，将 `.env.example` 复制为 `.env`：
>
> ```bash
> cp .env.example .env
> ```
>
> 大多数默认值开箱即用。只有当你想更改端口、启用局域网访问或配置 Redis 时，才需要编辑 `.env`。
>
> **API 密钥**应在启动后通过 UI 添加，而不是写入 `.env`。参见 [FAQ](../faq.md#在哪里添加-api-密钥)。

---

## 核心端口

| 变量                         | 默认值        | 说明 |
|------------------------------|---------------|-------------|
| `FRONTEND_PORT`              | `3003`        | Web UI 端口（Hub 前端） |
| `API_SERVER_PORT`            | `3004`        | API 服务器端口。约定：前端端口 + 1 |
| `API_SERVER_HOST`            | `127.0.0.1`   | 绑定地址。设为 `0.0.0.0` 以允许局域网、Tailscale 或 Docker 访问 |
| `CORS_ALLOW_PRIVATE_NETWORK` | *(未设置)*     | 设为 `true` 以允许本地网络中的手机/平板访问。需要 `API_SERVER_HOST=0.0.0.0` |
| `MCP_SERVER_PORT`            | `3011`        | MCP（Model Context Protocol）服务器端口 |

## 所有者身份

| 变量                     | 默认值           | 说明 |
|--------------------------|------------------|-------------|
| `DEFAULT_OWNER_USER_ID`  | `default-user`   | 用于特权操作的所有者身份。敏感环境变量写入需要它 —— 身份不匹配的请求会收到 403 |

## 工作区

| 变量                     | 默认值  | 说明 |
|--------------------------|---------|-------------|
| `ALLOWED_WORKSPACE_DIRS` | *(未设置)* | MCP 服务器允许访问的目录列表，以逗号分隔。示例：`/home/me/projects,/home/me/notes` |

## Redis

| 变量                  | 默认值                     | 说明 |
|-----------------------|----------------------------|-------------|
| `REDIS_PORT`          | `6399`                     | Redis 端口 |
| `REDIS_URL`           | `redis://localhost:6399`   | 完整的 Redis 连接 URL |
| `MESSAGE_TTL_SECONDS` | `0`                        | 消息保留时长（秒）。`0` = 永久 |
| `THREAD_TTL_SECONDS`  | `0`                        | 线程保留时长（秒）。`0` = 永久 |
| `TASK_TTL_SECONDS`    | `0`                        | 任务保留时长（秒）。`0` = 永久 |

> 如果使用 `pnpm start --memory` 运行，则不会用到 Redis，上述设置也不会生效。

## 模型 API 密钥

API 密钥最好在启动后通过 UI 管理：

> **Hub --> System Settings --> Account Configuration**

`.env` 文件支持将密钥变量作为遗留的后备方案，但对大多数用户而言，推荐使用 UI 方式。通过 UI 添加的密钥会被安全存储，并自动提供给所有 Agent 使用。

## 其他

| 变量                      | 默认值           | 说明 |
|---------------------------|------------------|-------------|
| `NEXT_PUBLIC_API_URL`     | *(自动推导)* | 前端使用的 API URL。通常会根据 `API_SERVER_PORT` 自动计算；仅在使用反向代理或自定义域名时才需覆盖 |
| `NEXT_PUBLIC_BRAND_NAME`  | `Clowder AI`     | UI 中显示的品牌名称 |
| `CLI_TIMEOUT_MS`          | `1800000`        | CLI 不活跃超时，单位毫秒（30 分钟）。设为 `0` 可禁用 |
