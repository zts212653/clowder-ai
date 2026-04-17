/**
 * Environment variable registry — single source of truth for all user-configurable env vars.
 * Used by GET /api/config/env-summary to report current values to the frontend.
 *
 * ⚠️  ALL CATS: 新增 process.env.XXX → 必须在下方 ENV_VARS 数组注册！
 *    不注册 = 前端「环境 & 文件」页面看不到 = 铲屎官不知道 = 不存在。
 *    SOP.md「环境变量注册」章节有说明。
 *
 * To add a new env var:
 * 1. Add an EnvDefinition to ENV_VARS below
 * 2. Use process.env[name] in your code as usual
 * The "环境 & 文件" tab picks it up automatically.
 */

import { DEFAULT_CLI_TIMEOUT_LABEL } from '../utils/cli-timeout.js';

export type EnvCategory =
  | 'server'
  | 'storage'
  | 'budget'
  | 'cli'
  | 'proxy'
  | 'connector'
  | 'codex'
  | 'dare'
  | 'gemini'
  | 'kimi'
  | 'tts'
  | 'stt'
  | 'frontend'
  | 'push'
  | 'signal'
  | 'github_review'
  | 'evidence'
  | 'quota'
  | 'telemetry';

export interface EnvDefinition {
  /** The env var name, e.g. 'REDIS_URL' */
  name: string;
  /** Default value description (for display, not logic) */
  defaultValue: string;
  /** Human-readable description (Chinese) */
  description: string;
  /** Grouping category */
  category: EnvCategory;
  /** If true, current value is masked as '***' in API response */
  sensitive: boolean;
  /** If 'url', credentials in URL are masked but host/port/db preserved */
  maskMode?: 'url';
  /** If false, keep internal-only and do not surface in Hub env editor */
  hubVisible?: boolean;
  /** If false, value is bootstrap-only and cannot be edited at runtime from Hub */
  runtimeEditable?: boolean;
  /** If true, this var should appear in .env.example (enforced by check:env-example) */
  exampleRecommended?: boolean;
}

export const ENV_CATEGORIES: Record<EnvCategory, string> = {
  server: '服务器',
  storage: '存储',
  budget: '猫猫预算',
  cli: 'CLI',
  proxy: 'Anthropic 代理网关',
  connector: '平台接入 (Telegram/飞书)',
  codex: '缅因猫 (Codex)',
  dare: '狸花猫 (Dare)',
  gemini: '暹罗猫 (Gemini)',
  kimi: 'Kimi',
  tts: '语音合成 (TTS)',
  stt: '语音识别 (STT)',
  frontend: '前端',
  push: '推送通知',
  signal: 'Signal 信号源',
  github_review: 'GitHub Review 监控',
  evidence: 'F102 记忆系统',
  quota: '额度监控',
  telemetry: '可观测性 (OTel)',
};

