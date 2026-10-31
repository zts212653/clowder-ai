import { randomUUID } from 'node:crypto';
import type { CodexAppServerJsonObject } from '../../../cats/services/agents/providers/CodexAppServerEventMapper.js';
import type { CodexLiveNativeClient } from '../../../cats/services/agents/providers/CodexLiveRunPort.js';
import type { LiveReturnProjection } from '../../../cats/services/stores/ports/MessageStore.js';
import { record } from '../live-call-async.js';

interface QualifiedInput {
  epoch: number;
  owner: boolean;
  notice: boolean;
  sourceRefs: readonly string[];
  signal?: AbortSignal;
}

/** Presentation eligibility only. Native work and its durable history are never cancelled or rewritten. */
export class LiveResultReturn {
  private epoch = 0;
  private consumedEpoch = 0;
  private speaking = false;
  private closed = false;
  private readonly inputs = new Map<string, QualifiedInput>();
  private readonly samples = new Map<string, QualifiedInput>();
  private consumed?: QualifiedInput;
  private readonly seenSamples = new Set<string>();
  private readonly seenInputs = new Set<string>();
  private readonly seenVoice = new Set<string>();
  private pendingOpening?: CodexAppServerJsonObject;
  constructor(
    private readonly deps: {
      client(): CodexLiveNativeClient | undefined;
      threadId(): string | undefined;
      realtimeSessionId(): string | undefined;
      available(): boolean;
      verifyCompanion(): Promise<boolean>;
      handed(turnId: string, itemId: string): void;
      acceptedInput?(turnId: string, refs: readonly string[]): void;
      defer?(turnId: string, itemId: string, sourceRefs: readonly string[]): void | Promise<void>;
    },
  ) {}

  ownerChanged(): void {
    ++this.epoch;
    this.pendingOpening = undefined;
  }
  currentEpoch(): number {
    return this.epoch;
  }
  ownerSpeaking(): boolean {
    return this.speaking;
  }

  bind(client: CodexLiveNativeClient): CodexLiveNativeClient {
    const submitContext = client.submitContextAtBoundary?.bind(client);
    const wake = client.wakeBoundary?.bind(client);
    return {
      request: (method, params) => client.request(method, params),
      submitText: (text, sourceMessageId) => {
        this.register(sourceMessageId, true, [sourceMessageId]);
        return client.submitText(text, sourceMessageId).then((turnId) => {
          this.deps.acceptedInput?.(turnId, [sourceMessageId]);
          return turnId;
        });
      },
      ...(submitContext
        ? {
            submitContextAtBoundary: (text, refs, kind, signal, authorize) => {
              const clientId = randomUUID();
              this.register(clientId, kind === 'owner_voice_context', refs, signal, kind === 'late_result_notice');
              return submitContext(text, refs, kind, signal, authorize, clientId).then((turnId) => {
                this.deps.acceptedInput?.(turnId, refs);
                return turnId;
              });
            },
          }
        : {}),
      ...(wake ? { wakeBoundary: wake } : {}),
    };
  }

  private register(
    id: string,
    owner: boolean,
    sourceRefs: readonly string[],
    signal?: AbortSignal,
    notice = false,
  ): void {
    if (this.seenInputs.has(id)) return;
    for (const [key, input] of this.inputs) if (input.signal?.aborted) this.inputs.delete(key);
    // Keep started samples and input tombstones; only retire old pending qualifications when bounded storage fills.
    for (const [key, input] of this.inputs) {
      if (this.inputs.size < 256) break;
      if (input.epoch !== this.epoch) this.inputs.delete(key);
    }
    if (this.closed || signal?.aborted || this.inputs.size >= 256 || this.seenInputs.size >= 4096)
      throw new Error('Live input qualification unavailable');
    const input = { epoch: this.epoch, owner, notice, sourceRefs: [...sourceRefs], signal };
    this.seenInputs.add(id);
    this.inputs.set(id, input);
  }

  observe(message: CodexAppServerJsonObject, activeTurnId: string | undefined): void {
    if (this.closed) return;
    const params = record(message.params);
    const item = record(params.item);
    this.observeVoice(message, params, item);
    if (!activeTurnId || params.turnId !== activeTurnId) return;
    if (message.method === 'item/completed' && item.type === 'userMessage' && typeof item.clientId === 'string') {
      this.consume(item.clientId);
    }
    if (
      message.method === 'item/started' &&
      item.type === 'agentMessage' &&
      item.phase === 'final_answer' &&
      typeof item.id === 'string'
    ) {
      if (this.seenSamples.has(item.id) || this.seenSamples.size >= 4096) return;
      this.seenSamples.add(item.id);
      if (this.samples.size < 64)
        this.samples.set(
          item.id,
          this.consumed ?? {
            epoch: this.consumedEpoch,
            owner: false,
            notice: false,
            sourceRefs: [],
          },
        );
    }
  }

