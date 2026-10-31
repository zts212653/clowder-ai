import type { StoredMessage } from '../../../../cats/services/stores/ports/MessageStore.js';
import { LiveCarrierUnavailableError } from '../../LiveCarrierOperationGate.js';
import type { LiveContextGate, LiveContextScope } from '../live-controlled-context.js';

import {
  isLatestOwnerMessage,
  isOwnerVoiceSource,
  type OwnerVoiceMessageStore,
  type OwnerVoiceNotice,
} from './live-owner-voice-source.js';
import {
  type OwnerVoicePayload,
  ownerVoicePayloadIsCurrent,
  readOwnerVoicePayload,
} from './live-owner-voice-utterance.js';

/** Synchronize already-saved owner speech with active deep work, without starting another task. */
export class LiveOwnerVoiceContext {
  private epoch = 0;
  private readonly committedItems = new Set<string>();
  private pending?: OwnerVoiceNotice;
  private controller = new AbortController();
  private running = false;
  private closed = false;
  private nativeTurnId?: string;
  private utterance?: OwnerVoiceNotice['utterance'];
  private discardingUtterance = false;

  constructor(
    private readonly context: LiveContextGate,
    private readonly messages: OwnerVoiceMessageStore,
    private readonly scope: () => LiveContextScope | null,
    private readonly exposed: (message: StoredMessage) => boolean,
    private readonly canDeliver: () => boolean,
    private readonly wake: () => void,
  ) {}

  currentEpoch(): number {
    return this.epoch;
  }

  currentSignal(): AbortSignal {
    return this.controller.signal;
  }

  availableForAction(): boolean {
    return !this.closed && this.canDeliver();
  }

  /** Reuse the complete committed utterance, including any earlier negation segment. */
  async inspectUtterance(scope: LiveContextScope, message: StoredMessage): Promise<OwnerVoicePayload | null> {
    const epoch = this.epoch;
    if (this.closed || !this.canDeliver() || !this.nativeTurnId || !this.valid(message, scope)) return null;
    const notice: OwnerVoiceNotice = {
      message,
      scope,
      epoch,
      nativeTurnId: this.nativeTurnId,
      utterance: this.utterance,
    };
    const payload = await readOwnerVoicePayload(this.messages, notice, this.exposed);
    if (!payload || !(await ownerVoicePayloadIsCurrent(this.messages, notice, payload, this.exposed))) return null;
    return !this.closed && this.canDeliver() && epoch === this.epoch ? payload : null;
  }

  observeTurn(method: unknown, id: unknown): void {
    if (typeof id !== 'string' || !id) return;
    if (method === 'turn/started' && this.nativeTurnId !== id) {
      this.interrupt();
      this.nativeTurnId = id;
    } else if (method === 'turn/completed' && this.nativeTurnId === id) {
      this.interrupt();
      this.nativeTurnId = undefined;
    }
  }

  committed(itemId: string): void {
    if (this.committedItems.has(itemId)) return;
    this.committedItems.add(itemId);
    this.invalidatePending();
    if (this.utterance && this.utterance.itemIds.length <= 32) this.utterance.itemIds.push(itemId);
  }

  interrupt(): void {
    if (this.utterance && this.utterance.text === undefined) this.discardingUtterance = true;
    this.utterance = undefined;
    this.invalidatePending();
  }

  beginSpeech(): void {
    this.interrupt();
    this.discardingUtterance = false;
    this.utterance = { itemIds: [], messageIds: new Map() };
  }

  finishSpeech(text: unknown): void {
    if (this.utterance && this.utterance.text === undefined && typeof text === 'string') this.utterance.text = text;
  }

  private invalidatePending(): void {
    this.epoch++;
    this.pending = undefined;
    this.controller.abort('new_owner_speech');
    this.controller = new AbortController();
  }

