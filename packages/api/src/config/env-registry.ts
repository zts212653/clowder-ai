import { ENV_DEFINITIONS_1 } from './env-registry-data/part-1.js';
import { ENV_DEFINITIONS_2 } from './env-registry-data/part-2.js';
import { ENV_DEFINITIONS_3 } from './env-registry-data/part-3.js';
import { ENV_DEFINITIONS_4 } from './env-registry-data/part-4.js';
import { ENV_DEFINITIONS_5 } from './env-registry-data/part-5.js';
import { ENV_DEFINITIONS_6 } from './env-registry-data/part-6.js';
import { ENV_DEFINITIONS_7 } from './env-registry-data/part-7.js';
import { ENV_DEFINITIONS_8 } from './env-registry-data/part-8.js';

/**
 * Environment variable registry — single source of truth for all user-configurable env vars.
 * Used by GET /api/config/env-summary to report current values to the frontend.
 *
 * ⚠️  ALL CATS: 新增 process.env.XXX → 必须在下方 ENV_VARS 数组注册！
 *    不注册 = 前端「环境 & 文件」页面看不到 = co-creator不知道 = 不存在。
 *    SOP.md「环境变量注册」章节有说明。
 *
 * To add a new env var:
 * 1. Add an EnvDefinition to ENV_VARS below
 * 2. Use process.env[name] in your code as usual
 * The "环境 & 文件" tab picks it up automatically.
 */

/** Semantic groups used by the curated System Settings projection. */
export type SettingsGroupKey = 'network' | 'storage' | 'lifecycle' | 'runtime' | 'security';

export const SETTINGS_GROUPS: Record<SettingsGroupKey, string> = {
  network: '网络 & 端口',
  storage: '存储',
  lifecycle: '数据生命周期',
  runtime: '运行与调用',
  security: '安全 & 访问控制',
};

/** Shared boolean convention for settings whose consumers accept `1` or `true`. */
export function parseBoolEnv(raw: string | undefined, defaultOn = false): boolean {
  if (raw == null || raw === '') return defaultOn;
  return raw === '1' || raw.toLowerCase() === 'true';
}

export type EnvCategory =
  | 'server'
  | 'storage'
  | 'budget'
  | 'cli'
  | 'proxy'
  | 'connector'
  | 'codex'
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
  | 'telemetry'
  | 'antigravity'
  | 'audio';

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
  /** Human-readable reason shown by Settings when a retained registry entry has no live consumer. */
  deprecated?: string;
  /** Explicit allowed values for cycle-style toggles (e.g. ['off','shadow','on']) */
  allowedValues?: string[];
  /** User-facing label in the curated System Settings projection. */
  label?: string;
  /** Display group in the curated System Settings projection. */
  settingsGroup?: SettingsGroupKey;
  /** Whether the effective runtime value changes only after a process restart. */
  restartRequired?: boolean;
  /** Runtime truthiness semantics for read-only boolean status rows. */
  booleanSemantics?: {
    defaultOn: boolean;
    trueWhen?: 'parseBoolEnv' | 'exactTrue' | 'exactOne' | 'notZero';
  };
}

export const ENV_CATEGORIES: Record<EnvCategory, string> = {
  server: '服务器',
  storage: '存储',
  budget: '猫猫预算',
  cli: 'CLI',
  proxy: 'Anthropic 代理网关',
  connector: '平台接入 (Telegram/飞书)',
  codex: '缅因猫 (Codex)',
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
  antigravity: '孟加拉猫 (Antigravity)',
  audio: '会中实时智囊 (F195)',
};

