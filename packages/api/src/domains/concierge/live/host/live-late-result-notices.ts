import { type CatId, createCatId } from '@cat-cafe/shared';
import type { CodexLiveNativeClient } from '../../../cats/services/agents/providers/CodexLiveRunPort.js';
import { messageFrom } from '../../../cats/services/stores/message-from.js';
import type { IMessageStore, StoredMessage } from '../../../cats/services/stores/ports/MessageStore.js';
import { canViewMessage } from '../../../cats/services/stores/visibility.js';
import { liveMessageDigest } from '../live-transcript.js';

interface Pending {
  result: StoredMessage;
  requestRefs: readonly string[];
}
interface Deps {
  scope: { userId: string; threadId: string; catId: CatId; callId: string };
  store: Pick<IMessageStore, 'appendIdempotent' | 'getById' | 'getByThread'>;
  available(): boolean;
  epoch(): number;
  verify(): Promise<boolean>;
  client(): CodexLiveNativeClient | undefined;
  run<T>(operation: () => Promise<T>): Promise<T>;
  publish(message: StoredMessage): void;
}

/** Pending replies project the original Message history. A notice never transfers or reexecutes its Task. */
export class LiveLateResultNotices {
  private readonly committed = new Map<string, StoredMessage>();
  private readonly pending = new Map<string, Pending>();
  private readonly submitted = new Set<string>();
  private readonly controller = new AbortController();
  private running = false;
  constructor(private readonly deps: Deps) {}

  async record(message: StoredMessage): Promise<void> {
    if (!this.available() || !this.ownResult(message)) return;
    const live = message.extra?.liveCompanion;
    if (!live || live.modality !== 'result') return;
    if (this.committed.size < 64) this.committed.set(`${live.nativeTurnId}/${live.nativeItemId}`, message);
    const projection = live.returnProjection;
    if (projection?.presentationEligibility !== 'current') return;
    for (const id of projection.reminderForMessageIds ?? []) {
      const original = await this.deps.store.getById(id);
      if (original && this.ownResult(original) && this.available()) {
        await this.fact('reminder_committed', original, [], message.id);
        this.pending.delete(id);
      }
    }
  }

  async defer(turnId: string, itemId: string, refs: readonly string[]): Promise<void> {
    const result = this.committed.get(`${turnId}/${itemId}`);
    if (!result || !this.available() || this.pending.size >= 64 || !(await this.validate(result, refs))) return;
    await this.fact('deferred', result, refs);
    if (!this.available()) return;
    this.pending.set(result.id, { result, requestRefs: [...refs] });
    this.deps.client()?.wakeBoundary?.();
  }

  async recover(): Promise<void> {
    if (!this.available()) return;
    const rows = await this.deps.store.getByThread(this.deps.scope.threadId, 120, this.deps.scope.userId);
    if (!this.available() || !(await this.deps.verify()) || !this.available()) return;
    const resolved = new Set<string>();
    for (const row of rows) {
      const info = row.extra?.systemInfo?.payload;
      if (
        messageFrom(row).kind === 'system' &&
        info?.kind === 'live_result_notice' &&
        info.phase === 'reminder_committed' &&
        typeof info.resultMessageId === 'string'
      )
        resolved.add(info.resultMessageId);
    }
    // The original durable result is the primary pending projection, even if its later briefing failed.
    for (const row of rows) {
      const live = row.extra?.liveCompanion;
      if (
        !this.ownResult(row) ||
        !live ||
        live.modality !== 'result' ||
        resolved.has(row.id) ||
        live.returnProjection?.presentationEligibility !== 'deferred'
      )
        continue;
      const refs = live.returnProjection.requestRefs;
      if (Array.isArray(refs) && (await this.validate(row, refs)) && this.pending.size < 64)
        this.pending.set(row.id, { result: row, requestRefs: refs });
    }
    for (const row of rows) {
      const info = row.extra?.systemInfo?.payload;
      if (
        messageFrom(row).kind !== 'system' ||
        info?.kind !== 'live_result_notice' ||
        info.phase !== 'deferred' ||
        typeof info.resultMessageId !== 'string' ||
        resolved.has(info.resultMessageId) ||
        !Array.isArray(info.requestRefs)
      )
        continue;
      const refs = info.requestRefs.filter((ref): ref is string => typeof ref === 'string').slice(0, 32);
      const result = await this.deps.store.getById(info.resultMessageId);
      if (!result || !this.ownResult(result) || !(await this.validate(result, refs))) continue;
      if (this.pending.size < 64) this.pending.set(result.id, { result, requestRefs: refs });
    }
    if (this.hasPending()) this.deps.client()?.wakeBoundary?.();
  }

  hasPending(): boolean {
    return this.available() && [...this.pending.keys()].some((id) => !this.submitted.has(id));
  }

