import { randomUUID } from 'node:crypto';
import {
  type HiddenSuggestionKind,
  type SuggestionEventType,
  type SuggestionKindFacts,
  type SuggestionOfferInput,
  type SuggestionOpenTarget,
  type SuggestionReceiptInput,
  type SuggestionView,
} from '@cat-cafe/shared';
import type { SuggestionRecord } from './SuggestionStore.js';
import type { SuggestionActionContext, SuggestionActionHandler, SuggestionApplyResult } from './suggestion-actions.js';
import { insertSuggestion, resolveSuggestionAnchor } from './suggestion-admission.js';
import { readSuggestionFacts } from './suggestion-facts.js';
import { countEvents, effectiveSuggestion, toSuggestionView, withEvent } from './suggestion-projection.js';
import { BROUGHT_WORK_KIND, offerRecord, receiptRecord } from './suggestion-records.js';

import type {
  SuggestionActor,
  SuggestionFailureCode,
  SuggestionResult,
  SuggestionServiceDeps,
} from './suggestion-service-contract.js';

export { PLAIN_RECEIPT_KIND, STALE_TRANSITION_MS } from './suggestion-projection.js';
export type {
  SuggestionActor,
  SuggestionFailureCode,
  SuggestionResult,
  SuggestionServiceDeps,
} from './suggestion-service-contract.js';

const THREAD_LIST_LIMIT = 200;

const fail = <T>(code: SuggestionFailureCode, error: string): SuggestionResult<T> => ({ ok: false, code, error });
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * F335 交付二：回话下面那一排。猫发提议 / 回执；人点用、撤销、忽略；没理的到期记「不理」；按种类的事实给猫掂量。
 * 每次点击都先用 revision 抢到这一行（applying / undoing）再执行动作，双击和两个标签页不会把一件事做两遍。
 * `now / newId / settle / resolveAnchor / insert / step` are shared with the desk delivery (交付三); routes use the rest.
 */
export class SuggestionService {
  readonly now: () => number;
  readonly newId: () => string;