export const ENV_VARS: EnvDefinition[] = [
  // --- server ---
  {
    name: 'API_SERVER_PORT',
    defaultValue: '3004',
    description: 'API 服务端口',
    category: 'server',
    sensitive: false,
    runtimeEditable: false,
    exampleRecommended: true,
  },
  {
    name: 'PREVIEW_GATEWAY_PORT',
    defaultValue: '4100',
    description: 'Preview Gateway 端口（F120 独立 origin 反向代理）',
    category: 'server',
    sensitive: false,
    runtimeEditable: true,
  },
  {
    name: 'API_SERVER_HOST',
    defaultValue: '127.0.0.1',
    description: 'API 监听地址（改为 0.0.0.0 可让手机/平板通过局域网或 Tailscale 访问）',
    category: 'server',
    sensitive: false,
  },
  {
    name: 'CORS_ALLOW_PRIVATE_NETWORK',
    defaultValue: 'false',
    description:
      '允许局域网/Tailscale 设备访问（手机、平板等）。开启后，来自 192.168.x.x / 10.x.x.x / Tailscale 100.x.x.x 的浏览器可以正常连接。注意：会信任整个私网内的所有设备。修改后需重启服务生效',
    category: 'server',
    sensitive: false,
    runtimeEditable: false,
    exampleRecommended: true,
  },
  { name: 'UPLOAD_DIR', defaultValue: './uploads', description: '文件上传目录', category: 'server', sensitive: false },
  {
    name: 'PROJECT_ALLOWED_ROOTS',
    defaultValue: '(未设置 — 使用 denylist 模式，仅拦截系统目录)',
    description:
      'Legacy allowlist 模式：设置后切换为 allowlist，仅允许列出的根目录（按系统路径分隔符分隔；配合 PROJECT_ALLOWED_ROOTS_APPEND=true 可追加默认 roots）。未设置时使用 denylist 模式（见 PROJECT_DENIED_ROOTS）。',
    category: 'server',
    sensitive: false,
  },
  {
    name: 'PROJECT_ALLOWED_ROOTS_APPEND',
    defaultValue: 'false',
    description: '设为 true 则将 PROJECT_ALLOWED_ROOTS 追加到默认根目录（home, /tmp, /workspace 等）而非覆盖',
    category: 'server',
    sensitive: false,
  },
  {
    name: 'PROJECT_DENIED_ROOTS',
    defaultValue: '(平台默认系统目录)',
    description:
      'Denylist 模式下额外拦截的目录（按系统路径分隔符分隔，会合并到平台默认拦截列表）。仅在未设置 PROJECT_ALLOWED_ROOTS 时生效。',
    category: 'server',
    sensitive: false,
  },
  {
    name: 'FRONTEND_URL',
    defaultValue: '(自动检测)',
    description:
      '前端固定地址（有反向代理或固定域名时设置，如 https://cafe.example.com）。本机和局域网直连通常不需要改',
    category: 'server',
    sensitive: false,
  },
  {
    name: 'FRONTEND_PORT',
    defaultValue: '3003',
    description: '前端端口',
    category: 'server',
    sensitive: false,
  },
  {
    name: 'DEFAULT_OWNER_USER_ID',
    defaultValue: '(未设置)',
    description: '默认所有者用户 ID（信任锚点，不可从 Hub 修改）',
    category: 'server',
    sensitive: false,
    runtimeEditable: false,
  },
  {
    name: 'CAT_CAFE_USER_ID',
    defaultValue: 'default-user',
    description: '当前用户 ID',
    category: 'server',
    sensitive: false,
  },
  {
    name: 'CAT_CAFE_HOOK_TOKEN',
    defaultValue: '(空)',
    description: 'Hook 回调鉴权 token',
    category: 'server',
    sensitive: true,
  },
  {
    name: 'RUNTIME_REPO_PATH',
    defaultValue: '(未设置)',
    description: 'Runtime 仓库路径（自动更新用）',
    category: 'server',
    sensitive: false,
  },
  {
    name: 'WORKSPACE_LINKED_ROOTS',
    defaultValue: '(未设置)',
    description: '工作区关联的项目根（冒号分隔）',
    category: 'server',
    sensitive: false,
  },
  {
    name: 'HYPERFOCUS_THRESHOLD_MS',
    defaultValue: '5400000 (90分钟)',
    description: 'Hyperfocus 健康提醒阈值',
    category: 'server',
    sensitive: false,
  },
  {
    name: 'ANTHROPIC_API_KEY',
    defaultValue: '(未设置 → 由 accounts/credentials 系统注入)',
    description: 'Anthropic API Key（#340 P6: 由统一账户系统管理，不再从 .env 读取）',
    category: 'server',
    sensitive: true,
    hubVisible: false,
  },
  {
    name: 'LOG_LEVEL',
    defaultValue: 'info',
    description: '日志级别（debug / info / warn / error）',
    category: 'server',
    sensitive: false,
    exampleRecommended: true,
  },
  {
    name: 'LOG_DIR',
    defaultValue: './data/logs/api',
    description: 'API 日志目录（Pino 滚动日志写入路径）',
    category: 'server',
    sensitive: false,
    exampleRecommended: true,
  },
  {
    name: 'DEBUG',
    defaultValue: 'false',
    description: '调试模式开关（详细日志，非生产环境用）',
    category: 'server',
    sensitive: false,
    hubVisible: false,
  },
  {
    name: 'MCP_SERVER_PORT',
    defaultValue: '3011',
    description: 'MCP Server 监听端口',
    category: 'server',
    sensitive: false,
    runtimeEditable: false,
    exampleRecommended: true,
  },
  {
    name: 'PREVIEW_GATEWAY_ENABLED',
    defaultValue: '1（启用）',
    description: '设为 0 禁用 Preview Gateway（F120）',
    category: 'server',
    sensitive: false,
  },
  {
    name: 'GAME_NARRATOR_ENABLED',
    defaultValue: '(未设置 → 不启用)',
    description: '设为 true 启用游戏叙述者模式',
    category: 'server',
    sensitive: false,
    hubVisible: false,
  },
  {
    name: 'WEB_PUBLIC_DIR',
    defaultValue: '../web/public',
    description: 'Web 前端静态文件目录（connector gateway 静态资源服务）',
    category: 'server',
    sensitive: false,
  },
  {
    name: 'CAT_CAFE_CONFIG_ROOT',
    defaultValue: '(未设置 → 使用 cwd)',
    description: '平台配置根目录（与 cwd 解耦，平台启动脚本设置）',
    category: 'server',
    sensitive: false,
    hubVisible: false,
  },
  {
    name: 'CAT_CAFE_GLOBAL_CONFIG_ROOT',
    defaultValue: '(未设置 → homedir())',
    description: '全局配置根目录（accounts / credentials 查找路径的父目录，实际路径为 ${ROOT}/.cat-cafe/）',
    category: 'server',
    sensitive: false,
    hubVisible: false,
  },
  {
    name: 'ALLOWED_WORKSPACE_DIRS',
    defaultValue: '(未设置)',
    description: 'MCP Server 允许访问的工作目录列表（逗号分隔）',
    category: 'server',
    sensitive: false,
    exampleRecommended: true,
  },

  // --- storage ---
  {
    name: 'REDIS_URL',
    defaultValue: '(未设置 → 内存模式)',
    description: 'Redis 连接地址',
    category: 'storage',
    sensitive: false,
    maskMode: 'url',
    runtimeEditable: false,
    exampleRecommended: true,
  },
  {
    name: 'REDIS_KEY_PREFIX',
    defaultValue: 'cat-cafe:',
    description: 'Redis key 命名空间前缀，用于多实例隔离',
    category: 'storage',
    sensitive: false,
    runtimeEditable: false,
  },
  {
    name: 'MEMORY_STORE',
    defaultValue: '(未设置)',
    description: '设为 1 显式允许内存模式',
    category: 'storage',
    sensitive: false,
  },
  {
    name: 'MESSAGE_TTL_SECONDS',
    defaultValue: '604800 (7天)',
    description:
      '消息过期时间（秒）。默认 604800（7天）。设为 0 或负数 → 消息永不过期。注意：过期的 Redis 消息不影响已索引的 evidence_passages（Phase I 保证永久性）。',
    category: 'storage',
    sensitive: false,
  },
  {
    name: 'THREAD_TTL_SECONDS',
    defaultValue: '604800 (7天)',
    description: '对话过期时间',
    category: 'storage',
    sensitive: false,
  },
  {
    name: 'TASK_TTL_SECONDS',
    defaultValue: '604800 (7天)',
    description: '任务过期时间',
    category: 'storage',
    sensitive: false,
  },
  {
    name: 'SUMMARY_TTL_SECONDS',
    defaultValue: '604800 (7天)',
    description: '摘要过期时间',
    category: 'storage',
    sensitive: false,
  },
  {
    name: 'BACKLOG_TTL_SECONDS',
    defaultValue: '(无过期)',
    description: 'Backlog 过期时间',
    category: 'storage',
    sensitive: false,
  },
  {
    name: 'DRAFT_TTL_SECONDS',
    defaultValue: '(无过期)',
    description: '草稿过期时间',
    category: 'storage',
    sensitive: false,
  },
  {
    name: 'TRANSCRIPT_DATA_DIR',
    defaultValue: './data/transcripts',
    description: 'Session transcript 存储目录',
    category: 'storage',
    sensitive: false,
  },
  {
    name: 'DOCS_ROOT',
    defaultValue: '{repoRoot}/docs',
    description: 'Docs 根目录路径（F102 记忆系统用）',
    category: 'storage',
    sensitive: false,
  },

  // --- budget ---
  {
    name: 'MAX_PROMPT_CHARS',
    defaultValue: '(per-cat 默认)',
    description: '全局 prompt 字符上限',
    category: 'budget',
    sensitive: false,
    hubVisible: false,
  },
  {
    name: 'CAT_OPUS_MAX_PROMPT_CHARS',
    defaultValue: '150000',
    description: '布偶猫 prompt 上限',
    category: 'budget',
    sensitive: false,
    hubVisible: false,
  },
  {
    name: 'CAT_CODEX_MAX_PROMPT_CHARS',
    defaultValue: '80000',
    description: '缅因猫 prompt 上限',
    category: 'budget',
    sensitive: false,
    hubVisible: false,
  },
  {
    name: 'CAT_GEMINI_MAX_PROMPT_CHARS',
    defaultValue: '150000',
    description: '暹罗猫 prompt 上限',
    category: 'budget',
    sensitive: false,
    hubVisible: false,
  },
  {
    name: 'MAX_CONTEXT_MSG_CHARS',
    defaultValue: '1500',
    description: '单条消息上下文截断',
    category: 'budget',
    sensitive: false,
    hubVisible: false,
  },
  {
    name: 'MAX_A2A_DEPTH',
    defaultValue: '15',
    description: 'A2A 猫猫互调最大深度',
    category: 'budget',
    sensitive: false,
  },
  {
    name: 'MAX_PROMPT_TOKENS',
    defaultValue: '(未设置)',
    description: '全局 prompt token 上限',
    category: 'budget',
    sensitive: false,
    hubVisible: false,
  },
  {
    name: 'WEB_PUSH_TIMEOUT_MS',
    defaultValue: '(未设置)',
    description: 'Web Push 超时时间',
    category: 'budget',
    sensitive: false,
  },

  // --- cli ---
  {
    name: 'CLI_TIMEOUT_MS',
    defaultValue: DEFAULT_CLI_TIMEOUT_LABEL,
    description: 'CLI 调用超时',
    category: 'cli',
    sensitive: false,
  },
  {
    name: 'CAT_TEMPLATE_PATH',
    defaultValue: '(repo 根 cat-template.json)',
    description: '猫猫模板文件路径',
    category: 'cli',
    sensitive: false,
    runtimeEditable: false,
  },
  {
    name: 'CAT_CAFE_MCP_SERVER_PATH',
    defaultValue: '(自动检测)',
    description: 'MCP Server 路径',
    category: 'cli',
    sensitive: false,
  },
  {
    name: 'AUDIT_LOG_DIR',
    defaultValue: './data/audit-logs',
    description: '审计日志目录',
    category: 'cli',
    sensitive: false,
  },
  {
    name: 'CLI_RAW_ARCHIVE_DIR',
    defaultValue: './data/cli-raw-archive',
    description: 'CLI 原始日志归档目录',
    category: 'cli',
    sensitive: false,
  },
  {
    name: 'AUDIT_LOG_INCLUDE_PROMPT_SNIPPETS',
    defaultValue: 'false',
    description: '审计日志包含 prompt 片段',
    category: 'cli',
    sensitive: false,
  },
  {
    name: 'CAT_BRANCH_ROLLBACK_RETRY_DELAYS_MS',
    defaultValue: '1000,2000,4000',
    description: 'Branch 回滚重试间隔',
    category: 'cli',
    sensitive: false,
  },
  {
    name: 'MODE_SWITCH_REQUIRES_APPROVAL',
    defaultValue: 'true',
    description: '模式切换需要确认',
    category: 'cli',
    sensitive: false,
  },
  {
    name: 'CAT_CAFE_TMUX_AGENT',
    defaultValue: '(未设置)',
    description: '设为 1 启用 tmux agent 模式',
    category: 'cli',
    sensitive: false,
  },
  {
    name: 'CAT_CAFE_TMUX_PATH',
    defaultValue: '(未设置)',
    description: 'Tmux 可执行文件路径',
    category: 'cli',
    sensitive: false,
  },
  {
    name: 'CAT_CAFE_DATA_DIR',
    defaultValue: '(未设置)',
    description: '数据目录根路径',
    category: 'cli',
    sensitive: false,
  },
  {
    name: 'CAT_CAFE_CALLBACK_TOKEN',
    defaultValue: '(未设置)',
    description: 'Callback 鉴权 token',
    category: 'cli',
    sensitive: true,
  },
  {
    name: 'CAT_CAFE_CALLBACK_OUTBOX_ENABLED',
    defaultValue: 'true',
    description: 'Callback outbox 是否启用',
    category: 'cli',
    sensitive: false,
  },
  {
    name: 'CAT_CAFE_CALLBACK_OUTBOX_DIR',
    defaultValue: '(自动)',
    description: 'Callback outbox 目录',
    category: 'cli',
    sensitive: false,
  },
  {
    name: 'CAT_CAFE_CALLBACK_OUTBOX_MAX_ATTEMPTS',
    defaultValue: '(默认)',
    description: 'Outbox 最大重试次数',
    category: 'cli',
    sensitive: false,
  },
  {
    name: 'CAT_CAFE_CALLBACK_OUTBOX_MAX_FLUSH_BATCH',
    defaultValue: '(默认)',
    description: 'Outbox 单次 flush 批量',
    category: 'cli',
    sensitive: false,
  },
  {
    name: 'CAT_CAFE_CALLBACK_RETRY_DELAYS_MS',
    defaultValue: '(默认)',
    description: 'Callback 重试间隔（逗号分隔）',
    category: 'cli',
    sensitive: false,
  },
  {
    name: 'CDP_DEBUG',
    defaultValue: '(未设置)',
    description: 'CDP Bridge 调试模式',
    category: 'cli',
    sensitive: false,
  },
  {
    name: 'CODEX_HOME',
    defaultValue: '~/.codex',
    description: 'Codex CLI home 目录',
    category: 'cli',
    sensitive: false,
  },
  {
    name: 'CAT_CAFE_API_URL',
    defaultValue: 'http://localhost:3004',
    description: 'API 服务地址（由 API 进程注入 MCP Server 子进程 env）',
    category: 'cli',
    sensitive: false,
    hubVisible: false,
  },
  {
    name: 'CAT_CAFE_INVOCATION_ID',
    defaultValue: '(运行时注入)',
    description: '当前 invocation ID（由 API 进程注入 MCP Server 子进程 env）',
    category: 'cli',
    sensitive: false,
    hubVisible: false,
  },
  {
    name: 'CAT_CAFE_CAT_ID',
    defaultValue: '(运行时注入)',
    description: '当前猫 ID（由 API 进程注入 MCP Server 子进程 env）',
    category: 'cli',
    sensitive: false,
    hubVisible: false,
  },
  {
    name: 'CAT_CAFE_DIAGNOSTICS',
    defaultValue: '(未设置)',
    description: '设为 1 启用 /api/diagnostics/* 端点（调试用，默认关闭）',
    category: 'cli',
    sensitive: false,
    hubVisible: false,
  },
  {
    name: 'CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT',
    defaultValue: '(未设置)',
    description: '设为 1 跳过 shared state preflight 检查（CI / 调试用）',
    category: 'cli',
    sensitive: false,
    hubVisible: false,
  },
  {
    name: 'CAT_CAFE_PREFLIGHT_TIMEOUT_MS',
    defaultValue: '30000',
    description: 'Pre-flight 操作（Redis/store 读取）的超时毫秒数，超时后降级到无 session 模式',
    category: 'cli',
    sensitive: false,
    hubVisible: false,
  },

  // --- proxy ---
  {
    name: 'ANTHROPIC_PROXY_ENABLED',
    defaultValue: '1',
    description: 'Anthropic 代理网关开关（0 关闭）',
    category: 'proxy',
    sensitive: false,
  },
  {
    name: 'ANTHROPIC_PROXY_PORT',
    defaultValue: '9877',
    description: '代理网关监听端口',
    category: 'proxy',
    sensitive: false,
  },
  {
    name: 'ANTHROPIC_PROXY_DEBUG',
    defaultValue: '(未设置)',
    description: '设为 1 启用代理调试日志',
    category: 'proxy',
    sensitive: false,
  },
  {
    name: 'ANTHROPIC_PROXY_UPSTREAMS_PATH',
    defaultValue: '.cat-cafe/proxy-upstreams.json',
    description: 'upstream 配置文件路径（解决 runtime 与源码分离问题）',
    category: 'proxy',
    sensitive: false,
  },
  {
    name: 'HTTPS_PROXY',
    defaultValue: '(未设置)',
    description: 'HTTPS 代理地址（Web Push / 外部 HTTP 请求用）',
    category: 'proxy',
    sensitive: false,
    hubVisible: false,
  },
  {
    name: 'HTTP_PROXY',
    defaultValue: '(未设置)',
    description: 'HTTP 代理地址',
    category: 'proxy',
    sensitive: false,
    hubVisible: false,
  },
  {
    name: 'ALL_PROXY',
    defaultValue: '(未设置)',
    description: '通用代理地址（HTTP/HTTPS/SOCKS 通用 fallback）',
    category: 'proxy',
    sensitive: false,
    hubVisible: false,
  },

  // --- connector ---
  {
    name: 'TELEGRAM_BOT_TOKEN',
    defaultValue: '(未设置 → 不启用)',
    description: 'Telegram Bot Token',
    category: 'connector',
    sensitive: true,
  },
  {
    name: 'FEISHU_APP_ID',
    defaultValue: '(未设置 → 不启用)',
    description: '飞书应用 App ID',
    category: 'connector',
    sensitive: false,
  },
  {
    name: 'FEISHU_APP_SECRET',
    defaultValue: '(未设置)',
    description: '飞书应用 App Secret',
    category: 'connector',
    sensitive: true,
  },
  {
    name: 'FEISHU_VERIFICATION_TOKEN',
    defaultValue: '(未设置)',
    description: '飞书 webhook 验证 token（仅 webhook 模式需要）',
    category: 'connector',
    sensitive: true,
  },
  {
    name: 'FEISHU_CONNECTION_MODE',
    defaultValue: 'webhook',
    description: '飞书连接模式：webhook（需公网 URL）或 websocket（长连接，无需公网）',
    category: 'connector',
    sensitive: false,
  },
  {
    name: 'DINGTALK_APP_KEY',
    defaultValue: '(未设置 → 不启用)',
    description: '钉钉应用 AppKey',
    category: 'connector',
    sensitive: false,
  },
  {
    name: 'DINGTALK_APP_SECRET',
    defaultValue: '(未设置)',
    description: '钉钉应用 AppSecret',
    category: 'connector',
    sensitive: true,
  },
  {
    name: 'XIAOYI_AK',
    defaultValue: '(未设置 → 不启用)',
    description: '华为小艺 OpenClaw Access Key',
    category: 'connector',
    sensitive: false,
  },
  {
    name: 'XIAOYI_SK',
    defaultValue: '(未设置)',
    description: '华为小艺 OpenClaw Secret Key',
    category: 'connector',
    sensitive: true,
  },
  {
    name: 'XIAOYI_AGENT_ID',
    defaultValue: '(未设置)',
    description: '华为小艺 Agent ID',
    category: 'connector',
    sensitive: false,
  },
  {
    name: 'FEISHU_BOT_OPEN_ID',
    defaultValue: '(未设置)',
    description: '飞书机器人 Open ID（接收消息的 bot 身份标识）',
    category: 'connector',
    sensitive: false,
  },
  {
    name: 'FEISHU_ADMIN_OPEN_IDS',
    defaultValue: '(未设置)',
    description: '飞书管理员 Open ID 列表（逗号分隔）',
    category: 'connector',
    sensitive: false,
  },
  {
    name: 'WEIXIN_VOICE_ITEM_MODE',
    defaultValue: 'minimal',
    description:
      '微信语音消息 voice_item 模式（minimal/playtime/playtime-sec，危险实验模式见 WEIXIN_ENABLE_UNSAFE_VOICE_MODES）',
    category: 'connector',
    sensitive: false,
  },
  {
    name: 'WEIXIN_ENABLE_UNSAFE_VOICE_MODES',
    defaultValue: '0',
    description:
      '是否允许危险语音实验模式（1=允许 playtime-encode/metadata，0=自动回退 playtime，避免“语音完全收不到”）',
    category: 'connector',
    sensitive: false,
  },
  {
    name: 'WEIXIN_CAPTURE_INBOUND_VOICE_MEDIA',
    defaultValue: '0',
    description: '是否抓取入站微信语音媒体（1=把 voice media 当文件附件落盘，便于 SILK 二进制对比；0=保持当前行为）',
    category: 'connector',
    sensitive: false,
  },
  {
    name: 'WEIXIN_BOT_TOKEN',
    defaultValue: '(未设置 → 不启用)',
    description: '微信机器人 Token（F137 微信个人网关）',
    category: 'connector',
    sensitive: true,
  },
  {
    name: 'WECOM_BOT_ID',
    defaultValue: '(未设置 → 不启用智能机器人模式)',
    description: '企业微信智能机器人 Bot ID（WebSocket 长连接模式）',
    category: 'connector',
    sensitive: false,
    exampleRecommended: true,
  },
  {
    name: 'WECOM_BOT_SECRET',
    defaultValue: '(未设置)',
    description: '企业微信智能机器人 Bot Secret',
    category: 'connector',
    sensitive: true,
    exampleRecommended: true,
  },
  {
    name: 'WECOM_CORP_ID',
    defaultValue: '(未设置 → 不启用自建应用模式)',
    description: '企业微信企业 ID（自建应用 HTTP 回调模式）',
    category: 'connector',
    sensitive: false,
    exampleRecommended: true,
  },
  {
    name: 'WECOM_AGENT_ID',
    defaultValue: '(未设置)',
    description: '企业微信自建应用 AgentId',
    category: 'connector',
    sensitive: false,
    exampleRecommended: true,
  },
  {
    name: 'WECOM_AGENT_SECRET',
    defaultValue: '(未设置)',
    description: '企业微信自建应用 Secret',
    category: 'connector',
    sensitive: true,
    exampleRecommended: true,
  },
  {
    name: 'WECOM_TOKEN',
    defaultValue: '(未设置)',
    description: '企业微信回调 Token（HTTP 模式验签）',
    category: 'connector',
    sensitive: true,
    exampleRecommended: true,
  },
  {
    name: 'WECOM_ENCODING_AES_KEY',
    defaultValue: '(未设置)',
    description: '企业微信回调 EncodingAESKey（43字符，HTTP 模式解密用）',
    category: 'connector',
    sensitive: true,
    exampleRecommended: true,
  },

  // --- GitHub Repo Inbox (F141) ---
  {
    name: 'GITHUB_WEBHOOK_SECRET',
    defaultValue: '(未设置 → 不启用)',
    description: 'GitHub webhook HMAC-SHA256 shared secret（F141 Repo Inbox）',
    category: 'connector',
    sensitive: true,
  },
  {
    name: 'GITHUB_REPO_ALLOWLIST',
    defaultValue: '(未设置)',
    description: '允许的仓库列表，逗号分隔（如 zts212653/clowder-ai）',
    category: 'connector',
    sensitive: false,
  },
  {
    name: 'GITHUB_REPO_INBOX_CAT_ID',
    defaultValue: '(未设置)',
    description: '接收 Repo Inbox 事件的猫 ID',
    category: 'connector',
    sensitive: false,
  },
  {
    name: 'GITHUB_AUTHORITATIVE_REVIEW_LOGINS',
    defaultValue: 'chatgpt-codex-connector[bot]',
    description:
      'Comma-separated GitHub logins whose review feedback is handled by the email channel (authoritative source). F140 API polling skips these to avoid double-delivery.',
    category: 'connector',
    sensitive: false,
  },
  {
    name: 'GITHUB_TOKEN',
    defaultValue: '(未设置)',
    description: 'GitHub Personal Access Token（Scheduler 仓库活跃度模板 HTTP 请求鉴权）',
    category: 'connector',
    sensitive: true,
  },

  // --- codex ---
  {
    name: 'CAT_CODEX_SANDBOX_MODE',
    defaultValue: 'danger-full-access',
    description: '缅因猫沙箱模式',
    category: 'codex',
    sensitive: false,
  },
  {
    name: 'CAT_CODEX_APPROVAL_POLICY',
    defaultValue: 'on-request',
    description: '缅因猫审批策略',
    category: 'codex',
    sensitive: false,
  },
  {
    name: 'CODEX_AUTH_MODE',
    defaultValue: 'oauth',
    description: '缅因猫认证方式 (oauth/api_key)',
    category: 'codex',
    sensitive: false,
  },
  {
    name: 'OPENAI_API_KEY',
    defaultValue: '(未设置 → 由 accounts/credentials 系统注入)',
    description: 'OpenAI API Key（#340 P6: 由统一账户系统管理，子进程通过 callbackEnv 注入）',
    category: 'codex',
    sensitive: true,
  },

  // --- dare ---
  { name: 'DARE_ADAPTER', defaultValue: 'openrouter', description: '狸花猫适配器', category: 'dare', sensitive: false },
  { name: 'DARE_PATH', defaultValue: '(未设置)', description: 'Dare CLI 路径', category: 'dare', sensitive: false },

  // --- gemini ---
  {
    name: 'GOOGLE_API_KEY',
    defaultValue: '(未设置 → 由 accounts/credentials 系统注入)',
    description: 'Google API Key（#340 P6: 由统一账户系统管理，子进程通过 callbackEnv 注入）',
    category: 'gemini',
    sensitive: true,
    hubVisible: false,
  },
  {
    name: 'GEMINI_ADAPTER',
    defaultValue: 'gemini-cli',
    description: '暹罗猫适配器 (gemini-cli/antigravity)',
    category: 'gemini',
    sensitive: false,
  },

  // --- kimi ---
  {
    name: 'MOONSHOT_API_KEY',
    defaultValue: '(未设置)',
    description: 'Kimi / Moonshot API Key（官方 kimi-cli API Key 模式用）',
    category: 'kimi',
    sensitive: true,
    hubVisible: false,
  },
  {
    name: 'KIMI_SHARE_DIR',
    defaultValue: '~/.kimi',
    description: '官方 kimi-cli 共享目录（session / mcp / logs）',
    category: 'kimi',
    sensitive: false,
    hubVisible: false,
  },
  {
    name: 'KIMI_CONFIG_FILE',
    defaultValue: '~/.kimi/config.toml',
    description: '官方 kimi-cli 配置文件路径（覆盖默认 ~/.kimi/config.toml）',
    category: 'kimi',
    sensitive: false,
    hubVisible: false,
    runtimeEditable: false,
  },
  {
    name: 'KIMI_AUTH_TOKEN',
    defaultValue: '(未设置)',
    description: 'Kimi 官方额度抓取用的 kimi-auth token（来自 kimi.com）',
    category: 'quota',
    sensitive: true,
    hubVisible: false,
  },
  {
    name: 'KIMI_QUOTA_API_FALLBACK_ENABLED',
    defaultValue: '0（默认关闭）',
    description: '设为 1 允许 Kimi 额度在 CLI /usage 失败时降级到 API（仍需 KIMI_AUTH_TOKEN）',
    category: 'quota',
    sensitive: false,
    hubVisible: false,
    runtimeEditable: false,
  },

  // --- tts ---
  {
    name: 'TTS_URL',
    defaultValue: 'http://localhost:9879',
    description: 'TTS 服务地址 (Qwen3-TTS)',
    category: 'tts',
    sensitive: false,
  },
  {
    name: 'TTS_CACHE_DIR',
    defaultValue: './data/tts-cache',
    description: 'TTS 音频缓存目录',
    category: 'tts',
    sensitive: false,
  },
  {
    name: 'GENSHIN_VOICE_DIR',
    defaultValue: '~/projects/.../genshin',
    description: 'GPT-SoVITS 角色模型目录',
    category: 'tts',
    sensitive: false,
  },
  {
    name: 'CHARACTER_VOICE_DIR',
    defaultValue: '(未设置 → dirname(GENSHIN_VOICE_DIR))',
    description: '角色语音模型根目录（优先级高于 GENSHIN_VOICE_DIR）',
    category: 'tts',
    sensitive: false,
  },

  // --- stt ---
  {
    name: 'WHISPER_URL',
    defaultValue: 'http://localhost:9876',
    description: 'Whisper STT 服务地址（服务端）',
    category: 'stt',
    sensitive: false,
  },

  // --- connector media ---
  {
    name: 'CONNECTOR_MEDIA_DIR',
    defaultValue: './data/connector-media',
    description: '连接器媒体下载目录',
    category: 'connector',
    sensitive: false,
  },

  // --- frontend ---
  {
    name: 'NEXT_PUBLIC_API_URL',
    defaultValue: 'http://localhost:3004',
    description: '前端连接的 API 地址',
    category: 'frontend',
    sensitive: false,
    runtimeEditable: false,
  },
  {
    name: 'NEXT_PUBLIC_WHISPER_URL',
    defaultValue: 'http://localhost:9876',
    description: 'Whisper ASR 服务地址',
    category: 'frontend',
    sensitive: false,
    runtimeEditable: false,
  },
  {
    name: 'NEXT_PUBLIC_LLM_POSTPROCESS_URL',
    defaultValue: 'http://localhost:9878',
    description: 'LLM 后处理服务地址',
    category: 'frontend',
    sensitive: false,
    runtimeEditable: false,
  },
  {
    name: 'NEXT_PUBLIC_PROJECT_ROOT',
    defaultValue: '(空)',
    description: '前端项目根路径',
    category: 'frontend',
    sensitive: false,
    runtimeEditable: false,
  },
  {
    name: 'NEXT_PUBLIC_DEBUG_SKIP_FILE_CHANGE_UI',
    defaultValue: '(未设置)',
    description: '设为 1 跳过文件变更 UI',
    category: 'frontend',
    sensitive: false,
    runtimeEditable: false,
  },

  // --- push ---
  {
    name: 'VAPID_PUBLIC_KEY',
    defaultValue: '(未设置 → 推送不可用)',
    description: 'VAPID 公钥 (Web Push)',
    category: 'push',
    sensitive: false,
  },
  {
    name: 'VAPID_PRIVATE_KEY',
    defaultValue: '(未设置)',
    description: 'VAPID 私钥 (Web Push)',
    category: 'push',
    sensitive: true,
  },
  {
    name: 'VAPID_SUBJECT',
    defaultValue: 'mailto:cat-cafe@localhost',
    description: 'VAPID 联系方式 (mailto: 或 URL)',
    category: 'push',
    sensitive: false,
  },

  // --- signal ---
  {
    name: 'SIGNALS_ROOT_DIR',
    defaultValue: '(未设置)',
    description: 'Signal 信号源数据目录',
    category: 'signal',
    sensitive: false,
  },
  {
    name: 'CAT_CAFE_SIGNAL_USER',
    defaultValue: 'codex',
    description: 'Signal 默认执行猫',
    category: 'signal',
    sensitive: false,
  },

  // --- github_review ---
  {
    name: 'GITHUB_REVIEW_IMAP_USER',
    defaultValue: '(未设置 → 监控不启用)',
    description: 'QQ 邮箱地址 (xxx@qq.com)',
    category: 'github_review',
    sensitive: false,
  },
  {
    name: 'GITHUB_REVIEW_IMAP_PASS',
    defaultValue: '(未设置)',
    description: 'QQ 邮箱授权码 (非登录密码)',
    category: 'github_review',
    sensitive: true,
  },
  {
    name: 'GITHUB_REVIEW_IMAP_HOST',
    defaultValue: 'imap.qq.com',
    description: 'IMAP 服务器地址',
    category: 'github_review',
    sensitive: false,
  },
  {
    name: 'GITHUB_REVIEW_IMAP_PORT',
    defaultValue: '993',
    description: 'IMAP 端口 (SSL)',
    category: 'github_review',
    sensitive: false,
  },
  {
    name: 'GITHUB_REVIEW_POLL_INTERVAL_MS',
    defaultValue: '120000',
    description: '邮件轮询间隔 (毫秒)',
    category: 'github_review',
    sensitive: false,
  },
  {
    name: 'GITHUB_MCP_PAT',
    defaultValue: '(未设置)',
    description: 'GitHub Personal Access Token (MCP 用)',
    category: 'github_review',
    sensitive: true,
    runtimeEditable: true,
  },
  {
    name: 'GITHUB_REVIEW_IMAP_PROXY',
    defaultValue: '(未设置)',
    description: 'IMAP 连接代理地址（如 socks5://127.0.0.1:1080）',
    category: 'github_review',
    sensitive: false,
  },

  // --- evidence (F102 记忆系统) ---
  {
    name: 'EMBED_MODE',
    defaultValue: 'off',
    description: '向量检索模式 (off/shadow/on)，on = 开启 Qwen3 embedding rerank',
    category: 'evidence',
    sensitive: false,
  },
  {
    name: 'F102_ABSTRACTIVE',
    defaultValue: 'off',
    description: 'Phase G 摘要调度器 (off/on)，on = 定时调用 Opus API 做 thread 摘要',
    category: 'evidence',
    sensitive: false,
  },
  {
    name: 'F102_DURABLE_CANDIDATES',
    defaultValue: 'off',
    description: 'Phase G candidate 提取 (off/on)，on = 摘要时提取 durable knowledge 候选到 MarkerQueue',
    category: 'evidence',
    sensitive: false,
  },
  {
    name: 'F102_TOPIC_SEGMENTS',
    defaultValue: 'off',
    description: 'Phase G topic 分段 (off/on)，on = 摘要按话题切分多个 segment',
    category: 'evidence',
    sensitive: false,
  },
  {
    name: 'EMBED_URL',
    defaultValue: 'http://127.0.0.1:9880',
    description: 'Embedding 服务地址（独立 Python GPU 进程 scripts/embed-api.py）',
    category: 'evidence',
    sensitive: false,
  },
  {
    name: 'EVIDENCE_DB',
    defaultValue: '{repoRoot}/evidence.sqlite',
    description: 'F102 SQLite 数据库路径',
    category: 'evidence',
    sensitive: false,
  },
  {
    name: 'GLOBAL_KNOWLEDGE_DB',
    defaultValue: '~/.cat-cafe/global_knowledge.sqlite',
    description: 'F-4: 全局知识 SQLite 路径（Skills + MEMORY.md 编译产物）',
    category: 'evidence',
    sensitive: false,
  },
  {
    name: 'F102_API_BASE',
    defaultValue: '(未设置 → 摘要调度器不启用)',
    description: 'Phase G 摘要调度用的反代 API 地址（不是猫猫自己的 provider profile）',
    category: 'evidence',
    sensitive: false,
  },
  {
    name: 'F102_API_KEY',
    defaultValue: '(未设置)',
    description: 'Phase G 摘要调度用的反代 API Key',
    category: 'evidence',
    sensitive: true,
    runtimeEditable: true,
  },
  {
    name: 'EMBED_PORT',
    defaultValue: '9880',
    description: 'Embedding 服务端口（仅在 EMBED_URL 未设置时使用）',
    category: 'evidence',
    sensitive: false,
  },

  // --- quota ---
  {
    name: 'QUOTA_OFFICIAL_REFRESH_ENABLED',
    defaultValue: '0（默认关闭）',
    description: '设为 1 允许官方额度抓取（Claude/Codex OAuth + Kimi auth token）',
    category: 'quota',
    sensitive: false,
  },
  {
    name: 'CLAUDE_CREDENTIALS_PATH',
    defaultValue: '~/.claude/.credentials.json',
    description: 'Claude OAuth credentials 文件路径（官方额度刷新用）',
    category: 'quota',
    sensitive: false,
    hubVisible: false,
  },
  {
    name: 'CODEX_CREDENTIALS_PATH',
    defaultValue: '(未设置 → ~/.codex/credentials)',
    description: 'Codex OAuth credentials 文件路径（官方额度刷新用）',
    category: 'quota',
    sensitive: false,
    hubVisible: false,
  },

  // --- telemetry (F153) ---
  {
    name: 'TELEMETRY_DEBUG',
    defaultValue: '(未设置 → 关闭)',
    description:
      '设为 true 启用 ConsoleSpanExporter（UNREDACTED）。仅 NODE_ENV=development/test 生效，其他环境需额外设 TELEMETRY_DEBUG_FORCE=true',
    category: 'telemetry',
    sensitive: false,
    hubVisible: false,
    runtimeEditable: false,
  },
  {
    name: 'TELEMETRY_DEBUG_FORCE',
    defaultValue: '(未设置 → 关闭)',
    description: '生产环境强制启用 TELEMETRY_DEBUG 的安全覆写开关。仅限紧急排障',
    category: 'telemetry',
    sensitive: false,
    hubVisible: false,
    runtimeEditable: false,
  },
  {
    name: 'TELEMETRY_HMAC_SALT',
    defaultValue: '(dev/test 自动 fallback)',
    description: 'HMAC salt — 遥测系统 ID 伪名化用。生产环境必设，缺失则禁用 OTel',
    category: 'telemetry',
    sensitive: true,
  },
  {
    name: 'TELEMETRY_EXPORT_RAW_SYSTEM_IDS',
    defaultValue: '(未设置 → HMAC 伪名化)',
    description: '设为 1 跳过 HMAC，导出原始系统 ID（仅限自托管受控环境）',
    category: 'telemetry',
    sensitive: false,
  },
  {
    name: 'PROMETHEUS_PORT',
    defaultValue: '9464',
    description: 'Prometheus /metrics 抓取端口',
    category: 'telemetry',
    sensitive: false,
  },
  {
    name: 'OTEL_EXPORTER_OTLP_ENDPOINT',
    defaultValue: '(未设置 → 仅 Prometheus)',
    description: 'OTLP 导出端点（设置后同时推送 traces/metrics/logs 到该端点）',
    category: 'telemetry',
    sensitive: false,
  },
  {
    name: 'OTEL_SDK_DISABLED',
    defaultValue: '(未设置 → 启用)',
    description: '设为 true 完全禁用 OTel SDK',
    category: 'telemetry',
    sensitive: false,
  },
];

