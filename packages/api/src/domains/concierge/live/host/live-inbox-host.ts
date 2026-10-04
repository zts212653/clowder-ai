import type { CodexAppServerJsonObject } from '../../../cats/services/agents/providers/CodexAppServerEventMapper.js';
import type { StoredMessage } from '../../../cats/services/stores/ports/MessageStore.js';
import { LiveInbox } from '../inbox/LiveInbox.js';
import type {
  LiveInboxBatch,
  LiveInboxReference,
  LiveInboxResult,
  LiveInboxScope,
  LiveInboxSource,
} from '../inbox/live-inbox-contract.js';
import { LiveCarrierUnavailableError } from '../LiveCarrierOperationGate.js';
import type { LiveCompanionCallOptions } from '../live-call-options.js';
import type { LiveContextGate } from './live-controlled-context.js';

interface LiveInboxHostOptions {
  scope: LiveInboxScope;
  source: LiveInboxSource;
  wakeNative(): void;
  deliver(batch: LiveInboxBatch): Promise<'accepted' | 'busy'>;
  onSuccessorRequired(references: readonly LiveInboxReference[]): Promise<void>;
}

/** The Host owns when C0 may run; C0 owns source selection and retry state. */
export class LiveInboxHost {
  private readonly inbox: LiveInbox;
  private wakePending = false;
  private userSpeaking = false;
  private closed = false;

  constructor(private readonly options: LiveInboxHostOptions) {
    this.inbox = new LiveInbox({
      scope: options.scope,
      source: options.source,
      wake: () => {
        this.wakePending = true;
        options.wakeNative();
      },
      deliver: options.deliver,
    });
    this.inbox.signal();
  }

  hasPendingWake(): boolean {
    return !this.closed && this.wakePending;
  }

  signal(): void {
    if (this.closed) return;
    this.inbox.signal();
    // A suppressed boundary can leave C0's internal wake pending while Host consumed its own.
    if (!this.wakePending) {
      this.wakePending = true;
      this.options.wakeNative();
    }
  }

  observe(message: CodexAppServerJsonObject): void {
    if (this.closed) return;
    const params = message.params as Record<string, unknown> | undefined;
    const delta = params?.delta;
    if (
      message.method === 'thread/realtime/transcript/delta' &&
      params?.role === 'user' &&
      typeof delta === 'string' &&
      delta.length > 0 &&
      delta.length <= 32_000 &&
      !this.userSpeaking
    ) {
      this.userSpeaking = true;
      this.inbox.cancel('user_speaking');
    }
    if (message.method === 'thread/realtime/transcript/done' && params?.role === 'user') {
      this.userSpeaking = false;
      this.signal();
    }
  }

  async atBoundary(kind: 'idle' | 'tool_complete' | 'turn_complete'): Promise<LiveInboxResult['kind']> {
    if (!this.hasPendingWake()) return 'idle';
    this.wakePending = false;
    try {
      const result = await this.inbox.atBoundary({
        kind,
        generation: this.options.scope.generation,
        userSpeaking: this.userSpeaking,
      });
      if (result.kind === 'successor_required') await this.options.onSuccessorRequired(result.successorSources);
      if (result.kind === 'busy') this.wakePending = true;
      else if (this.wakePending && !this.userSpeaking) this.options.wakeNative();
      return result.kind;
    } catch (error) {
      this.wakePending = true;
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.inbox.close();
  }
}

export function bindLiveInboxHost(input: {
  options: LiveCompanionCallOptions;
  context: LiveContextGate;
  callbackEnv: Record<string, string>;
  wakeNative(): void;
  isSameCallExposure(message: StoredMessage): boolean;
}): LiveInboxHost | undefined {
  const { inbox } = input.options;
  if (!inbox) return undefined;
  const scope = input.context.boundScope({
    invocationId: input.callbackEnv.CAT_CAFE_INVOCATION_ID,
    catId: input.options.binding.catId,
    threadId: input.options.binding.threadId,
  });
  if (!scope) throw new LiveCarrierUnavailableError();
  return new LiveInboxHost({
    scope,
    source: inbox.source(scope, (candidate) => input.context.canRead(candidate), input.isSameCallExposure),
    wakeNative: input.wakeNative,
    deliver: async (batch) => {
      try {
        await input.context.inject({
          scope: batch.scope,
          kind: 'inbox_notice',
          text: batch.notice,
          sourceRefs: batch.references.map((ref) => `${ref.threadId}#${ref.messageId}`),
          signal: batch.signal,
        });
        return 'accepted';
      } catch (error) {
        if (error instanceof LiveCarrierUnavailableError) return 'busy';
        throw error;
      }
    },
    onSuccessorRequired: (references) => inbox.onSuccessorRequired(scope, references),
  });
}
