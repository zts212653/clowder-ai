import type { AgentAccessCodexAppServerNotificationProjection } from '@clowder-ai/agent-contract';

/**
 * Codex app-server notification method table.
 *
 * This is intentionally only method names. The Host reuses its existing
 * envelope mapper and field readers; it does not interpret field paths from
 * package data. 0.169.1 emits four metadata/status methods that have no current
 * user-visible mapping; listing them as ignored keeps the observed behavior
 * explicit without inventing events.
 */
export const CODEX_APP_SERVER_NOTIFICATION_PROJECTION: AgentAccessCodexAppServerNotificationProjection = {
  version: 1,
  methods: [
    'item/started',
    'item/completed',
    'item/agentMessage/delta',
    'turn/started',
    'turn/completed',
    'turn/plan/updated',
    'thread/goal/updated',
    'thread/goal/cleared',
    'thread/tokenUsage/updated',
    'error',
  ],
  ignoredMethods: [
    'thread/started',
    'thread/status/changed',
    'remoteControl/status/changed',
    'account/rateLimits/updated',
  ],
  // Display-only same-shape alias. It must not become a terminal, permission,
  // write, or thread/turn identity signal; Host validates the target.
  aliases: {
    'item/agent_message_delta': 'item/agentMessage/delta',
  },
};
