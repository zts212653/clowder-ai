import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentServiceOptions } from '../../../types.js';

export function isolatedOAuthEnv(home: string): Record<string, string | null> {
  // Tools share the operator's ordinary environment; provider identity and host
  // execution capabilities are rebuilt below rather than imported from the API.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !/^(AGY_|GEMINI_|GOOGLE_|CAT_CAFE_)/.test(entry[0]),
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
  const env: Record<string, string | null> = {
    ...inherited,
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    TERM: 'dumb',
    // Managed invocations must not mutate the installed carrier in the background.
    AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
    HOME: home,
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
