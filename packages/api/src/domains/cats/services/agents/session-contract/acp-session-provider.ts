import { isDeepStrictEqual } from 'node:util';
import type { CatId } from '@cat-cafe/shared';
import type { AgentMessage, AgentService, AgentServiceOptions, MessageMetadata } from '../../types.js';
import type * as Contract from './types.js';

type ActiveTurn = { controller: AbortController; ref: Contract.TurnRef; done: boolean };
export type AcpService = AgentService & {
  releaseSession?(nativeSessionId: string): Promise<void>;
  disposeHostService?(): Promise<void>;
};
interface Session {
  nativeId?: string;
  active?: ActiveTurn;
}
export class AcpSessionProvider implements Contract.AgentSessionProvider {
  private readonly sessions = new Map<string, Session>();
  constructor(
    private readonly deps: {
      catId: CatId;
      service: AcpService;
      prepareHostService?(): Promise<AgentService>;
      hostService?(): AgentService | undefined;
      bindHostService?(service: AgentService): Contract.AgentSessionProvider | undefined;
      disposeHostService?(): Promise<void>;
    },
  ) {}
  prepareHostService(): Promise<AgentService> {
    return this.deps.prepareHostService?.() ?? Promise.resolve(this.deps.service);
  }
  hostService(): AgentService | undefined {
    return this.deps.hostService ? this.deps.hostService() : this.deps.service;
  }
  bindHostService(service: AgentService): Contract.AgentSessionProvider | undefined {
    if (service !== this.hostService()) return;
    return this.deps.bindHostService ? this.deps.bindHostService(service) : this;
  }
  async disposeHostService(): Promise<void> {
    if (this.deps.disposeHostService) await this.deps.disposeHostService();
    else await this.deps.service.disposeHostService?.();
  }
  capabilities(): Contract.AgentSessionCapabilities {
    return {
      input: 'unsupported',
      inputReadReceipt: 'unsupported',
      inspectInput: 'unsupported',
      compact: 'unsupported',
      cancelTurn: 'supported',
      observesCompaction: false,
      continuityEvidence: 'none',
    };
  }
  async openSession(input: Contract.OpenSessionInput): Promise<Contract.OpenSessionResult> {
    const session = this.sessions.get(input.sessionId) ?? {};
    if (input.resume) session.nativeId = input.resume.nativeSessionId;
    this.sessions.set(input.sessionId, session);
    return { ok: true, binding: { state: 'pending_first_input' } };
  }
  async startTurn(
    sessionId: string,
    input: Contract.TurnInput,
    signal: AbortSignal,
  ): Promise<Contract.StartTurnResult> {
    if (input.prompt.kind !== 'frozen') return { ok: false, code: 'failed', reason: 'deferred_prompt_unsupported' };
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false, code: 'session_unavailable' };
    if (session.active) return { ok: false, code: 'busy' };
    const controller = new AbortController();
    const active = { controller, ref: { invocationId: input.invocation.invocationId }, done: false };
    session.active = active;
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const options: AgentServiceOptions = {
      ...input.hostOptions,
      invocationId: active.ref.invocationId,
      callbackEnv: input.invocation.callbackEnv,
      signal: controller.signal,
    };
    if (session.nativeId) options.sessionId = session.nativeId;
    else delete options.sessionId;
    const cleanup = () => {
      signal.removeEventListener('abort', abort);
      if (session.active === active) session.active = undefined;
    };
    let source: AsyncIterable<AgentMessage>;
    try {
      source = this.deps.service.invoke(input.prompt.text, options);
    } catch (error) {
      cleanup();
      throw error;
    }
    const events = this.events(sessionId, session, source, active, cleanup);
    return {
      ok: true,
      turn: active.ref,
      events: {
        [Symbol.asyncIterator]: () => ({
          next: () => events.next(),
          return: async () => {
            if (!active.done) controller.abort();
            cleanup();
            return events.return(undefined);
          },
        }),
      },
    };
  }

  async input(): Promise<Contract.InputResult> {
    return { status: 'unsupported' };
  }
  async cancelTurn(sessionId: string, expected: Contract.TurnRef): Promise<Contract.CancelResult> {
    const active = this.sessions.get(sessionId)?.active;
    if (!active || active.ref.invocationId !== expected.invocationId) return { ok: false, code: 'turn_ended' };
    active.controller.abort();
    return { ok: true };
  }
  async release(sessionId: string): Promise<{ ok: true } | { ok: false; code: 'failed'; reason: string }> {
    const session = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    session?.active?.controller.abort();
    try {
      if (session?.nativeId) await this.deps.service.releaseSession?.(session.nativeId);
      return { ok: true };
    } catch (error) {
      return { ok: false, code: 'failed', reason: error instanceof Error ? error.message : String(error) };
    }
  }
  private project(
    message: AgentMessage,
    sessionId: string,
    session: Session,
    turn: Contract.TurnRef,
  ): Contract.AgentSessionEvent | undefined {
    const base = { sessionId, seq: 0, scope: 'turn' as const, turn };
    switch (message.type) {
      case 'session_init':
        if (!message.sessionId) return undefined;
        session.nativeId = message.sessionId;
        return {
          scope: 'session',
          sessionId,
          seq: 0,
          type: 'native_bound',
          nativeSessionId: message.sessionId,
          nativeSessionBinding: message.nativeSessionBinding,
          ephemeralSession: message.ephemeralSession,
        };
      case 'text':
        return { ...base, type: 'output', text: message.content ?? '', textMode: message.textMode ?? 'append' };
      case 'tool_use':
        return {
          ...base,
          type: 'tool_call',
          name: message.toolName,
          callId: message.toolUseId,
          input: message.toolInput,
          source: message.toolSource,
          rawPayload: message.toolRawPayload,
        };
      case 'tool_result':
        return {
          ...base,
          type: 'tool_result',
          name: message.toolName,
          callId: message.toolUseId,
          status: message.toolResultStatus ?? 'unknown',
          output: message.content,
          input: message.toolInput,
          source: message.toolSource,
          rawPayload: message.toolRawPayload,
        };
      case 'error':
        return {
          ...base,
          type: 'error',
          code: message.errorCode ?? 'provider_error',
          message: message.error ?? '',
          disposition: message.errorDisposition ?? 'terminal',
        };
      case 'done':
        return {
          ...base,
          type: 'done',
          errorCode: message.errorCode,
          outcome: session.active?.controller.signal.aborted ? 'cancelled' : message.errorCode ? 'failed' : 'completed',
        };
      case 'system_info':
      case 'provider_signal':
      case 'liveness_signal':
      case 'agent_loop':
        return { ...base, type: message.type, content: message.content };
      case 'status':
        return { ...base, type: 'status', detail: message.content };
      case 'a2a_handoff':
        return {
          ...base,
          type: 'handoff',
          content: message.content,
          targetCatId: message.targetCatId,
          routing: message.routing,
        };
      default:
        message.type satisfies never;
        throw new Error('Unsupported ACP message type');
    }
  }
  private async *events(
    sessionId: string,
    session: Session,
    source: AsyncIterable<AgentMessage>,
    active: ActiveTurn,
    cleanup: () => void,
  ): AsyncGenerator<Contract.AgentSessionEvent> {
    let metadata: Pick<MessageMetadata, 'model'> | undefined;
    let seq = 0;
    let wake = () => {};
    const aborted = new Promise<undefined>((resolve) => {
      wake = () => resolve(undefined);
    });
    active.controller.signal.addEventListener('abort', wake, { once: true });
    let iterator: AsyncIterator<AgentMessage> | undefined;
    try {
      iterator = source[Symbol.asyncIterator]();
      while (!active.controller.signal.aborted) {
        const next = await Promise.race([iterator.next(), aborted]);
        if (!next || next.done || active.controller.signal.aborted) break;
        const current = next.value.metadata;
        if (current && !isDeepStrictEqual(metadata, { model: current.model })) {
          metadata = structuredClone({ model: current.model });
          yield { scope: 'session', sessionId, seq: ++seq, type: 'context', ...metadata };
        }
        const event = this.project(next.value, sessionId, session, active.ref);
        if (event) {
          active.done = event.type === 'done';
          yield { ...event, messageUsage: structuredClone(current?.usage), seq: ++seq };
          if (event.type === 'done') return;
        }
      }
      active.done = true;
      yield {
        scope: 'turn',
        sessionId,
        turn: active.ref,
        seq: ++seq,
        type: 'done',
        outcome: active.controller.signal.aborted ? 'cancelled' : 'completed',
      };
    } finally {
      cleanup();
      active.controller.signal.removeEventListener('abort', wake);
      active.done = true;
      void iterator?.return?.().catch(() => {});
    }
  }
}

export { createRefreshingAcpSessionProvider } from './refreshing-acp-session-provider.js';
