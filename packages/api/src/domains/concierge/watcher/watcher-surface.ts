import { CANONICAL_TOOL_REGISTRY } from '@cat-cafe/mcp-server/dist/canonical-server-tools.js';
import { normalizeToolExecutionPolicy } from '../../cats/services/agents/invocation/tool-execution-policy.js';
import { WATCHER_TOOL_ROUTES as WATCHER_TOOLS } from '../../cats/services/agents/invocation/WatcherToolTicket.js';
import type { CodexAppServerJsonObject } from '../../cats/services/agents/providers/CodexAppServerEventMapper.js';
import { CODEX_LIVE_DISABLED_FEATURES } from '../../cats/services/agents/providers/codex-live-policy.js';

/** This surface adds installed owner tools only. Matter storage and proposal receipts retain their own owners. */

export function watcherToolSurface(callbackEnv: Record<string, string>) {
  const tools = CANONICAL_TOOL_REGISTRY.filter((tool) => Object.hasOwn(WATCHER_TOOLS, tool.name));
  const allowedToolNames = tools.map((tool) => tool.name);
  const policy = normalizeToolExecutionPolicy({
    mode: 'watcher',
    maxToolCalls: 6,
    allowedToolNames,
    allowedCallbackRoutes: [
      'POST /api/callbacks/watcher-tool-admission',
      ...allowedToolNames.flatMap((name) => WATCHER_TOOLS[name as keyof typeof WATCHER_TOOLS]),
    ],
  });
  return {
    policy,
    tools,
    requiredTools: [] as string[],
    config: {
      mcp_servers: {},
      model_context_window: 30000,
      features: Object.fromEntries(
        [
          ...CODEX_LIVE_DISABLED_FEATURES,
          'hooks',
          'multi_agent',
          'code_mode_host',
          'default_mode_request_user_input',
        ].map((feature) => [feature, false]),
      ),
      tools: { experimental_request_user_input: { enabled: false } },
      include_permissions_instructions: false,
      include_environment_context: false,
      include_environment_context_time: false,
      include_collaboration_mode_instructions: false,
      skills: { include_instructions: false },
      orchestrator: { skills: { enabled: false }, mcp: { enabled: false } },
      'apps._default.enabled': false,
    } satisfies CodexAppServerJsonObject,
  };
}
