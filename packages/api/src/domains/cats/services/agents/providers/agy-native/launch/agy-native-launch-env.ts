import { accessSync, constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import type { AgentServiceOptions } from '../../../../types.js';

const FORBIDDEN_ACCOUNT_ENV_EXACT = new Set([
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GEMINI_BASE_URL',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'HOME',
  'USERPROFILE',
  'GEMINI_HOME',
  'PATH',
  'REDIS_URL',
  'NODE_OPTIONS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'BASH_ENV',
  'ENV',
  'ZDOTDIR',
  'SSH_TTY',
]);

// Git's namespace controls executable helpers, config sources and repository
// identity. Account settings cannot grant any of that host execution authority.
const FORBIDDEN_ACCOUNT_ENV_PREFIX = /^(?:AGY_|CAT_CAFE_|XDG_|GIT_|BAICODE_|JETSKI_|DYLD_|ANTIGRAVITY_)/;
const FORBIDDEN_ACCOUNT_ENV_PROXY = /^(?:HTTP|HTTPS|ALL|NO)_PROXY$/;

export function assertSafeAgyAccountEnv(accountEnv?: Record<string, string>): Record<string, string> {
  if (!accountEnv) return {};
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(accountEnv)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string') {
      throw new Error(`AGY accountEnv contains invalid entry: ${key}`);
    }
    const upper = key.toUpperCase();
    if (
      FORBIDDEN_ACCOUNT_ENV_EXACT.has(upper) ||
      FORBIDDEN_ACCOUNT_ENV_PREFIX.test(upper) ||
      FORBIDDEN_ACCOUNT_ENV_PROXY.test(upper)
    ) {
      throw new Error(`AGY accountEnv refuses credential, proxy, or runtime-reserved key: ${key}`);
    }
    sanitized[key] = value;
  }
  return sanitized;
}

