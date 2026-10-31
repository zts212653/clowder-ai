import type { IMessageStore, StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';
import { canViewMessage } from '../../cats/services/stores/visibility.js';
import type { HostVoiceObservation } from '../../plugin/desktop-window-runtime/companion-private-wire.js';

/** B's published reference-only receipt; archive admission remains Host-owned. */
export interface LivePresentationObservation {
  kind: 'presentation.observe';
  event: 'first_text_visible';
  observedAt: number;
  callId: string;
  reference: { kind: 'message'; messageId: string } | { kind: 'native-item'; nativeItemId: string };
}
export type LivePresentationReply = { kind: 'ok' } | { kind: 'error'; code: 'invalid_request' | 'unavailable' };

/** Reference authentication only: no renderer can nominate a session, generation, body or credentials. */
export class LivePresentationObservations {
  private readonly nativeItems = new Map<string, { sessionId: string; observedAt: number }>();
  private readonly visible = new Set<string>();
  private closed = false;
  constructor(
    private readonly deps: {
      scope: { userId: string; threadId: string; catId: string; callId: string };
      session(): string | undefined;
      available(): boolean;
      verify(): Promise<boolean>;
      store: Pick<IMessageStore, 'getById'>;
      observed(receipt: LivePresentationObservation, nativeItemId: string): void;
    },
  ) {}

  outward(receipt: HostVoiceObservation): void {
    const sessionId = this.deps.session();
    if (
      receipt.stage !== 'first_outward_text' ||
      receipt.callId !== this.deps.scope.callId ||
      !sessionId ||
      !this.available() ||
      Math.abs(Date.now() - receipt.observedAt) > 5000 ||
      this.nativeItems.size >= 4096 ||
      this.nativeItems.has(receipt.nativeItemId)
    )
      return;
    this.nativeItems.set(receipt.nativeItemId, { sessionId, observedAt: receipt.observedAt });
  }

  async observe(
    receipt: LivePresentationObservation,
    verifyHost?: () => Promise<boolean>,
  ): Promise<LivePresentationReply> {
    const session = this.deps.session();
    if (
      receipt.callId !== this.deps.scope.callId ||
      !Number.isSafeInteger(receipt.observedAt) ||
      Math.abs(Date.now() - receipt.observedAt) > 5000
    )
      return { kind: 'error', code: 'invalid_request' };
    if (verifyHost && !(await verifyHost())) return { kind: 'error', code: 'invalid_request' };
    if (!session || !this.available() || !(await this.deps.verify()) || !this.available())
      return { kind: 'error', code: 'unavailable' };
    let itemId: string | undefined;
    if (receipt.reference.kind === 'native-item') {
      const known = this.nativeItems.get(receipt.reference.nativeItemId);
      if (!known) return { kind: 'error', code: 'unavailable' };
      if (known.sessionId !== session || receipt.observedAt < known.observedAt - 1000)
        return { kind: 'error', code: 'invalid_request' };
      itemId = receipt.reference.nativeItemId;
    } else {
      const message = await this.deps.store.getById(receipt.reference.messageId);
      if (!message) return { kind: 'error', code: 'unavailable' };
      if (!this.owned(message, session)) return { kind: 'error', code: 'invalid_request' };
      itemId =
        message.extra?.liveCompanion?.modality !== 'typed' ? message.extra?.liveCompanion?.nativeItemId : undefined;
      if (receipt.observedAt < message.timestamp - 1000) return { kind: 'error', code: 'invalid_request' };
    }
    if (!itemId || !(await this.deps.verify()) || !this.available() || this.deps.session() !== session)
      return { kind: 'error', code: 'unavailable' };
    if (verifyHost && !(await verifyHost())) return { kind: 'error', code: 'invalid_request' };
    if (!this.available() || this.deps.session() !== session) return { kind: 'error', code: 'unavailable' };
    if (this.visible.has(itemId)) return { kind: 'ok' };
    if (this.visible.size >= 4096) return { kind: 'error', code: 'unavailable' };
    this.visible.add(itemId);
    this.deps.observed(receipt, itemId);
    return { kind: 'ok' };
  }

  private owned(message: StoredMessage, session: string): boolean {
    const live = message.extra?.liveCompanion;
    return (
      message.userId === this.deps.scope.userId &&
      message.threadId === this.deps.scope.threadId &&
      message.catId === this.deps.scope.catId &&
      !message.deletedAt &&
      !message.recall &&
      canViewMessage(message, { type: 'user' }) &&
      message.content.trim().length > 0 &&
      live?.callId === this.deps.scope.callId &&
      live.modality !== 'typed' &&
      live.realtimeSessionId === session
    );
  }
  close(): void {
    this.closed = true;
    this.nativeItems.clear();
    this.visible.clear();
  }
  private available(): boolean {
    return !this.closed && this.deps.available();
  }
}