  queue(message: StoredMessage, epoch: number): void {
    const scope = this.scope();
    const nativeTurnId = this.nativeTurnId;
    if (!this.closed && !this.discardingUtterance && scope && this.valid(message, scope)) {
      const metadata = message.extra?.liveCompanion;
      if (this.utterance && metadata?.modality === 'voice' && this.utterance.itemIds.includes(metadata.nativeItemId)) {
        this.utterance.messageIds.set(metadata.nativeItemId, message.id);
        // An earlier segment's persistence may finish after the suffix. It fills
        // this utterance only; it cannot replace the current notice or epoch.
        this.signal();
      }
    }
    if (
      this.closed ||
      this.discardingUtterance ||
      !nativeTurnId ||
      epoch !== this.epoch ||
      !scope ||
      !this.valid(message, scope)
    )
      return;
    this.pending = { message: { ...message }, scope, epoch, nativeTurnId, utterance: this.utterance };
    this.signal();
  }

  hasPendingWake(): boolean {
    return (
      !this.closed &&
      Boolean(this.pending) &&
      this.pending?.nativeTurnId === this.nativeTurnId &&
      (!this.pending?.utterance ||
        this.pending.utterance.itemIds.every((id) => this.pending?.utterance?.messageIds.has(id))) &&
      this.canDeliver()
    );
  }

  signal(): void {
    if (this.hasPendingWake()) this.wake();
  }

  async atBoundary(): Promise<'accepted' | 'busy' | 'cancelled' | 'idle'> {
    if (!this.hasPendingWake()) return 'idle';
    if (this.running) return 'busy';
    const notice = this.pending;
    if (!notice) return 'idle';
    const controller = this.controller;
    let payload: OwnerVoicePayload | null = null;
    const authorizeSource = () => this.authorizePayload(notice, payload);
    this.running = true;
    try {
      payload = await readOwnerVoicePayload(this.messages, notice, this.exposed);
      if (!payload || !(await authorizeSource())) {
        this.clearPending(notice);
        return 'cancelled';
      }
      await this.context.inject({
        scope: notice.scope,
        kind: 'owner_voice_context',
        text: payload.text,
        sourceRefs: payload.messages.map((message) => `${notice.scope.threadId}#${message.id}`),
        signal: controller.signal,
        authorizeSource,
      });
      if (controller.signal.aborted) return 'cancelled';
      this.clearPending(notice);
      return 'accepted';
    } catch (error) {
      if (controller.signal.aborted || !(await authorizeSource())) {
        this.clearPending(notice);
        return 'cancelled';
      }
      if (error instanceof LiveCarrierUnavailableError) return 'busy';
      throw error;
    } finally {
      this.running = false;
    }
  }

  close(): void {
    this.closed = true;
    this.committedItems.clear();
    this.interrupt();
  }

  private clearPending(notice: OwnerVoiceNotice): void {
    if (this.pending === notice) this.pending = undefined;
  }

  private async authorizeNotice(notice: OwnerVoiceNotice, payload: OwnerVoicePayload): Promise<boolean> {
    const current = await this.messages.getById(notice.message.id);
    if (
      !current ||
      !(await isLatestOwnerMessage(
        this.messages,
        notice.scope,
        current,
        payload.messages.map((message) => message.id),
      ))
    )
      return false;
    return Boolean(
      !this.closed &&
        this.pending === notice &&
        notice.epoch === this.epoch &&
        notice.nativeTurnId === this.nativeTurnId &&
        this.canDeliver() &&
        current.content === notice.message.content &&
        this.valid(current, notice.scope),
    );
  }

  private async authorizePayload(notice: OwnerVoiceNotice, payload: OwnerVoicePayload | null): Promise<boolean> {
    return Boolean(
      payload &&
        (await ownerVoicePayloadIsCurrent(this.messages, notice, payload, this.exposed)) &&
        (await this.authorizeNotice(notice, payload)),
    );
  }

  private valid(message: StoredMessage, scope: LiveContextScope): boolean {
    return isOwnerVoiceSource(message, scope, this.exposed);
  }
}
