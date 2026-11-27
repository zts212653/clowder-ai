import {
  agentAdapterCancelResultSchema,
  agentAdapterEventSchema,
  agentAdapterOpenResultSchema,
  agentAdapterReleaseResultSchema,
} from '@clowder-ai/agent-contract';
import type {
  AgentSessionEvent,
  AgentSessionProvider,
  TurnRef,
} from '../../cats/services/agents/session-contract/types.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';

type SessionAction = 'openSession' | 'startTurn' | 'cancel' | 'release';
export type AgentAdapterSessionInvocation = (
  action: SessionAction,
  params: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
) => Promise<unknown>;

function protocolError(): never {
  throw new ExternalPluginRuntimeError('PROTOCOL_VIOLATION', 'Invalid Agent adapter session data');
}

function isEventStream(value: unknown): value is AsyncIterable<unknown> {
  return typeof (value as AsyncIterable<unknown> | undefined)?.[Symbol.asyncIterator] === 'function';
}

export function createAgentAdapterSessionProvider(
  invoke: AgentAdapterSessionInvocation,
  lifetime: AbortSignal,
): AgentSessionProvider {
  const bindings = new Map<string, string | undefined>();
  async function* readEvents(
    stream: AsyncIterable<unknown>,
    sessionId: string,
    turn: TurnRef,
  ): AsyncIterable<AgentSessionEvent> {
    let seq = 0;
    for await (const value of stream) {
      lifetime.throwIfAborted();
      const result = agentAdapterEventSchema.safeParse(value);
      if (!result.success) protocolError();
      const event = result.data;
      seq += 1;
      if (event.type !== 'native_bound') {
        yield { ...event, scope: 'turn', sessionId, turn, seq };
        if (event.type === 'done') return;
        continue;
      }
      const prior = bindings.get(sessionId);
      if (prior !== undefined && prior !== event.nativeSessionId) protocolError();
      bindings.set(sessionId, event.nativeSessionId);
      yield { ...event, scope: 'session', sessionId, seq };
    }
  }
  return {
    async openSession(input, signal) {
      const { sessionId, instructions, model, resume } = input;
      const result = agentAdapterOpenResultSchema.safeParse(
        await invoke(
          'openSession',
          {
            sessionId,
            instructions,
            ...(model === undefined ? {} : { model }),
            ...(resume === undefined ? {} : { resume: { nativeSessionId: resume.nativeSessionId } }),
          },
          signal,
        ),
      );
      if (!result.success) protocolError();
      if (result.data.ok) {
        const nativeId = result.data.binding.state === 'bound' ? result.data.binding.nativeSessionId : undefined;
        if (resume && nativeId !== resume.nativeSessionId)
          return {
            ok: false,
            code: 'resume_unavailable',
            reason: 'Agent adapter did not resume the requested session',
          };
        bindings.set(sessionId, nativeId);
      }
      return result.data;
    },
    async startTurn(sessionId, input, signal) {
      if (!bindings.has(sessionId)) return { ok: false, code: 'session_unavailable' };
      if (input.prompt.kind !== 'frozen')
        return { ok: false, code: 'failed', reason: 'continuity_preflight_unsupported' };
      const turn = { invocationId: input.invocation.invocationId };
      const stream = await invoke(
        'startTurn',
        { sessionId, invocationId: turn.invocationId, prompt: input.prompt.text },
        signal,
      );
      if (!isEventStream(stream)) protocolError();
      return { ok: true, turn, events: readEvents(stream, sessionId, turn) };
    },
    async cancelTurn(sessionId, expected, reason) {
      const result = agentAdapterCancelResultSchema.safeParse(
        await invoke('cancel', { sessionId, invocationId: expected.invocationId, reason }),
      );
      if (!result.success) protocolError();
      return result.data;
    },
    async release(sessionId, reason) {
      bindings.delete(sessionId);
      const result = agentAdapterReleaseResultSchema.safeParse(await invoke('release', { sessionId, reason }));
      if (!result.success) protocolError();
      return result.data;
    },
    async input() {
      return { status: 'unsupported' };
    },
    capabilities() {
      return {
        input: 'unsupported',
        inputReadReceipt: 'unsupported',
        inspectInput: 'unsupported',
        cancelTurn: 'supported',
        compact: 'unsupported',
        observesCompaction: false,
        continuityEvidence: 'none',
      };
    },
  };
}
