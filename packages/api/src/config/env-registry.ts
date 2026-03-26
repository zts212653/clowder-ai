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
  | 'tts'
  | 'stt'
  | 'frontend'
  | 'push'
  | 'signal'
  | 'github_review'
  | 'evidence';

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
  tts: '语音合成 (TTS)',
  stt: '语音识别 (STT)',
  frontend: '前端',
  push: '推送通知',
  signal: 'Signal 信号源',
  github_review: 'GitHub Review 监控',
  evidence: 'F102 记忆系统',
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
    description: 'API 监听地址',
    category: 'server',
    sensitive: false,
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
    description: '前端 URL（导出长图用）',
    category: 'server',
    sensitive: false,
  },
  {
    name: 'FRONTEND_PORT',
    defaultValue: '3003',
    description: '前端端口（导出长图用）',
    category: 'server',
    sensitive: false,
  },
  {
    name: 'DEFAULT_OWNER_USER_ID',
    defaultValue: '(未设置)',
    description: '默认所有者用户 ID',
    category: 'server',
    sensitive: false,
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

  // --- storage ---
  {
    name: 'REDIS_URL',
    defaultValue: '(未设置 → 内存模式)',
    description: 'Redis 连接地址',
    category: 'storage',
    sensitive: false,
    maskMode: 'url',
    runtimeEditable: false,
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
    description: '消息过期时间',
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
    description: '飞书 webhook 验证 token',
    category: 'connector',
    sensitive: true,
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
    defaultValue: '(未设置)',
    description: 'OpenAI API Key (api_key 模式用)',
    category: 'codex',
    sensitive: true,
  },

  // --- dare ---
  { name: 'DARE_ADAPTER', defaultValue: 'openrouter', description: '狸花猫适配器', category: 'dare', sensitive: false },
  { name: 'DARE_PATH', defaultValue: '(未设置)', description: 'Dare CLI 路径', category: 'dare', sensitive: false },

  // --- gemini ---
  {
    name: 'GEMINI_ADAPTER',
    defaultValue: 'gemini-cli',
    description: '暹罗猫适配器 (gemini-cli/antigravity)',
    category: 'gemini',
    sensitive: false,
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
  return def.runtimeEditable !== false && !def.sensitive;
}

export function isEditableEnvVarName(name: string): boolean {
  return ENV_VARS.some((def) => def.name === name && isHubVisibleEnvVar(def) && isEditableEnvVar(def));
}