  constructor(private readonly deps: SuggestionServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => `sugg_${randomUUID()}`);
  }

  /** A brought work is drawn by its work card and carried by the desk; the page never gets a row for it. */
  private publish(record: SuggestionRecord): void {
    if (record.kind === BROUGHT_WORK_KIND) return;
    this.deps.publish?.(record.threadId, toSuggestionView(record));
  }

  private context(record: SuggestionRecord): SuggestionActionContext {
    return { userId: record.userId, threadId: record.threadId, catId: record.catId, suggestionId: record.id };
  }

  /** Persist a lazily-derived expiry so facts and the page agree; a lost race just means someone acted first. */
  async settle(stored: SuggestionRecord, now: number): Promise<SuggestionRecord> {
    const effective = effectiveSuggestion(stored, now);
    if (effective.state !== 'ignored' || stored.state === 'ignored') return effective;
    const next = { ...effective, revision: stored.revision + 1, updatedAt: now };
    if ((await this.deps.store.swap(next, stored.revision, 'ignored')).kind === 'swapped') {
      this.publish(next);
      return next;
    }
    const fresh = await this.deps.store.get(stored.id);
    return fresh ? effectiveSuggestion(fresh, now) : effective;
  }

  // ---------- cats ----------

  async offer(actor: SuggestionActor, input: SuggestionOfferInput): Promise<SuggestionResult<SuggestionView>> {
    const handler = this.deps.registry.get(input.action.kind);
    if (!handler) {
      return fail('unknown_kind', `Unknown suggestion kind; available: ${this.deps.registry.kinds().join(', ')}`);
    }
    if (await this.deps.store.isHidden(actor.userId, actor.catId, handler.kind)) {
      return fail('kind_stopped', 'You stopped offering this kind; the person can restore it in 设置 › 你');
    }
    const anchor = await resolveSuggestionAnchor(this.deps, actor, input.messageId);
    if (!anchor.ok) return anchor;
    const id = this.newId();
    const now = this.now();
    const prepared = await handler.prepare(
      { userId: actor.userId, threadId: actor.threadId, catId: actor.catId, suggestionId: id },
      input.action.params,
    );
    if (!prepared.ok) return fail('invalid', prepared.error);
    return this.insert(
      offerRecord({
        id,
        now,
        actor,
        messageId: anchor.value,
        handler,
        label: input.label,
        params: prepared.value,
        expiresInMinutes: input.expiresInMinutes,
      }),
      false,
      actor,
    );
  }

  resolveAnchor(actor: SuggestionActor, messageId: string | undefined): Promise<SuggestionResult<string>> {
    return resolveSuggestionAnchor(this.deps, actor, messageId);
  }

  insert(
    record: SuggestionRecord,
    supplement = false,
    guardActor?: SuggestionActor,
  ): Promise<SuggestionResult<SuggestionView>> {
    return insertSuggestion(this.deps, record, this.now, (row) => this.publish(row), supplement, guardActor);
  }

  /** A cat already did the thing and leaves one line, optionally undoable through a registered action. */
  async postReceipt(actor: SuggestionActor, input: SuggestionReceiptInput): Promise<SuggestionResult<SuggestionView>> {
    let handler: SuggestionActionHandler | undefined;
    if (input.action) {
      handler = this.deps.registry.get(input.action.kind);
      if (!handler) return fail('unknown_kind', 'Unknown action kind for this receipt');
      if (!handler.verifyReceipt) return fail('invalid', 'This kind cannot be undone from a cat-posted receipt');
      const owned = await handler.verifyReceipt(
        { userId: actor.userId, threadId: actor.threadId, catId: actor.catId, suggestionId: '' },
        input.action.appliedRef,
      );
      if (!owned) return fail('invalid', 'The receipt does not point at something you did in this conversation');
    }
    const anchor = await resolveSuggestionAnchor(this.deps, actor, input.messageId);
    if (!anchor.ok) return anchor;
    return this.insertReceipt(
      actor,
      anchor.value,
      input.text,
      handler,
      input.action?.appliedRef,
      undefined,
      false,
      actor,
    );
  }

  /**
   * Server-side receipts (线 1：「已暂停至 02:10 · 恢复」「已关闭 · 撤销」、@你 之后那一行). The caller already did the
   * action through its own code; `kind` must be registered when the row can be undone.
   */
  async recordReceipt(input: {
    actor: SuggestionActor;
    messageId: string;
    text: string;
    open?: SuggestionOpenTarget;
    action?: { kind: string; appliedRef: Record<string, unknown> };
    mergeWatcherSupplement?: boolean;
  }): Promise<SuggestionResult<SuggestionView>> {
    const handler = input.action ? this.deps.registry.get(input.action.kind) : undefined;
    if (input.action && !handler) return fail('unknown_kind', 'Unknown action kind for this receipt');
    const anchor = await resolveSuggestionAnchor(this.deps, input.actor, input.messageId);
    if (!anchor.ok) return anchor;
    return this.insertReceipt(
      input.actor,
      anchor.value,
      input.text,
      handler,
      input.action?.appliedRef,
      input.open,
      input.mergeWatcherSupplement === true && input.actor.byline === 'watcher',
    );
  }

  private insertReceipt(
    actor: SuggestionActor,
    messageId: string,
    text: string,
    handler: SuggestionActionHandler | undefined,
    appliedRef: Record<string, unknown> | undefined,
    open?: SuggestionOpenTarget,
    supplement = false,
    guardActor?: SuggestionActor,
  ): Promise<SuggestionResult<SuggestionView>> {
    const now = this.now();
    return this.insert(
      receiptRecord({ id: this.newId(), now, actor, messageId, text, handler, appliedRef, open }),
      supplement,
      guardActor,
    );
  }

  /** Per-kind facts for the asking cat; `stopOffering` records that it will not offer that kind again. */
  async facts(
    actor: Pick<SuggestionActor, 'userId' | 'catId' | 'byline'>,
    query: { kind?: string; stopOffering?: string },
  ): Promise<SuggestionResult<{ kinds: SuggestionKindFacts[]; stopped?: string }>> {
    const unknown = [query.kind, query.stopOffering].find((kind) => kind && !this.deps.registry.get(kind));
    if (unknown) return fail('unknown_kind', 'Unknown suggestion kind');
    const kinds = await readSuggestionFacts(
      { store: this.deps.store, registry: this.deps.registry, now: this.now, settle: (r, at) => this.settle(r, at) },
      { userId: actor.userId, catId: actor.catId, byline: actor.byline ?? 'cat' },
      query,
    );
    return { ok: true, value: { kinds, ...(query.stopOffering ? { stopped: query.stopOffering } : {}) } };
  }

  // ---------- the person ----------

  async listThread(userId: string, threadId: string): Promise<SuggestionView[]> {
    const now = this.now();
    const views: SuggestionView[] = [];
    for (const stored of await this.deps.store.listThread(threadId, THREAD_LIST_LIMIT)) {
      if (stored.userId !== userId || stored.kind === BROUGHT_WORK_KIND) continue;
      const record = await this.settle(stored, now);
      if (record.state !== 'ignored' || record.watcherSupplement) views.push(toSuggestionView(record));
    }
    return views;
  }

  private async loadOwned(userId: string, id: string, revision: number): Promise<SuggestionResult<SuggestionRecord>> {
    const stored = await this.deps.store.get(id);
    if (!stored || stored.userId !== userId) return fail('not_found', 'Suggestion not found');
    if (stored.revision !== revision) return fail('conflict', 'This row changed; refresh');
    return { ok: true, value: effectiveSuggestion(stored, this.now()) };
  }

  async step(
    record: SuggestionRecord,
    expectedRevision: number,
    patch: Partial<SuggestionRecord>,
    event?: SuggestionEventType,
  ): Promise<SuggestionResult<SuggestionRecord>> {
    const now = this.now();
    const next: SuggestionRecord = {
      ...record,
      ...patch,
      ...(event ? { events: withEvent(record, event, now) } : {}),
      revision: expectedRevision + 1,
      updatedAt: now,
    };
    const counted = event && !record.receiptOnly ? event : undefined;
    const swapped = await this.deps.store.swap(next, expectedRevision, counted);
    if (swapped.kind === 'swapped') {
      this.publish(next);
      return { ok: true, value: next };
    }
    return fail(swapped.kind === 'missing' ? 'not_found' : 'conflict', 'This row changed; refresh');
  }

  private viewOf(result: SuggestionResult<SuggestionRecord>): SuggestionResult<SuggestionView> {
    return result.ok ? { ok: true, value: toSuggestionView(result.value) } : result;
  }

  async apply(userId: string, id: string, expectedRevision: number): Promise<SuggestionResult<SuggestionView>> {
    const loaded = await this.loadOwned(userId, id, expectedRevision);
    if (!loaded.ok) return loaded;
    const record = loaded.value;
    if (record.state !== 'open') return fail('conflict', 'This suggestion is no longer open');
    const handler = this.deps.registry.get(record.kind);
    if (!handler) return fail('unknown_kind', 'This kind is no longer available');
    const claimed = await this.step(record, expectedRevision, { state: 'applying' });
    if (!claimed.ok) return claimed;
    // Each attempt gets its own number so an action keyed by it replays a retried attempt and re-runs after an undo.
    const attempt = countEvents(record, 'applied') + 1;
    const result: SuggestionApplyResult = await handler
      .apply({ ...this.context(record), attempt }, record.params)
      .catch((error: unknown) => ({ ok: false as const, error: errorText(error) }));
    if (!result.ok && result.partial) {
      // Part of it happened and could not be taken back: say exactly that, and keep it undoable.
      const { appliedRef, receipt } = result.partial;
      const kept = await this.step(
        claimed.value,
        claimed.value.revision,
        { state: 'applied', appliedRef, receipt },
        'applied',
      );
      return kept.ok
        ? { ok: false, code: 'action_partial', error: result.error, view: toSuggestionView(kept.value) }
        : kept;
    }
    if (!result.ok) {
      await this.step(claimed.value, claimed.value.revision, { state: 'open' });
      return fail('action_failed', result.error);
    }
    const { appliedRef, receipt } = result.value;
    return this.viewOf(
      await this.step(claimed.value, claimed.value.revision, { state: 'applied', appliedRef, receipt }, 'applied'),
    );
  }

  async dismiss(userId: string, id: string, expectedRevision: number): Promise<SuggestionResult<SuggestionView>> {
    const loaded = await this.loadOwned(userId, id, expectedRevision);
    if (!loaded.ok) return loaded;
    if (loaded.value.state !== 'open') return fail('conflict', 'This suggestion is no longer open');
    return this.viewOf(await this.step(loaded.value, expectedRevision, { state: 'dismissed' }, 'dismissed'));
  }

  /** 撤销 / 恢复：undo an applied row through its action, or bring a dismissed pill back. */
  async undo(userId: string, id: string, expectedRevision: number): Promise<SuggestionResult<SuggestionView>> {
    const loaded = await this.loadOwned(userId, id, expectedRevision);
    if (!loaded.ok) return loaded;
    const record = loaded.value;
    if (record.state === 'dismissed') {
      return this.viewOf(await this.step(record, expectedRevision, { state: 'open' }, 'restored'));
    }
    if (record.state !== 'applied' || !record.undo || !record.appliedRef) {
      return fail('conflict', 'This row cannot be undone');
    }
    const handler = this.deps.registry.get(record.kind);
    if (!handler) return fail('unknown_kind', 'This kind is no longer available');
    const claimed = await this.step(record, expectedRevision, { state: 'undoing' });
    if (!claimed.ok) return claimed;
    const result = await handler
      .undo(this.context(record), record.appliedRef)
      .catch((error: unknown) => ({ ok: false as const, error: errorText(error) }));
    if (!result.ok) {
      await this.step(claimed.value, claimed.value.revision, { state: 'applied' });
      return fail('action_failed', result.error);
    }
    const settled = record.receiptOnly
      ? { state: 'undone' as const }
      : { state: 'open' as const, appliedRef: undefined, receipt: undefined };
    return this.viewOf(await this.step(claimed.value, claimed.value.revision, settled, 'undone'));
  }

  async listHidden(userId: string): Promise<HiddenSuggestionKind[]> {
    const entries = await this.deps.store.listHidden(userId);
    return entries.map((entry) => ({
      catId: entry.catId,
      byline: entry.byline,
      kind: entry.kind,
      kindLabel: this.deps.registry.get(entry.kind)?.kindLabel ?? entry.kind,
      hiddenAt: entry.hiddenAt,
    }));
  }

  async restoreKind(userId: string, catId: string, kind: string): Promise<boolean> {
    return this.deps.store.unhide(userId, catId, kind);
  }
}
