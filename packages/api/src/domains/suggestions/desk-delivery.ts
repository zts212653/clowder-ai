import {
  type BringToDeskInput,
  DESK_DELIVERY_LIMIT,
  type DeskDelivery,
  type DeskDeliveryItem,
  type DeskSettleInput,
  type DeskSettleItemResult,
  type DeskSettlement,
  type SuggestionDeskView,
  toDeskText,
  type WorkReference,
  workReferenceCardSchema,
} from '@cat-cafe/shared';
import type { SuggestionActor, SuggestionResult, SuggestionService } from './SuggestionService.js';
import { type ISuggestionStore, type SuggestionRecord, tracksOnDesk } from './SuggestionStore.js';
import type { SuggestionActionHandler } from './suggestion-actions.js';
import { BROUGHT_WORK_KIND, BROUGHT_WORK_LABEL, broughtWorkRecord } from './suggestion-records.js';

/** What the desk needs of a saved message: whose it is, where, and the work cards on it. */
export interface DeskMessage {
  userId: string;
  threadId: string;
  blocks: readonly unknown[];
}

export interface SuggestionDeskDeps {
  service: SuggestionService;
  store: ISuggestionStore;
  /** The saved message, or null while it is still being written (a reply's card lands with the reply). */
  loadMessage(messageId: string): Promise<DeskMessage | null>;
  threadTitle?(threadId: string): Promise<string | undefined>;
  /**
   * This turn's card for that work is still in the rich-block buffer: the reply is saved while it streams and the
   * card lands on it when the turn ends (publish-reference → create-rich-block).
   */
  cardPending?(actor: SuggestionActor, work: WorkReference): boolean;
}

export type DeskBringStatus =
  /** The reply with the card is saved: the desk can carry it now. */
  | 'ready'
  /** The card arrives with this turn's reply; the desk carries it once that reply is saved. */
  | 'waiting_for_card';

/** Rows scanned per read. The desk shows at most `DESK_DELIVERY_LIMIT`; the rest stay in their conversations. */
const DESK_SCAN = 100;
const OPEN_SCAN = 50;

/** Brought works are carried by the desk; they have no button under the reply (the work card is the thing). */
export const broughtWorkHandler: SuggestionActionHandler = {
  kind: BROUGHT_WORK_KIND,
  kindLabel: BROUGHT_WORK_LABEL,
  undoLabel: 'undo',
  prepare: async () => ({ ok: false, error: 'Bring a work with cat_cafe_bring_to_desk, not as a suggestion' }),
  apply: async () => ({ ok: false, error: 'A brought work is opened from the desk or its card' }),
  undo: async () => ({ ok: false, error: 'Nothing to undo' }),
};

/** The title of the block when it is the work card of exactly this version. */
export function workCardTitle(block: unknown, work: WorkReference): string | null {
  const card = workReferenceCardSchema.safeParse(block);
  if (!card.success) return null;
  const { reference } = card.data.meta;
  return reference.contentRef === work.contentRef && reference.ownerRevision === work.ownerRevision
    ? card.data.title
    : null;
}

function cardTitle(message: DeskMessage, work: WorkReference): string | null {
  for (const block of message.blocks) {
    const title = workCardTitle(block, work);
    if (title) return title;
  }
  return null;
}

/**
 * F335 交付三：桌面猫带来。东西只在「给人的东西」存一份；这里决定什么时候、哪几件上桌面，并把桌面上的处置
 * （展示 / 打开 / 添加 / 忽略 / 没理）按同一把 revision 锁记回原记录。人在不在由 Host 判断，这里只分「人在，来了新的」
 * 和「人刚回来」两种问法。
 */
export class SuggestionDesk {
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(private readonly deps: SuggestionDeskDeps) {}