  async atBoundary(): Promise<void> {
    if (!this.hasPending() || this.running) return;
    const notice = [...this.pending.values()].find((item) => !this.submitted.has(item.result.id));
    const client = this.deps.client();
    if (!notice || !client?.submitContextAtBoundary) return;
    const epoch = this.deps.epoch();
    const authorize = async () =>
      this.available() &&
      this.deps.epoch() === epoch &&
      (await this.validate(notice.result, notice.requestRefs)) &&
      this.available() &&
      this.deps.epoch() === epoch;
    this.running = true;
    try {
      await this.deps.run(async () => {
        if (!(await authorize())) return;
        await client.submitContextAtBoundary?.(
          [
            'A result of an earlier owner request is already saved in this thread. This notice contains references only, no old result body. It is not a new request, permission or Task admission. Do not reexecute or redelegate the original work.',
            'Read the original request/result and the current corrections or cancellation before responding. A topic change does not cancel the work. Do not speak obsolete or superseded old text. If still relevant, leave the source-backed answer in Message history and give a brief natural reminder at a conversational pause; otherwise do not interrupt or invent a completion. Finding a different item must be stated plainly.',
            'Coverage: pending facts from the most recent 120 messages, not complete historical custody.',
          ].join('\n'),
          [this.ref(notice.result.id), ...notice.requestRefs.slice(0, 31).map((ref) => this.normalize(ref))],
          'late_result_notice',
          this.controller.signal,
          authorize,
        );
        if (this.available()) this.submitted.add(notice.result.id);
      });
    } finally {
      this.running = false;
    }
  }

  close(): void {
    this.controller.abort();
    this.committed.clear();
    this.pending.clear();
    this.submitted.clear();
  }
  private available(): boolean {
    return !this.controller.signal.aborted && this.deps.available();
  }
  private ownResult(message: StoredMessage): boolean {
    return (
      message.userId === this.deps.scope.userId &&
      message.threadId === this.deps.scope.threadId &&
      message.catId === this.deps.scope.catId &&
      message.extra?.liveCompanion?.modality === 'result' &&
      !message.recall &&
      canViewMessage(message, { type: 'cat', catId: this.deps.scope.catId })
    );
  }
  private async validate(result: StoredMessage, refs: readonly string[]): Promise<boolean> {
    if (!this.available() || !refs.length || refs.length > 32 || !(await this.deps.verify())) return false;
    const current = await this.deps.store.getById(result.id);
    if (!current || !this.ownResult(current) || liveMessageDigest(current) !== liveMessageDigest(result)) return false;
    for (const ref of refs) {
      const normalized = this.normalize(ref);
      const prefix = `thread:${this.deps.scope.threadId}#`;
      if (!normalized.startsWith(prefix)) return false;
      const source = await this.deps.store.getById(normalized.slice(prefix.length));
      if (
        !source ||
        source.catId !== null ||
        source.userId !== this.deps.scope.userId ||
        source.threadId !== this.deps.scope.threadId ||
        source.recall ||
        !canViewMessage(source, { type: 'cat', catId: this.deps.scope.catId }) ||
        source.extra?.liveCompanion?.callId !== result.extra?.liveCompanion?.callId
      )
        return false;
    }
    return this.available() && (await this.deps.verify()) && this.available();
  }
  private normalize(ref: string): string {
    return ref.startsWith('thread:') ? ref : `thread:${ref.includes('#') ? ref : `${this.deps.scope.threadId}#${ref}`}`;
  }
  private ref(id: string): string {
    return `thread:${this.deps.scope.threadId}#${id}`;
  }
  private async fact(
    phase: 'deferred' | 'reminder_committed',
    result: StoredMessage,
    refs: readonly string[],
    reminderMessageId?: string,
  ): Promise<void> {
    if (!this.available()) return;
    const stored = await this.deps.store.appendIdempotent({
      userId: this.deps.scope.userId,
      threadId: this.deps.scope.threadId,
      from: { kind: 'system', service: 'live-companion' },
      content:
        phase === 'deferred'
          ? `此前结果已保存，换题后尚未回告。[查看原结果](/thread/${encodeURIComponent(this.deps.scope.threadId)}?message=${encodeURIComponent(result.id)})`
          : `已写下对此前结果的补充说明。[查看说明](/thread/${encodeURIComponent(this.deps.scope.threadId)}?message=${encodeURIComponent(reminderMessageId ?? '')})；尚未确认播出。`,
      timestamp: Date.now(),
      mentions: [],
      origin: 'briefing',
      idempotencyKey: `live-return:${phase}:${result.id}`,
      extra: {
        systemKind: 'context_briefing',
        systemInfo: {
          v: 1,
          payload: {
            kind: 'live_result_notice',
            phase,
            resultMessageId: result.id,
            requestRefs: [...refs],
            ...(reminderMessageId ? { reminderMessageId } : {}),
          },
        },
      },
    });
    if (this.available() && !stored.idempotent) this.deps.publish(stored.message);
  }
}
