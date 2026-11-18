import { Readable } from 'node:stream';
import type { CatId } from '@cat-cafe/shared';
import { AGENT_ACCESS_PLUGIN_ID } from '@clowder-ai/agent-contract';
import {
  type AgentAccessClaudeWireMessage,
  agentAccessClaudeProjectionSchema,
} from '@clowder-ai/agent-contract/claude';
import { isCliError, isCliTimeout, isLivenessWarning } from '../../../utils/cli-spawn.js';
import { sanitizeRawEvent } from '../../cats/services/agents/providers/codex-audit-hooks.js';
import type { PluginRuntimeCarrierRouter } from '../carrier/runtime-carrier.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';

export function createAgentAccessClaudeOutput(
  inventory: Pick<PluginInventoryStore, 'readCurrentAuthority'>,
  runtime: Pick<PluginRuntimeCarrierRouter, 'invoke' | 'nativeActions'>,
) {
  return async function* (
    events: AsyncIterable<unknown>,
    input: { catId: CatId; signal: AbortSignal; stop: () => void; knownCredentials: readonly string[] },
  ) {
    const selected = (await inventory.readCurrentAuthority(AGENT_ACCESS_PLUGIN_ID))?.instance;
    if (!selected || selected.activationState !== 'enabled' || selected.runtimeState !== 'healthy')
      throw new Error('session_implementation_unavailable');
    const { pluginInstanceId } = selected;
    const generation = runtime.nativeActions.generation(pluginInstanceId);
    const assertCurrent = () => {
      if (runtime.nativeActions.generation(pluginInstanceId) !== generation)
        throw new Error('session_implementation_unavailable');
    };

    const pending = new Map<number, unknown>();
    let inputEnded = false;
    const source = Readable.from(
      (async function* () {
        let sequence = 0;
        assertCurrent();
        input.signal.throwIfAborted();
        for await (const raw of events) {
          const hostEvent = isCliError(raw) || isCliTimeout(raw) || isLivenessWarning(raw);
          const event = hostEvent ? raw : sanitizeRawEvent(raw, input.knownCredentials);
          pending.set(sequence, event);
          yield { sequence, event: hostEvent ? null : event };
          sequence += 1;
        }
        inputEnded = true;
      })(),
      { objectMode: true, highWaterMark: 1 },
    );

    try {
      const frames = await runtime.invoke(pluginInstanceId, 'projectClaudeOutput', {
        catId: input.catId,
        source,
        signal: input.signal,
      });
      assertCurrent();
      if (!frames || typeof frames !== 'object' || !(Symbol.asyncIterator in frames))
        throw new Error('invalid_claude_output_stream');
      let nextSequence = 0;
      for await (const frame of frames as AsyncIterable<unknown>) {
        assertCurrent();
        input.signal.throwIfAborted();
        const { sequence, messages, usage } = agentAccessClaudeProjectionSchema.parse(frame);
        if (sequence !== nextSequence || !pending.has(sequence)) throw new Error('invalid_claude_output_sequence');
        nextSequence += 1;
        const event = pending.get(sequence);
        pending.delete(sequence);
        if ((isCliError(event) || isCliTimeout(event) || isLivenessWarning(event)) && (messages || usage))
          throw new Error('invalid_claude_host_event_projection');
        const raw = event as Record<string, unknown> | null | undefined;
        if (usage && (raw?.type !== 'result' || raw.subtype !== 'success'))
          throw new Error('invalid_claude_usage_frame');
        const project = (message: AgentAccessClaudeWireMessage) => {
          if (
            message.type === 'session_init' &&
            (raw?.type !== 'system' || raw.subtype !== 'init' || raw.session_id !== message.sessionId)
          )
            throw new Error('invalid_claude_session_frame');
          if (
            message.type === 'provider_signal' &&
            (raw?.type !== 'system' ||
              raw.subtype !== 'compact_boundary' ||
              !message.contextCompaction ||
              message.contextCompaction.preTokens !==
                (typeof raw.pre_tokens === 'number' ? raw.pre_tokens : undefined))
          )
            throw new Error('invalid_claude_compaction_frame');
          if (
            message.type === 'system_info' &&
            !['thinking', 'mcp_server_status', 'rate_limit'].includes(JSON.parse(message.content ?? '{}')?.type)
          )
            throw new Error('invalid_claude_system_info_frame');
          return { ...message, catId: input.catId };
        };
        yield {
          event,
          messages: Array.isArray(messages) ? messages.map(project) : messages && project(messages),
          usage,
        };
      }
      if (!inputEnded || pending.size > 0) throw new Error('incomplete_claude_output_stream');
    } finally {
      if (!inputEnded) input.stop();
      source.destroy();
    }
  };
}

export type AgentAccessClaudeOutput = ReturnType<typeof createAgentAccessClaudeOutput>;