export const ENV_VARS: EnvDefinition[] = [
  ...ENV_DEFINITIONS_1,
  ...ENV_DEFINITIONS_2,
  ...ENV_DEFINITIONS_3,
  ...ENV_DEFINITIONS_4,
  ...ENV_DEFINITIONS_5,
  ...ENV_DEFINITIONS_6,
  ...ENV_DEFINITIONS_7,
  ...ENV_DEFINITIONS_8,
  {
    name: 'CAT_CAFE_AGENT_SESSION_CONTRACT',
    runtimeEditable: false,
    restartRequired: true,
    category: 'cli',
    sensitive: false,
    defaultValue: 'plugin',
    description: '会话契约插件接入：plugin（默认，未绑定成员沿用原服务）或 off',
  },
  {
    name: 'CAT_CAFE_AGENT_SESSION_BINDINGS',
    runtimeEditable: false,
    restartRequired: true,
    category: 'cli',
    sensitive: false,
    defaultValue: '{}',
    description: '猫成员到插件会话实现的 JSON 绑定',
  },
  {
    name: 'CAT_CAFE_TRUSTED_HOST_COMPATIBILITY',
    defaultValue: '0',
    description:
      '弃用的内网预置别名：仅 exact 1 且对应新键未设置时映射 trusted-host / warn-bootstrap-root；审计例外仅 Windows 已有 ACP client 的引导目录变更。新键逐项优先，重启 API 生效',
    category: 'server',
    settingsGroup: 'security',
    sensitive: false,
    runtimeEditable: false,
    restartRequired: true,
    booleanSemantics: { defaultOn: false, trueWhen: 'exactOne' },
  },
  {
    name: 'CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE',
    allowedValues: ['strict', 'trusted-host'],
    defaultValue: 'strict',
    description:
      'Windows ACP 目录策略：strict 或 trusted-host。后者仅跳过祖先 owner/DACL，保留自身私有权限、NTFS 和路径身份检查；接受祖先替换风险，不放宽审计。重启 API 生效',
    category: 'server',
    settingsGroup: 'security',
    sensitive: false,
    runtimeEditable: false,
    restartRequired: true,
  },
  {
    name: 'CAT_CAFE_ACP_BOOTSTRAP_CONFIG_AUDIT_MODE',
    allowedValues: ['required', 'warn-bootstrap-root'],
    defaultValue: 'required',
    description:
      'ACP 引导目录保存审计：required 或 warn-bootstrap-root。后者仅在 Windows trusted-host 目录策略下，允许本机所有者保存已校验且只修改引导目录的现有客户端配置；其他变更仍要求审计。重启 API 生效',
    category: 'server',
    settingsGroup: 'security',
    sensitive: false,
    runtimeEditable: false,
    restartRequired: true,
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

/**
 * Curated platform-level settings for the System page. The full registry stays
 * canonical for Environment & Files and module-owned surfaces.
 */
export const SYSTEM_VARS: ReadonlySet<string> = new Set([
  'API_SERVER_HOST',
  'API_SERVER_PORT',
  'BACKLOG_TTL_SECONDS',
  'CAT_CAFE_DATA_DIR',
  'CLI_TIMEOUT_MS',
  'CORS_ALLOW_PRIVATE_NETWORK',
  'DEFAULT_OWNER_USER_ID',
  'FRONTEND_PORT',
  'FRONTEND_URL',
  'LOG_LEVEL',
  'MEMORY_STORE',
  'MESSAGE_TTL_SECONDS',
  'PREVIEW_GATEWAY_ENABLED',
  'PREVIEW_GATEWAY_PORT',
  'PROJECT_ALLOWED_ROOTS',
  'PROJECT_ALLOWED_ROOTS_APPEND',
  'PROJECT_DENIED_ROOTS',
  'REDIS_KEY_PREFIX',
  'REDIS_URL',
  'SUMMARY_TTL_SECONDS',
  'TASK_TTL_SECONDS',
  'THREAD_TTL_SECONDS',
  'TRANSCRIPT_DATA_DIR',
  'UPLOAD_DIR',
]);

export function buildSystemEnvSummary(): Array<EnvDefinition & { currentValue: string | null }> {
  return buildEnvSummary().filter((variable) => SYSTEM_VARS.has(variable.name));
}

export function isEditableEnvVar(def: EnvDefinition): boolean {
  return def.runtimeEditable === true;
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
