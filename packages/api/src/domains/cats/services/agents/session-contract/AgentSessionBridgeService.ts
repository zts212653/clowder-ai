import { randomUUID } from 'node:crypto';
import type { CatId } from '@cat-cafe/shared';
import type * as Service from '../../types.js';
import type { AgentMessage, AgentServiceOptions as InvokeOptions, MessageMetadata } from '../../types.js';
import { projectSessionEvent } from './event-projection.js';
import type * as Contract from './types.js';

export interface BridgeHostSession {
  sessionId: string;
  resumeNativeSessionId?: string;
}
interface BridgeInput {
  catId: CatId;
  provider: Contract.AgentSessionProvider;
  resolveHostSession(options: InvokeOptions | undefined): BridgeHostSession;
  resolveMcpServers?(options: InvokeOptions | undefined): Contract.McpServerDescriptor[];
  onCompactionObserved?(
    observation: Service.ProviderCompactionObservation,
    ctx: { sessionId: string },
  ): void | Promise<void>;
  passHostOptions?: boolean;
  metadata?: { provider: string; model: string };
  log?: { info(...a: unknown[]): void; warn(...a: unknown[]): void };
}
interface LiveTurn {
  sessionId: string;
  turn: Contract.TurnRef;
  accepting: boolean;
  receipts: Map<string, () => Promise<void>>;
  release?: () => void;
}
class SessionFailure extends Error {
  constructor(
    readonly code: string,
    reason?: string,
  ) {
    super(reason ?? code);
  }
}
function dispatchResult(
  result: Contract.InputResult,
  handle: Service.AgentClientActiveRunHandle,
): Service.AgentClientDispatchResult {
  if (result.status === 'accepted') return { accepted: true, handle };
  const reasons = { unknown: 'exception', turn_ended: 'active_run_closed', unsupported: 'provider_rejected' } as const;
  return {
    accepted: false,
    reason: result.status === 'rejected' ? result.reason : reasons[result.status],
    acceptance: result.status === 'unknown' ? 'unknown' : 'not_accepted',
  };
}

