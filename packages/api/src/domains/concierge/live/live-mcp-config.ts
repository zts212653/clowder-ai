import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CodexAppServerJsonObject } from '../../cats/services/agents/providers/CodexAppServerEventMapper.js';
import type { LiveNativeCredentials } from './live-native-credentials.js';

export const LIVE_MEETING_TOOL_NAMES = [
  'cat_cafe_meeting_sources',
  'cat_cafe_meeting_start',
  'cat_cafe_meeting_attach',
  'cat_cafe_meeting_status',
  'cat_cafe_meeting_stop',
] as const;
export const LIVE_TASK_TOOL_NAMES = [
  'cat_cafe_admit_entrusted_work',
  'cat_cafe_read_entrusted_work',
  'cat_cafe_update_entrusted_work',
  'cat_cafe_update_task',
  'cat_cafe_close_entrusted_work',
] as const;

function collabToolPolicy(household: boolean, meeting: boolean): CodexAppServerJsonObject {
  const tools: CodexAppServerJsonObject = {};
  if (household)
    Object.assign(tools, {
      cat_cafe_page_action_inspect: { approval_mode: 'approve' },
      cat_cafe_home_action: { approval_mode: 'approve' },
      ...Object.fromEntries(LIVE_TASK_TOOL_NAMES.map((name) => [name, { approval_mode: 'approve' }])),
    });
  if (meeting)
    Object.assign(
      tools,
      Object.fromEntries(LIVE_MEETING_TOOL_NAMES.map((name) => [name, { approval_mode: 'approve' }])),
    );
  if (!household) return { tools, enabled_tools: [...LIVE_MEETING_TOOL_NAMES] };
  if (!meeting) return { tools, disabled_tools: [...LIVE_MEETING_TOOL_NAMES] };
  return { tools };
}

/** Construct only the accepted household surface; unrelated configured MCP servers are disabled by the native client. */
export async function buildLiveMcpConfig(input: {
  credentials: LiveNativeCredentials;
  callbackEnv: Record<string, string>;
  mcpDistDir: string;
  allowedDirectories: readonly string[];
  screenServer?: CodexAppServerJsonObject;
  householdToolsEnabled?: boolean;
  /** Enabled by the composition only after the meeting bundle and governed tools are loaded. */
  meetingToolsEnabled?: boolean;
}): Promise<CodexAppServerJsonObject> {
  await input.credentials.bind(input.callbackEnv);
  if (!input.callbackEnv.CAT_CAFE_API_URL || input.allowedDirectories.length === 0)
    throw new Error('Live scope unavailable');
  const servers: CodexAppServerJsonObject = {};
  const families =
    input.householdToolsEnabled === false ? (input.meetingToolsEnabled ? ['collab'] : []) : ['collab', 'memory'];
  for (const family of families) {
    const entry = join(input.mcpDistDir, `${family}.js`);
    if (!existsSync(entry)) throw new Error('Live MCP runtime is not built');
    servers[`cat-cafe-${family}`] = {
      enabled: true,
      required: true,
      command: process.execPath,
      args: [entry],
      // Search returns repository-relative docs paths; file authority remains the explicit roots below.
      cwd: resolve(input.mcpDistDir, '../../..'),
      // Codex otherwise asks for approval of truthful open-world inspection, which Live cannot prompt for.
      // This only permits selection; the Host still requires a separate owner confirmation before any page effect.
      ...(family === 'collab'
        ? collabToolPolicy(input.householdToolsEnabled !== false, input.meetingToolsEnabled === true)
        : {}),
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