function hasExecutableRg(dir: string): boolean {
  try {
    accessSync(join(dir, process.platform === 'win32' ? 'rg.exe' : 'rg'), constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function sanitizeAgyToolPath(rawPath?: string): string {
  const seen = new Set<string>();
  const segments: string[] = [];
  const fallback = process.platform === 'win32' ? '' : '/usr/bin:/bin';
  for (const raw of (rawPath ?? fallback).split(delimiter)) {
    const seg = raw.trim();
    if (!seg || /[\r\n\0]/.test(raw) || !isAbsolute(seg) || seen.has(seg)) continue;
    seen.add(seg);
    segments.push(seg);
  }
  if (process.platform !== 'win32') {
    for (const base of ['/usr/bin', '/bin']) {
      if (!seen.has(base)) {
        seen.add(base);
        segments.push(base);
      }
    }
  }
  if (!segments.some(hasExecutableRg)) {
    const host = homedir();
    const candidates = [
      '/opt/homebrew/bin',
      '/opt/homebrew/opt/ripgrep/bin',
      '/usr/local/bin',
      '/usr/local/opt/ripgrep/bin',
      join(host, '.cargo', 'bin'),
      join(host, '.local', 'bin'),
      '/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex-path',
      '/opt/homebrew/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/path',
      '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/vendor/ripgrep/arm64-darwin',
    ];
    const rgDir = candidates.find((candidate) => !seen.has(candidate) && hasExecutableRg(candidate));
    if (rgDir) {
      seen.add(rgDir);
      segments.push(rgDir);
    }
  }
  return segments.join(delimiter);
}

export function isolatedOAuthEnv(home: string, accountEnv?: Record<string, string>): Record<string, string | null> {
  const safeAccountEnv = assertSafeAgyAccountEnv(accountEnv);
  // Tools share the operator's ordinary environment; provider identity and host
  // execution capabilities are rebuilt below rather than imported from the API.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !/^(AGY_|GEMINI_|GOOGLE_|CAT_CAFE_)/.test(entry[0]) &&
        !(process.platform === 'win32' && entry[0].toLowerCase() === 'path'),
    ),
  );
  const host = homedir();
  const toolRoots: Record<string, string> = {
    XDG_CONFIG_HOME: join(host, '.config'),
    XDG_CACHE_HOME: join(host, '.cache'),
    XDG_DATA_HOME: join(host, '.local', 'share'),
    XDG_STATE_HOME: join(host, '.local', 'state'),
  };
  for (const [key, fallback] of Object.entries(toolRoots)) {
    if (!inherited[key]) inherited[key] = fallback;
  }
  if (!inherited.GH_CONFIG_DIR) inherited.GH_CONFIG_DIR = join(inherited.XDG_CONFIG_HOME, 'gh');
  const rawPath = process.env.PATH ?? (process.platform === 'win32' ? process.env.Path : undefined);
  const env: Record<string, string | null> = {
    ...inherited,
    ...safeAccountEnv,
    PATH: sanitizeAgyToolPath(rawPath),
    LANG: safeAccountEnv.LANG ?? process.env.LANG ?? 'en_US.UTF-8',
    TMPDIR: tmpdir(),
    TERM: 'dumb',
    // Managed invocations must not mutate the installed carrier in the background.
    AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
    HOME: home,
    ...(process.platform === 'win32' ? { USERPROFILE: home } : {}),
    GEMINI_HOME: join(home, '.gemini'),
    // Only the command shell consumes this; the carrier keeps its account HOME.
    CAT_CAFE_NATIVE_TOOL_HOME: host,
    CAT_CAFE_NATIVE_NONINTERACTIVE_GIT: '1',
    CAT_CAFE_ORIGINAL_ZDOTDIR: process.env.CAT_CAFE_ORIGINAL_ZDOTDIR || process.env.ZDOTDIR || host,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    // Git tries askpass before its terminal flag, including core.askPass/SSH fallbacks.
    GIT_ASKPASS: 'false',
    // Runtime storage and executable injection are not ordinary tool settings.
    REDIS_URL: null,
    NODE_OPTIONS: null,
    BASH_ENV: null,
    ENV: null,
    LD_PRELOAD: null,
    DYLD_INSERT_LIBRARIES: null,
    GEMINI_API_KEY: null,
    GOOGLE_API_KEY: null,
    GOOGLE_GENAI_USE_VERTEXAI: null,
    GOOGLE_APPLICATION_CREDENTIALS: null,
    GOOGLE_CLOUD_PROJECT: null,
    GOOGLE_CLOUD_LOCATION: null,
    CAT_CAFE_AGENT_KEY_SECRET: null,
    CAT_CAFE_AGENT_KEY_FILE: null,
    CAT_CAFE_AGENT_KEY_FILES: null,
    CAT_CAFE_READONLY_AGENT_KEY_UNION: null,
    CAT_CAFE_API_URL: null,
    CAT_CAFE_INVOCATION_ID: null,
    CAT_CAFE_CALLBACK_TOKEN: null,
    CAT_CAFE_CREDENTIAL_FILE: null,
    CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE: null,
    CAT_CAFE_DESKTOP_MODE: null,
    CAT_CAFE_MCP_PROFILE: null,
    CAT_CAFE_READONLY: null,
    CAT_CAFE_DEPLOYMENT_ID: process.env.CAT_CAFE_DEPLOYMENT_ID ?? null,
    CAT_CAFE_RUNTIME_ROOT: process.env.CAT_CAFE_RUNTIME_ROOT ?? null,
    CAT_CAFE_HOST_NODE_ID: process.env.CAT_CAFE_HOST_NODE_ID ?? null,
  };
  return env;
}

export function executionOwnerEnv(options?: AgentServiceOptions): Record<string, string> {
  const context = options?.auditContext;
  if (!context) return {};
  return {
    CAT_CAFE_EXECUTION_ID: context.executionId ?? context.invocationId,
    CAT_CAFE_INVOCATION_ID: context.invocationId,
    CAT_CAFE_THREAD_ID: context.threadId,
    CAT_CAFE_CAT_ID: context.catId,
    CAT_CAFE_USER_ID: context.userId,
  };
}