  private consume(clientId: string): void {
    const input = this.inputs.get(clientId);
    this.inputs.delete(clientId);
    if (input) {
      this.consumedEpoch = input.epoch;
      this.consumed = input;
    } else if (!this.seenInputs.has(clientId)) {
      // Unknown provider input has no owner association. Keep the last known
      // epoch as a conservative fence, without borrowing its request references.
      this.consumed = undefined;
    }
    // A consumed or retired input replay is a tombstone, not a new qualification.
  }

  private observeVoice(
    message: CodexAppServerJsonObject,
    params: Record<string, unknown>,
    item: Record<string, unknown>,
  ): void {
    const session = this.deps.realtimeSessionId();
    if (
      message.method === 'thread/realtime/transcript/delta' &&
      params.role === 'user' &&
      typeof params.delta === 'string' &&
      params.delta.length > 0 &&
      (!params.realtimeSessionId || params.realtimeSessionId === session) &&
      !this.speaking
    ) {
      this.speaking = true;
      this.ownerChanged();
    }
    if (
      message.method === 'thread/realtime/transcript/done' &&
      params.role === 'user' &&
      (!params.realtimeSessionId || params.realtimeSessionId === session)
    )
      this.speaking = false;
    // Some providers commit a segment without an earlier delta; that still retires the previous presentation.
    if (
      message.method === 'thread/realtime/item/completed' &&
      item.type === 'transcriptSegment' &&
      item.role === 'user' &&
      item.realtimeSessionId === session &&
      typeof item.id === 'string' &&
      !this.seenVoice.has(item.id)
    ) {
      if (this.seenVoice.size < 4096) this.seenVoice.add(item.id);
      if (!this.speaking) this.ownerChanged();
      this.speaking = false;
    }
  }

  takePendingOpening(): CodexAppServerJsonObject | undefined {
    const opening = this.pendingOpening;
    this.pendingOpening = undefined;
    return !this.closed && this.epoch === 0 ? opening : undefined;
  }

  async flushOpening(persist: (message: CodexAppServerJsonObject, turnId: string) => Promise<void>): Promise<void> {
    const opening = this.takePendingOpening();
    const turnId = record(opening?.params).turnId;
    if (!opening || typeof turnId !== 'string') return;
    await persist(opening, turnId);
    await this.present(opening, turnId);
  }

  async present(message: CodexAppServerJsonObject, activeTurnId: string | undefined): Promise<void> {
    const params = record(message.params);
    const item = record(params.item);
    if (
      message.method !== 'item/completed' ||
      params.turnId !== activeTurnId ||
      item.type !== 'agentMessage' ||
      item.phase !== 'final_answer' ||
      typeof item.id !== 'string'
    )
      return;
    const sample = this.samples.get(item.id);
    const epoch = sample?.epoch;
    if (!sample || sample.signal?.aborted || epoch === undefined || typeof item.text !== 'string' || !item.text.trim())
      return;
    if (!this.closed && epoch === 0 && this.epoch === 0 && !this.deps.available()) {
      this.pendingOpening ??= message;
      return;
    }
    this.samples.delete(item.id);
    if (!this.closed && epoch > 0 && epoch !== this.epoch && sample.owner && !sample.notice && activeTurnId) {
      await this.deps.defer?.(activeTurnId, item.id, sample.sourceRefs);
      return;
    }
    const available = () => !this.closed && this.deps.available() && epoch === this.epoch;
    if (!available() || !(await this.deps.verifyCompanion()) || !available()) return;
    const client = this.deps.client();
    const threadId = this.deps.threadId();
    if (!client || !threadId || !activeTurnId) return;
    // No await between the final current-source check and the actual native write.
    const conclusion = item.text
      .trim()
      .split(/\n\s*\n/)
      .find((part) => !/^#{1,6}\s+[^\n]+$/.test(part.trim()))
      ?.trim();
    if (!conclusion) return;
    await client.request('thread/realtime/appendSpeech', { threadId, text: conclusion });
    this.deps.handed(activeTurnId, item.id);
  }

  projection(message: CodexAppServerJsonObject, activeTurnId: string | undefined): LiveReturnProjection | undefined {
    const params = record(message.params);
    const item = record(params.item);
    if (this.closed || params.turnId !== activeTurnId || typeof item.id !== 'string') return;
    const sample = this.samples.get(item.id);
    if (
      !sample ||
      sample.signal?.aborted ||
      (!sample.owner && !sample.notice) ||
      (sample.epoch === 0 && !sample.notice) ||
      !sample.sourceRefs.length
    )
      return;
    return {
      presentationEligibility: sample.epoch === this.epoch ? 'current' : 'deferred',
      requestRefs: [...sample.sourceRefs],
      ...(sample.notice
        ? { reminderForMessageIds: sample.sourceRefs.slice(0, 1).map((ref) => ref.split('#').at(-1) ?? ref) }
        : {}),
    };
  }

  close(): void {
    this.closed = true;
    this.inputs.clear();
    this.samples.clear();
    this.seenSamples.clear();
    this.seenInputs.clear();
    this.seenVoice.clear();
    this.pendingOpening = undefined;
    this.consumed = undefined;
  }
}