/** Mask credentials in a URL while preserving host/port/db for debugging. */
export function maskUrlCredentials(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      url.username = url.username ? '***' : '';
      url.password = '';
    }
    return url.toString().replace(/\/+$/, '');
  } catch {
    // Not a valid URL — mask entirely to be safe
    return '***';
  }
}

function maskValue(def: EnvDefinition, raw: string): string {
  if (def.sensitive) return '***';
  if (def.maskMode === 'url') return maskUrlCredentials(raw);
  return raw;
}

function isHubVisibleEnvVar(def: EnvDefinition): boolean {
  return def.hubVisible !== false;
}

/**
 * Build env summary by reading current process.env values.
 * Sensitive values are masked. URL values have credentials masked.
 */
export function buildEnvSummary(): Array<EnvDefinition & { currentValue: string | null }> {
  return ENV_VARS.filter(isHubVisibleEnvVar).map((def) => {
    const raw = process.env[def.name];
    const currentValue = raw != null && raw !== '' ? maskValue(def, raw) : null;
    return { ...def, currentValue };
  });
}

export function isEditableEnvVar(def: EnvDefinition): boolean {
  // Explicit opt-in: runtimeEditable: true allows editing even if sensitive (fail-closed whitelist)
  if (def.runtimeEditable === true) return true;
  // Explicit opt-out: runtimeEditable: false blocks editing unconditionally
  if (def.runtimeEditable === false) return false;
  // Default: non-sensitive vars are editable
  return !def.sensitive;
}

/** True if this env var is both sensitive AND explicitly opted into runtime editing. */
export function isSensitiveEditableEnvVar(def: EnvDefinition): boolean {
  return def.sensitive && def.runtimeEditable === true;
}

export function isEditableEnvVarName(name: string): boolean {
  return ENV_VARS.some((def) => def.name === name && isHubVisibleEnvVar(def) && isEditableEnvVar(def));
}

/** Check if any of the given env var names are sensitive-editable (requires owner gate). */
export function hasSensitiveEditableVars(names: Iterable<string>): boolean {
  const nameSet = new Set(names);
  return ENV_VARS.some((def) => nameSet.has(def.name) && isSensitiveEditableEnvVar(def));
}

/** Return only the sensitive-editable keys from the given names (for audit filtering). */
export function filterSensitiveEditableKeys(names: Iterable<string>): string[] {
  const nameSet = new Set(names);
  return ENV_VARS.filter((def) => nameSet.has(def.name) && isSensitiveEditableEnvVar(def)).map((def) => def.name);
}