  /** The Host learns that something may be ready for this person; it asks with `next` when they are there. */
  watch(userId: string, listener: () => void): () => void {
    const set = this.listeners.get(userId) ?? new Set();
    set.add(listener);
    this.listeners.set(userId, set);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(userId);
    };
  }

  private notify(userId: string): void {
    for (const listener of this.listeners.get(userId) ?? []) listener();
  }

  /** A saved message that carries a work card may be the one a brought work was waiting for. */
  observeMessage(message: DeskMessage): void {
    if (!this.listeners.has(message.userId)) return;
    if (message.blocks.some((block) => workReferenceCardSchema.safeParse(block).success)) this.notify(message.userId);
  }

  async bring(
    actor: SuggestionActor,
    input: BringToDeskInput,
  ): Promise<SuggestionResult<{ id: string; status: DeskBringStatus }>> {
    const { service, store } = this.deps;
    if (await store.isHidden(actor.userId, actor.catId, BROUGHT_WORK_KIND)) {
      return {
        ok: false,
        code: 'kind_stopped',
        error: 'You stopped bringing works; the person can restore it in 设置 › 你',
      };
    }
    const anchor = await service.resolveAnchor(actor, input.messageId);
    if (!anchor.ok) return anchor;
    const saved = await this.deps.loadMessage(anchor.value);
    const title = saved ? cardTitle(saved, input.work) : null;
    // Only this turn's own reply can still be waiting for its card; an explicit older message must already carry it.
    const pending = !title && !input.messageId && this.deps.cardPending?.(actor, input.work) === true;
    if (saved && !title && !pending) {
      return {
        ok: false,
        code: 'invalid',
        error: 'That message does not carry this work version; attach it first with cat_cafe_work publish-reference',
      };
    }
    const record = broughtWorkRecord({
      id: service.newId(),
      now: service.now(),
      actor,
      messageId: anchor.value,
      sentence: input.sentence,
      work: { ...input.work, ...(title ? { title: toDeskText(title, 200) } : {}) },
    });
    const created = await service.insert(record, false, actor);
    if (!created.ok) return created;
    this.notify(actor.userId);
    return { ok: true, value: { id: record.id, status: title ? 'ready' : 'waiting_for_card' } };
  }

  /**
   * `returning: false` — the person is at the desk: brought works that are ready (one → a bubble, several → a list).
   * `returning: true` — they just came back: also the offers still open that the desk never carried. Null: nothing.
   */
  async next(userId: string, query: { returning: boolean }): Promise<DeskDelivery | null> {
    const now = this.deps.service.now();
    const titles = new Map<string, string | undefined>();
    const items: DeskDeliveryItem[] = [];
    for (const stored of await this.deps.store.listDesk(userId, DESK_SCAN)) {
      const record = await this.deps.service.settle(stored, now);
      if (!tracksOnDesk(record)) continue;
      if (record.kind !== BROUGHT_WORK_KIND && !query.returning) continue;
      const item = await this.item(record, titles);
      if (item) items.push(item);
    }
    if (query.returning) items.push(...(await this.uncarriedOffers(userId, now, titles)));
    if (!items.length) return null;
    items.sort((a, b) => b.createdAt - a.createdAt);
    const shown = items.slice(0, DESK_DELIVERY_LIMIT);
    const single = shown.length === 1 && shown[0]?.kind === 'work';
    return { mode: single ? 'single' : 'bundle', items: shown, more: items.length - shown.length };
  }

  private async uncarriedOffers(
    userId: string,
    now: number,
    titles: Map<string, string | undefined>,
  ): Promise<DeskDeliveryItem[]> {
    const items: DeskDeliveryItem[] = [];
    for (const kind of await this.deps.store.listUserKinds(userId)) {
      if (kind === BROUGHT_WORK_KIND) continue;
      for (const stored of await this.deps.store.listOpen(userId, kind, OPEN_SCAN)) {
        if (stored.desk || stored.receiptOnly) continue;
        const record = await this.deps.service.settle(stored, now);
        if (record.state !== 'open') continue;
        const item = await this.item(record, titles);
        if (item) items.push(item);
      }
    }
    return items;
  }

  /** A line only for something the person can find again: its message is saved (and, for a work, carries the card). */
  private async item(
    record: SuggestionRecord,
    titles: Map<string, string | undefined>,
  ): Promise<DeskDeliveryItem | null> {
    const message = await this.deps.loadMessage(record.messageId);
    if (!message || message.userId !== record.userId) return null;
    const work = record.kind === BROUGHT_WORK_KIND ? record.desk?.work : undefined;
    if (record.kind === BROUGHT_WORK_KIND && !work) return null;
    const title = work ? cardTitle(message, work) : record.label;
    if (!title) return null;
    if (!titles.has(record.threadId)) titles.set(record.threadId, await this.deps.threadTitle?.(record.threadId));
    const threadTitle = titles.get(record.threadId);
    const sentence = record.desk?.sentence;
    return {
      ref: record.id,
      revision: record.revision,
      kind: work ? 'work' : 'suggestion',
      catId: record.catId,
      byline: record.byline,
      title: toDeskText(title, 200),
      ...(sentence ? { sentence } : {}),
      ...(work ? { work: { contentRef: work.contentRef, ownerRevision: work.ownerRevision } } : {}),
      threadId: record.threadId,
      ...(threadTitle && toDeskText(threadTitle, 120) ? { threadTitle: toDeskText(threadTitle, 120) } : {}),
      action: work ? 'open' : 'add',
      createdAt: record.createdAt,
    };
  }

  /** What the person did on the desk, line by line; each line under its own revision. */
  async settle(userId: string, input: DeskSettleInput): Promise<DeskSettlement> {
    const results: DeskSettleItemResult[] = [];
    let open: DeskSettlement['open'];
    let saved = false;
    for (const target of input.items) {
      const step = await this.settleOne(userId, input.action, target);
      results.push(step.result);
      if (step.open) open = step.open;
      if (step.saved) saved = true;
    }
    return { action: input.action, items: results, ...(saved ? { saved } : {}), ...(open ? { open } : {}) };
  }

  private async settleOne(
    userId: string,
    action: DeskSettleInput['action'],
    target: { ref: string; revision: number },
  ): Promise<{ result: DeskSettleItemResult; open?: DeskSettlement['open']; saved?: boolean }> {
    const { service } = this.deps;
    const now = service.now();
    const stale = (code?: string) => ({
      result: { ref: target.ref, revision: target.revision, outcome: 'stale' as const, ...(code ? { code } : {}) },
    });
    const stored = await this.deps.store.get(target.ref);
    if (!stored || stored.userId !== userId) return stale('not_found');
    const record = await service.settle(stored, now);
    if (record.revision !== target.revision || record.state !== 'open') return stale();
    const isWork = record.kind === BROUGHT_WORK_KIND;
    if (record.desk ? !tracksOnDesk(record) : isWork) return stale();
    const desk = (patch: Partial<SuggestionDeskView>): SuggestionDeskView => ({
      ...(record.desk ?? {}),
      status: 'settled',
      settledAt: now,
      ...patch,
    });
    const done = (next: SuggestionResult<SuggestionRecord>, code?: string) =>
      next.ok
        ? { ref: target.ref, revision: next.value.revision, outcome: 'settled' as const }
        : { ref: target.ref, revision: target.revision, outcome: 'stale' as const, ...(code ? { code } : {}) };
    switch (action) {
      case 'shown': {
        const next = await service.step(record, record.revision, {
          desk: { ...(record.desk ?? {}), status: 'shown', shownAt: now },
        });
        return { result: done(next) };
      }
      case 'open': {
        const work = record.desk?.work;
        if (!isWork || !work) return { result: { ...target, outcome: 'failed', code: 'not_a_work' } };
        const next = await service.step(
          record,
          record.revision,
          { state: 'applied', desk: desk({ outcome: 'opened' }) },
          'applied',
        );
        return {
          result: done(next),
          ...(next.ok
            ? {
                open: {
                  threadId: record.threadId,
                  messageId: record.messageId,
                  work: { contentRef: work.contentRef, ownerRevision: work.ownerRevision },
                },
              }
            : {}),
        };
      }
      case 'add': {
        if (isWork) return { result: { ...target, outcome: 'failed', code: 'not_an_offer' } };
        const applied = await service.apply(userId, record.id, record.revision);
        if (!applied.ok) {
          const view = applied.view;
          return {
            result: view
              ? { ref: target.ref, revision: view.revision, outcome: 'settled', code: applied.code }
              : { ...target, outcome: 'failed', code: applied.code },
          };
        }
        // The add itself is done; marking where it was done from is a fact only and may lose to a quick undo.
        const after = await this.deps.store.get(record.id);
        if (after?.revision === applied.value.revision) {
          const next = await service.step(after, after.revision, { desk: desk({ outcome: 'added' }) });
          if (next.ok) return { result: done(next) };
        }
        return { result: { ref: target.ref, revision: applied.value.revision, outcome: 'settled' } };
      }
      case 'dismiss': {
        const next = await service.step(
          record,
          record.revision,
          { state: 'dismissed', desk: desk({ outcome: 'dismissed' }) },
          'dismissed',
        );
        return { result: done(next) };
      }
      case 'timeout': {
        // A brought work left unanswered counts as 「不理」; an offer keeps its pill under the reply until it expires.
        const next = await service.step(
          record,
          record.revision,
          isWork ? { state: 'ignored', desk: desk({ outcome: 'saved' }) } : { desk: desk({ outcome: 'saved' }) },
          isWork ? 'ignored' : undefined,
        );
        return { result: done(next), ...(next.ok ? { saved: true } : {}) };
      }
    }
  }
}