/** Internal / unstable. No provider-specific policy or Host invocation machinery crosses this boundary. */
export class AgentSessionBridgeService implements Service.AgentService {
  private readonly sessions = new Map<string, Promise<Contract.OpenSessionResult>>();
  private readonly active = new Set<string>();
  constructor(private readonly input: BridgeInput) {}
  invoke(prompt: string, options?: InvokeOptions): AsyncIterable<AgentMessage> {
    return this.run({ kind: 'frozen', text: prompt }, options);
  }
  invokeWithContinuityPreflight(
    preflight: Service.ProviderContinuityPreflight,
    options?: InvokeOptions,
  ): AsyncIterable<AgentMessage> {
    return this.run({ kind: 'deferred', settle: (facts) => preflight.settle(facts) }, options);
  }
  async releaseAll(reason: string): Promise<void> {
    const sessions = [...this.sessions];
    this.sessions.clear();
    await Promise.all(
      sessions.map(async ([id, opened]) => {
        try {
          if (!(await opened).ok) return;
          const result = await this.input.provider.release(id, reason);
          if (!result.ok) this.input.log?.warn('Session release failed', result.reason);
        } catch {
          this.input.log?.warn('Session release failed');
        }
      }),
    );
  }
  private open(
    host: BridgeHostSession,
    options: InvokeOptions,
    signal: AbortSignal,
  ): Promise<Contract.OpenSessionResult> {
    const cached = this.sessions.get(host.sessionId);
    if (cached) return cached;
    const opened = Promise.resolve().then(() =>
      this.input.provider.openSession(
        {
          sessionId: host.sessionId,
          instructions: options.systemPrompt ?? '',
          cwd: options.workingDirectory ?? process.cwd(),
          ...(host.resumeNativeSessionId
            ? { resume: { nativeSessionId: host.resumeNativeSessionId, onUnavailable: 'start_new' as const } }
            : {}),
        },
        signal,
      ),
    );
    this.sessions.set(host.sessionId, opened);
    const forget = () => {
      if (this.sessions.get(host.sessionId) === opened) this.sessions.delete(host.sessionId);
    };
    void opened.then((result) => {
      if (!result.ok) forget();
    }, forget);
    return opened;
  }
  private register(live: LiveTurn, metadata: MessageMetadata, options: InvokeOptions): void {
    const { provider } = this.input;
    const registration = options.activeRunDispatch;
    const capabilities = provider.capabilities(live.sessionId);
    if (!registration || capabilities.input !== 'supported') return;
    const expected = { ...live.turn, invocationId: registration.invocationId };
    const handle: Service.AgentClientActiveRunHandle = {
      provider: 'other',
      carrier: 'other',
      threadId: metadata.sessionId ?? live.sessionId,
      turnId: live.turn.nativeTurnId ?? expected.invocationId,
    };
    const dispatcher: Service.AgentClientActiveRunDispatcher = {
      invocationId: registration.invocationId,
      handle,
      capabilities: { append: true, steer: false, inputReadReceipt: capabilities.inputReadReceipt === 'supported' },
      dispatch: async (input, options) => {
        if (!live.accepting) return { accepted: false, reason: 'active_run_closed', acceptance: 'not_accepted' };
        if (options.expectedInvocationId !== expected.invocationId)
          return { accepted: false, reason: 'active_run_mismatch', acceptance: 'not_accepted' };
        if (options.force) return { accepted: false, reason: 'provider_rejected', acceptance: 'not_accepted' };
        const deliveryId = input.deliveryId ?? randomUUID();
        if (input.onInputRead) live.receipts.set(deliveryId, input.onInputRead);
        try {
          const result = await provider.input(live.sessionId, expected, {
            text: input.text,
            images: input.imagePaths,
            messageIds: input.messageIds,
            deliveryId,
          });
          if (result.status !== 'accepted' && result.status !== 'unknown') live.receipts.delete(deliveryId);
          return dispatchResult(result, handle);
        } catch {
          return dispatchResult({ status: 'unknown' }, handle);
        }
      },
    };
    const inspect = provider.inspectInput;
    if (inspect)
      dispatcher.inspectInput = (deliveryId) =>
        live.accepting ? inspect.call(provider, live.sessionId, expected, deliveryId) : Promise.resolve('unknown');
    live.release = registration.register(dispatcher);
  }
  private close(live: LiveTurn): void {
    live.accepting = false;
    const release = live.release;
    live.release = undefined;
    live.receipts.clear();
    release?.();
  }
  private async observe(event: Contract.AgentSessionEvent, live: LiveTurn): Promise<void> {
    if (event.type === 'input_read') {
      const receipt = live.receipts.get(event.deliveryId);
      live.receipts.delete(event.deliveryId);
      void Promise.resolve()
        .then(receipt)
        .catch(() => this.input.log?.warn('Input receipt failed'));
    }
    if (event.type === 'continuity') this.input.log?.info('Session continuity', event.evidence);
    if (event.type === 'compaction_observed') {
      try {
        await this.input.onCompactionObserved?.(event.observation, { sessionId: live.sessionId });
      } catch {
        this.input.log?.warn('Compaction observation callback failed');
      }
    }
  }
  private async *consume(
    events: AsyncIterable<Contract.AgentSessionEvent>,
    live: LiveTurn,
    metadata: MessageMetadata,
    signal: AbortSignal,
    session: Extract<Contract.OpenSessionResult, { ok: true }>,
  ): AsyncIterable<AgentMessage> {
    let wake = () => {};
    const aborted = new Promise<undefined>((resolve) => {
      wake = () => resolve(undefined);
    });
    const cancel = () => {
      this.close(live);
      wake();
      void this.input.provider
        .cancelTurn(live.sessionId, live.turn, 'abort')
        .catch(() => this.input.log?.warn('Session turn cancellation failed'));
    };
    const iterator = events[Symbol.asyncIterator]();
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    try {
      while (!signal.aborted) {
        const next = await Promise.race([iterator.next(), aborted]);
        if (!next || next.done || signal.aborted) return;
        await this.observe(next.value, live);
        if (signal.aborted) return;
        if (next.value.type === 'native_bound')
          session.binding = { state: 'bound', nativeSessionId: next.value.nativeSessionId };
        for (const message of projectSessionEvent(next.value, { catId: this.input.catId, metadata })) yield message;
        if (next.value.type === 'done') return;
      }
    } finally {
      signal.removeEventListener('abort', cancel);
      void iterator.return?.().catch(() => {});
    }
  }
  private message(type: AgentMessage['type'], metadata: MessageMetadata, extra: Partial<AgentMessage>): AgentMessage {
    return { type, catId: this.input.catId, metadata: { ...metadata }, timestamp: Date.now(), ...extra };
  }
  private async prepare(
    options: InvokeOptions | undefined,
    signal: AbortSignal,
    prompt: Contract.PromptSource,
    metadata: MessageMetadata,
  ) {
    if (!options) throw new SessionFailure('host_session_unavailable');
    if (!options.invocationId) throw new SessionFailure('invocation_id_missing');
    const host = this.input.resolveHostSession(options);
    const session = await this.open(host, options, signal);
    if (!session.ok) throw new SessionFailure(session.code, session.reason);
    const invocation = {
      invocationId: options.invocationId,
      callbackEnv: options.callbackEnv ?? {},
      mcpServers: this.input.resolveMcpServers?.(options) ?? [],
      ...(options.toolExecutionPolicy ? { toolExecutionPolicy: options.toolExecutionPolicy } : {}),
      ...(options.requiredTools ? { requiredTools: options.requiredTools } : {}),
    };
    if (this.active.has(host.sessionId)) throw new SessionFailure('session_busy');
    if (session.binding.state === 'bound') metadata.sessionId = session.binding.nativeSessionId;
    if (
      prompt.kind === 'deferred' &&
      this.input.provider.capabilities(host.sessionId).continuityEvidence !== 'pre_send'
    )
      throw new SessionFailure('continuity_preflight_unsupported');
    if (signal.aborted) throw new SessionFailure('cancelled');
    this.active.add(host.sessionId);
    const live: LiveTurn = {
      sessionId: host.sessionId,
      turn: { invocationId: invocation.invocationId },
      accepting: true,
      receipts: new Map(),
    };
    return { host, session, invocation, live };
  }
  private failure(error: unknown): SessionFailure {
    if (error instanceof SessionFailure) return error;
    return new SessionFailure('session_contract_failed', error instanceof Error ? error.message : String(error));
  }
  private async *run(prompt: Contract.PromptSource, options?: InvokeOptions): AsyncIterable<AgentMessage> {
    const metadata: MessageMetadata = {
      ...(this.input.metadata ?? { provider: 'session-contract', model: 'unknown' }),
    };
    const signal = options?.signal ?? new AbortController().signal;
    let live: LiveTurn | undefined;
    let terminal: AgentMessage | undefined;
    try {
      const prepared = await this.prepare(options, signal, prompt, metadata);
      live = prepared.live;
      const { host, session, invocation } = prepared;
      const started = await this.input.provider.startTurn(
        host.sessionId,
        { invocation, prompt, ...(this.input.passHostOptions ? { hostOptions: options } : {}) },
        signal,
      );
      if (!started.ok) throw new SessionFailure(started.code, started.reason);
      live.turn = started.turn;
      if (!signal.aborted) this.register(live, metadata, options ?? {});
      for await (const message of this.consume(started.events, live, metadata, signal, session)) {
        if (message.type === 'done') {
          terminal = message;
          break;
        }
        yield message;
      }
    } catch (error) {
      const failure = this.failure(error);
      terminal = this.message('done', metadata, { errorCode: failure.code });
      if (!signal.aborted) yield this.message('error', metadata, { errorCode: failure.code, error: failure.message });
    } finally {
      if (live) {
        this.active.delete(live.sessionId);
        this.close(live);
      }
    }
    // A synthetic terminal uses the final session context; a provider terminal keeps its own usage fact.
    terminal ??= this.message('done', metadata, { errorCode: 'provider_stream_ended_without_done' });
    if (signal.aborted) terminal.errorCode = 'cancelled';
    yield terminal;
  }
}
