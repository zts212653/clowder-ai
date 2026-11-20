import { configuredCredentialValues } from '@cat-cafe/mcp-server/dist/secret-runtime.js';
import type { CatId } from '@cat-cafe/shared';
import { AGENT_ACCESS_PLUGIN_ID } from '@clowder-ai/agent-contract';
import { agentAccessClaudeBatchResultSchema } from '@clowder-ai/agent-contract/claude';
import { sanitizeRawEvent } from '../../cats/services/agents/providers/codex-audit-hooks.js';
import { claudePostToolFileEvidence } from '../../cats/services/agents/providers/native-file-result-evidence.js';
import type { PluginRuntimeCarrierRouter } from '../carrier/runtime-carrier.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';
import { createClaudeEventBoundary } from './claude-events.js';

export function createAgentAccessClaudeBatch(
  inventory: Pick<PluginInventoryStore, 'readCurrentAuthority'>,
  runtime: Pick<PluginRuntimeCarrierRouter, 'invoke' | 'nativeActions'>,
) {
  return async (mode: 'transcript' | 'hook', catId: CatId, environment?: Record<string, string | undefined>) => {
    const selected = (await inventory.readCurrentAuthority(AGENT_ACCESS_PLUGIN_ID))?.instance;
    if (!selected || selected.activationState !== 'enabled' || selected.runtimeState !== 'healthy')
      throw new Error('session_implementation_unavailable');
    const id = selected.pluginInstanceId;
    const signal = runtime.nativeActions.activationSignal(id);
    const credentials = configuredCredentialValues({ ...process.env, ...environment });
    const prepare = createClaudeEventBoundary(credentials);
    return {
      signal,
      async project(raw: unknown[], lastTextMessageId?: string) {
        signal.throwIfAborted();
        const entries = raw.map((value) => {
          if (!value || typeof value !== 'object') return null;
          const entry = value as Record<string, unknown>;
          if (mode === 'transcript') return entry.type === 'assistant' ? prepare(entry).projected : null;
          if (entry.hook_event_name === 'Stop') {
            return sanitizeRawEvent(
              {
                hook_event_name: 'Stop',
                last_assistant_message: entry.last_assistant_message,
              },
              credentials,
            );
          }
          if (entry.hook_event_name === 'PostToolUse') {
            return sanitizeRawEvent(
              {
                hook_event_name: 'PostToolUse',
                tool_name: entry.tool_name,
                tool_input: entry.tool_input,
                tool_use_id: typeof entry.tool_use_id === 'string' ? entry.tool_use_id : undefined,
              },
              credentials,
            );
          }
          return null;
        });
        if (entries.every((entry) => entry == null)) return { messages: [], lastTextMessageId };
        const projected = await runtime.invoke(id, 'projectClaudeBatch', { mode, catId, entries, lastTextMessageId });
        signal.throwIfAborted();
        const { frames, lastTextMessageId: nextTextMessageId } = agentAccessClaudeBatchResultSchema.parse(projected);
        let lastIndex = -1;
        const messages = frames.map(({ index, message }) => {
          if (!entries[index] || index < lastIndex || message.sessionId || message.contextCompaction)
            throw new Error('invalid_claude_batch_frame');
          if (mode === 'transcript') {
            if (!['text', 'tool_use', 'system_info', 'error'].includes(message.type))
              throw new Error('invalid_claude_batch_frame');
            lastIndex = index;
            return { ...message, catId };
          }
          const entry = entries[index] as Record<string, unknown>;
          if (index === lastIndex) throw new Error('duplicate_claude_hook_frame');
          lastIndex = index;
          if (entry.hook_event_name === 'Stop' && message.type === 'text') return { ...message, catId };
          if (
            entry.hook_event_name !== 'PostToolUse' ||
            message.type !== 'tool_use' ||
            message.toolName !== entry.tool_name ||
            message.toolUseId !== entry.tool_use_id
          ) {
            throw new Error('invalid_claude_hook_frame');
          }
          const fileResultEvidence = claudePostToolFileEvidence(raw[index] as Record<string, unknown>);
          return { ...message, catId, ...(fileResultEvidence ? { fileResultEvidence } : {}) };
        });
        return { messages, lastTextMessageId: nextTextMessageId };
      },
    };
  };
}

export type AgentAccessClaudeBatch = ReturnType<typeof createAgentAccessClaudeBatch>;
