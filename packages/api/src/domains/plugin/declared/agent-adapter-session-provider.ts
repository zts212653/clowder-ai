import {
  agentAdapterCancelResultSchema,
  agentAdapterEventSchema,
  agentAdapterOpenResultSchema,
  agentAdapterReleaseResultSchema,
} from '@clowder-ai/agent-contract';
import type {
  AgentSessionEvent,
  AgentSessionProvider,
  OpenSessionInput,
  TurnRef,
} from '../../cats/services/agents/session-contract/types.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';

type SessionAction = 'openSession' | 'startTurn' | 'cancel' | 'release';
export type AgentAdapterSessionScope = Readonly<
  Pick<
    OpenSessionInput,
    'sessionId' | 'cwd' | 'config' | 'executionAccount' | 'instructions' | 'model' | 'hostOptions'
  > & {
    resumeNativeSessionId?: string;
    prompt?: string;
  }
>;
export type AgentAdapterSessionInvocation = (
  action: SessionAction,
  params: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
  hostSession?: AgentAdapterSessionScope,
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
  const bindings = new Map<
    string,
    { nativeId: string | undefined; scope: AgentAdapterSessionScope; rejectedNativeId?: string }
  >();
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
      if (
        !prior ||
        prior.rejectedNativeId === event.nativeSessionId ||
        (prior.nativeId !== undefined && prior.nativeId !== event.nativeSessionId)
      )
        protocolError();
      prior.nativeId = event.nativeSessionId;
      yield { ...event, scope: 'session', sessionId, seq };
    }
  }
  return {
    revalidateInstructions: true,
    async openSession(input, signal) {
      const { sessionId, instructions, model, resume, cwd, config, executionAccount, hostOptions } = input;
      const scope: AgentAdapterSessionScope = {
        sessionId,
        cwd,
        instructions,
        ...(model === undefined ? {} : { model }),
        ...(config === undefined ? {} : { config }),
        ...(executionAccount === undefined ? {} : { executionAccount }),
      };
      const publicInput = { sessionId, instructions, ...(model === undefined ? {} : { model }) };
      const open = async (request: OpenSessionInput['resume']) => {
        const result = agentAdapterOpenResultSchema.safeParse(
          await invoke(
            'openSession',
            { ...publicInput, ...(request === undefined ? {} : { resume: request }) },
            signal,
            {
              ...scope,
              ...(hostOptions === undefined ? {} : { hostOptions }),
              ...(request === undefined ? {} : { resumeNativeSessionId: request.nativeSessionId }),
            },
          ),
        );
        if (!result.success) protocolError();
        return result.data;
      };
      const first = await open(resume);
      const fallback =
        resume?.onUnavailable === 'start_new' && !first.ok && first.code === 'resume_unavailable'
          ? { previousSessionId: resume.nativeSessionId, reason: first.identityStatus ?? ('unavailable' as const) }
          : undefined;
      const result = fallback ? await open(undefined) : first;
      if (!result.ok) return result;
      const nativeId = result.binding.state === 'bound' ? result.binding.nativeSessionId : undefined;
      if (fallback ? nativeId === fallback.previousSessionId : resume && nativeId !== resume.nativeSessionId)
        return { ok: false, code: 'resume_unavailable', reason: 'Agent adapter returned an unexpected session' };
      bindings.set(sessionId, {
        nativeId,
        scope,
        ...(fallback ? { rejectedNativeId: fallback.previousSessionId } : {}),
      });
      return { ...result, ...(fallback ? { resumeFallback: fallback } : {}) };
    },
    async startTurn(sessionId, input, signal) {
      const binding = bindings.get(sessionId);
      if (!binding) return { ok: false, code: 'session_unavailable' };
      if (input.hostOptions?.workingDirectory && input.hostOptions.workingDirectory !== binding.scope.cwd)
        return { ok: false, code: 'session_unavailable', reason: 'Agent session working directory changed' };
      const previousAccount = binding.scope.executionAccount;
      const currentAccount = input.hostOptions?.executionAccount;
      if (
        previousAccount?.accountRef !== currentAccount?.accountRef ||
        previousAccount?.authType !== currentAccount?.authType ||
        previousAccount?.accountRevision !== currentAccount?.accountRevision ||
        previousAccount?.credentialVersion !== currentAccount?.credentialVersion
      )
        return { ok: false, code: 'session_unavailable', reason: 'Agent session execution account changed' };
      if (input.prompt.kind !== 'frozen')
        return { ok: false, code: 'failed', reason: 'continuity_preflight_unsupported' };
      const turn = { invocationId: input.invocation.invocationId };
      const stream = await invoke(
        'startTurn',
        { sessionId, invocationId: turn.invocationId, prompt: input.prompt.text },
        signal,
        {
          ...binding.scope,
          prompt: input.prompt.text,
          ...(input.hostOptions === undefined ? {} : { hostOptions: input.hostOptions }),
        },
      );
      if (!isEventStream(stream)) protocolError();
      return { ok: true, turn, events: readEvents(stream, sessionId, turn) };
    },
    async cancelTurn(sessionId, expected, reason) {
      const result = agentAdapterCancelResultSchema.safeParse(
        await invoke(
          'cancel',
          { sessionId, invocationId: expected.invocationId, reason },
          undefined,
          bindings.get(sessionId)?.scope,
        ),
      );
      if (!result.success) protocolError();
      return result.data;
    },
    async release(sessionId, reason) {
      const binding = bindings.get(sessionId);
      bindings.delete(sessionId);
      const result = agentAdapterReleaseResultSchema.safeParse(
        await invoke('release', { sessionId, reason }, undefined, binding?.scope),
      );
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
