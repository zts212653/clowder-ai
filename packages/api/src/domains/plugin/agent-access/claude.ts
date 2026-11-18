import { Readable } from 'node:stream';
import type { CatId } from '@cat-cafe/shared';
import { AGENT_ACCESS_PLUGIN_ID } from '@clowder-ai/agent-contract';
import {
  type AgentAccessClaudeWireMessage,
  agentAccessClaudeProjectionSchema,
} from '@clowder-ai/agent-contract/claude';
import { isCliError, isCliTimeout, isLivenessWarning } from '../../../utils/cli-spawn.js';
import type { PluginRuntimeCarrierRouter } from '../carrier/runtime-carrier.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';
import { createClaudeEventBoundary } from './claude-events.js';

export function createAgentAccessClaudeOutput(
  inventory: Pick<PluginInventoryStore, 'readCurrentAuthority'>,
  runtime: Pick<PluginRuntimeCarrierRouter, 'invoke' | 'nativeActions'>,
) {
  async function* project(
    events: AsyncIterable<unknown>,
    input: { catId: CatId; signal: AbortSignal; stop: () => void; knownCredentials: readonly string[] },
    closed: AbortSignal,
  ) {
    const selected = (await inventory.readCurrentAuthority(AGENT_ACCESS_PLUGIN_ID))?.instance;
    if (!selected || selected.activationState !== 'enabled' || selected.runtimeState !== 'healthy')
      throw new Error('session_implementation_unavailable');
    const { pluginInstanceId } = selected;
    const retired = runtime.nativeActions.activationSignal(pluginInstanceId);
    const signal = AbortSignal.any([retired, input.signal, closed]);
    signal.throwIfAborted();

    const pending = new Map<number, unknown>();
    let inputEnded = false;
    let stopped = false;
    const stop = () => {
      if (inputEnded || stopped) return;
      stopped = true;
      input.stop();
    };
    signal.addEventListener('abort', stop, { once: true });
    const prepare = createClaudeEventBoundary(input.knownCredentials);
    const source = Readable.from(
      (async function* () {
        let sequence = 0;
        signal.throwIfAborted();
        for await (const raw of events) {
          const hostEvent = isCliError(raw) || isCliTimeout(raw) || isLivenessWarning(raw);
          const { before, host, projected } = prepare(hostEvent ? null : raw);
          if (before) {
            pending.set(sequence, before);
            yield { sequence: sequence++, event: before };
          }
          pending.set(sequence, hostEvent ? raw : host);
          yield { sequence: sequence++, event: projected };
        }
        inputEnded = true;
        const { before } = prepare(null);
        if (before) {
          pending.set(sequence, before);
          yield { sequence, event: before };
        }
      })(),
      { objectMode: true, highWaterMark: 1 },
    );

    try {
      const frames = await runtime.invoke(pluginInstanceId, 'projectClaudeOutput', {
        catId: input.catId,
        source,
        signal,
      });
      signal.throwIfAborted();
      if (!frames || typeof frames !== 'object' || !(Symbol.asyncIterator in frames))
        throw new Error('invalid_claude_output_stream');
      let nextSequence = 0;
      for await (const frame of frames as AsyncIterable<unknown>) {
        signal.throwIfAborted();
        const { sequence, messages, usage } = agentAccessClaudeProjectionSchema.parse(frame);
        if (sequence !== nextSequence || !pending.has(sequence)) throw new Error('invalid_claude_output_sequence');
        nextSequence += 1;
        const event = pending.get(sequence);
        pending.delete(sequence);
        if ((isCliError(event) || isCliTimeout(event) || isLivenessWarning(event)) && (messages || usage))
          throw new Error('invalid_claude_host_event_projection');
        const raw = event as Record<string, unknown> | null | undefined;
        if (usage && raw?.type !== 'result') throw new Error('invalid_claude_usage_frame');
        let sawControl = false;
        const project = (message: AgentAccessClaudeWireMessage) => {
          const session = message.type === 'session_init';
          const compact = message.type === 'provider_signal';
          if ((session || compact) && sawControl) throw new Error('duplicate_claude_control_frame');
          sawControl ||= session || compact;
          if (
            session
              ? raw?.type !== 'system' || raw.subtype !== 'init' || raw.session_id !== message.sessionId
              : message.sessionId !== undefined
          )
            throw new Error('invalid_claude_session_frame');
          if (
            compact
              ? raw?.type !== 'system' ||
                raw.subtype !== 'compact_boundary' ||
                !message.contextCompaction ||
                message.contextCompaction.preTokens !==
                  (typeof raw.pre_tokens === 'number' ? raw.pre_tokens : undefined)
              : message.contextCompaction !== undefined
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
      signal.removeEventListener('abort', stop);
      stop();
      source.destroy();
    }
  }

  return (events: Parameters<typeof project>[0], input: Parameters<typeof project>[1]) => {
    const closing = new AbortController();
    const iterator = project(events, input, closing.signal);
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => iterator.next(),
      return: () => {
        closing.abort();
        return iterator.return(undefined);
      },
    };
  };
}

export type AgentAccessClaudeOutput = ReturnType<typeof createAgentAccessClaudeOutput>;
