import type { SuggestionByline, SuggestionKindFacts } from '@cat-cafe/shared';
import type { ISuggestionStore, SuggestionRecord } from './SuggestionStore.js';
import type { SuggestionActionHandler, SuggestionActionRegistry } from './suggestion-actions.js';
import { countEvents, withEvent } from './suggestion-projection.js';

/** Due offers settled as 「不理」 per read; any remainder is settled on the next read (or when its page loads). */
const SETTLE_BATCH = 500;
/** 「改了」 is read back from the most recent applied offers only; the counts themselves are never truncated. */
const INSPECT_SCAN = 200;
const INSPECT_LIMIT = 20;
const RECENT_LIMIT = 5;

export interface SuggestionFactsDeps {
  store: ISuggestionStore;
  now: () => number;
  /** Read a stored row the way the page sees it; an expiry is persisted (and pushed to open pages). */
  settle(record: SuggestionRecord, now: number): Promise<SuggestionRecord>;
}

export interface SuggestionFactsRequestDeps extends SuggestionFactsDeps {
  registry: SuggestionActionRegistry;
}

/** All kinds (registered ∪ seen) or one; `stopOffering` hides that kind for the asking cat first. Kinds are validated. */
export async function readSuggestionFacts(
  deps: SuggestionFactsRequestDeps,
  actor: { userId: string; catId: string; byline: SuggestionByline },
  query: { kind?: string; stopOffering?: string },
): Promise<SuggestionKindFacts[]> {
  if (query.stopOffering) {
    await deps.store.hide(actor.userId, {
      catId: actor.catId,
      kind: query.stopOffering,
      byline: actor.byline,
      hiddenAt: deps.now(),
    });
  }
  const kinds = query.kind
    ? [query.kind]
    : [...new Set([...deps.registry.kinds(), ...(await deps.store.listUserKinds(actor.userId))])].sort();
  const hidden = await deps.store.listHidden(actor.userId);
  const facts: SuggestionKindFacts[] = [];
  for (const kind of kinds) {
    const handler = deps.registry.get(kind);
    if (!handler) continue;
    const stoppedAt = hidden.find((entry) => entry.kind === kind && entry.catId === actor.catId)?.hiddenAt;
    facts.push(await readSuggestionKindFacts(deps, actor.userId, handler, stoppedAt));
  }
  return facts;
}

/**
 * 「这类提了几次、用了几次、忽略了几次」——按种类把人的处置摆成事实，交给猫自己掂量（F335 KD-11）。不出规则、不出建议。
 * 只数提议本身；猫直接挂的回执不算「提了」。
 */
export async function readSuggestionKindFacts(
  deps: SuggestionFactsDeps,
  userId: string,
  handler: SuggestionActionHandler,
  stoppedAt: number | undefined,
): Promise<SuggestionKindFacts> {
  const now = deps.now();
  for (const due of await deps.store.listOpenDue(userId, handler.kind, now, SETTLE_BATCH)) {
    await deps.settle(due, now);
  }
  const recent: SuggestionRecord[] = [];
  let inspected = 0;
  const inspect = handler.inspect?.bind(handler);
  for (const raw of await deps.store.listUserKind(userId, handler.kind, INSPECT_SCAN)) {
    if (raw.receiptOnly) continue;
    let record = await deps.settle(raw, now);
    if (inspect && record.state === 'applied' && record.appliedRef && inspected < INSPECT_LIMIT) {
      inspected += 1;
      if (countEvents(record, 'edited') === 0) record = await noteEdit(deps, record, inspect, now);
    }
    if (recent.length < RECENT_LIMIT) recent.push(record);
  }
  const counts = await deps.store.kindCounts(userId, handler.kind);
  const count = (type: keyof typeof counts) => counts[type] ?? 0;
  return {
    kind: handler.kind,
    kindLabel: handler.kindLabel,
    offered: count('offered'),
    applied: count('applied'),
    edited: count('edited'),
    undone: count('undone'),
    dismissed: count('dismissed'),
    ignored: count('ignored'),
    open: await deps.store.countOpen(userId, handler.kind),
    ...(recent[0] ? { lastOfferedAt: recent[0].createdAt } : {}),
    ...(stoppedAt !== undefined ? { stoppedAt } : {}),
    recent: recent.map((record) => ({
      at: record.createdAt,
      label: record.label,
      threadId: record.threadId,
      outcome: record.state,
      edited: countEvents(record, 'edited') > 0,
    })),
  };
}

/** 「改了」：what was applied changed or went away without the row's own undo. Recorded (and counted) once. */
async function noteEdit(
  deps: SuggestionFactsDeps,
  record: SuggestionRecord,
  inspect: NonNullable<SuggestionActionHandler['inspect']>,
  now: number,
): Promise<SuggestionRecord> {
  const context = { userId: record.userId, threadId: record.threadId, catId: record.catId, suggestionId: record.id };
  const inspection = await inspect(context, record.appliedRef ?? {}).catch(() => 'unknown' as const);
  if (inspection !== 'edited' && inspection !== 'gone') return record;
  const next = { ...record, events: withEvent(record, 'edited', now), revision: record.revision + 1, updatedAt: now };
  const swapped = await deps.store.swap(next, record.revision, 'edited');
  return swapped.kind === 'swapped' ? next : record;
}
