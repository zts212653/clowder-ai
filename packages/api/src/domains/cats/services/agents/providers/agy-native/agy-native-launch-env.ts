import { join } from 'node:path';
import type { AgentServiceOptions } from '../../../types.js';

export function isolatedOAuthEnv(home: string): Record<string, string | null> {
  const env: Record<string, string | null> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    TERM: 'dumb',
    // Managed invocations must not mutate the installed carrier in the background.
    AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
    HOME: home,
    GEMINI_HOME: join(home, '.gemini'),
    XDG_CONFIG_HOME: join(home, '.config'),
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
  // OAuth and model requests still need the host's configured network route.
  // Keep casing and bypass lists intact without inheriting credentials or hooks.
  for (const key of [
    'HTTP_PROXY',
    'http_proxy',
    'HTTPS_PROXY',
    'https_proxy',
    'ALL_PROXY',
    'all_proxy',
    'NO_PROXY',
    'no_proxy',
  ]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
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
