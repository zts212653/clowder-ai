import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CodexAppServerJsonObject } from '../../cats/services/agents/providers/CodexAppServerEventMapper.js';
import type { LiveNativeCredentials } from './live-native-credentials.js';

/** Construct only the accepted household surface; unrelated configured MCP servers are disabled by the native client. */
export async function buildLiveMcpConfig(input: {
  credentials: LiveNativeCredentials;
  callbackEnv: Record<string, string>;
  mcpDistDir: string;
  allowedDirectories: readonly string[];
  screenServer?: CodexAppServerJsonObject;
  householdToolsEnabled?: boolean;
}): Promise<CodexAppServerJsonObject> {
  await input.credentials.bind(input.callbackEnv);
  if (!input.callbackEnv.CAT_CAFE_API_URL || input.allowedDirectories.length === 0)
    throw new Error('Live scope unavailable');
  const servers: CodexAppServerJsonObject = {};
  for (const family of input.householdToolsEnabled === false ? [] : ['collab', 'memory']) {
    const entry = join(input.mcpDistDir, `${family}.js`);
    if (!existsSync(entry)) throw new Error('Live MCP runtime is not built');
    servers[`cat-cafe-${family}`] = {
      enabled: true,
      required: true,
      command: process.execPath,
      args: [entry],
      // Search returns repository-relative docs paths; file authority remains the explicit roots below.
      cwd: resolve(input.mcpDistDir, '../../..'),
      env: {
        ...input.credentials.environment(),
        CAT_CAFE_API_URL: input.callbackEnv.CAT_CAFE_API_URL,
        CAT_CAFE_USER_ID: input.callbackEnv.CAT_CAFE_USER_ID,
        CAT_CAFE_CAT_ID: input.callbackEnv.CAT_CAFE_CAT_ID,
        CAT_CAFE_THREAD_ID: input.callbackEnv.CAT_CAFE_THREAD_ID,
        ALLOWED_WORKSPACE_DIRS: input.allowedDirectories.join(','),
      },
    };
  }
  if (input.screenServer)
    servers['cat-cafe-selected-screen'] = {
      ...input.screenServer,
      env: {
        ...(input.screenServer.env as Record<string, string>),
        ...input.credentials.environment(),
        CAT_CAFE_API_URL: input.callbackEnv.CAT_CAFE_API_URL,
      },
    };
  return {
    mcp_servers: servers,
    'features.shell_tool': false,
    'features.apply_patch_freeform': false,
    'apps._default.enabled': false,
  };
}
