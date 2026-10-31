import type { IgnoredItemSnapshot, UnifiedAttentionPreferenceCoordinate } from '@cat-cafe/shared';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import { projectDecisionPersonalView } from './companion-decision-personal-view.js';
import { readDecisionPersonalPreferences } from './companion-decision-read-service.js';
import { classifyUserMentionPeriod, projectUserMentionTodoItem } from './user-mention-todo-projection.js';

export type UserMentionPersonalPreviewPeriod = 'today' | 'week' | 'earlier' | 'all';

type PreviewStore = Pick<IMessageStore, 'listUserMentionRequests' | 'getUserMentionStateRevisions'>;

interface PersonalPreviewRequest {
  threadId: string;
  messageId: string;
  expectedRevision: number;
  preferenceCoordinate: UnifiedAttentionPreferenceCoordinate;
}

interface PersonalPreviewResponse {
  ownerUserId: string;
  period: UserMentionPersonalPreviewPeriod;
  coverage: { state: 'complete' | 'partial' };
  consistency: { state: 'verified' | 'uncertain'; reasons: string[] };
  requests: PersonalPreviewRequest[];
  observedAt: number;
  readWindow: { startedAt: number; endedAt: number; consistency: 'independent_source_reads' };
  counts?: { week: number; earlier: number };
  personalView: {
    mode: 'visible';
    preferenceRevision?: number;
    originalCount?: number;
    visibleCount?: number;
    ignoredCount?: number;
  };
}

function partialResponse(input: {
  ownerUserId: string;
  period: UserMentionPersonalPreviewPeriod;
  startedAt: number;
  observedAt: number;
  reason: 'mention_source_unverified' | 'personal_preference_read_unverified' | 'mention_coordinate_unverified';
  preferenceRevision?: number;
}): PersonalPreviewResponse {
  return {
    ownerUserId: input.ownerUserId,
    period: input.period,
    coverage: { state: 'partial' },
    consistency: { state: 'uncertain', reasons: [input.reason] },
    requests: [],
    observedAt: input.observedAt,
    readWindow: {
      startedAt: input.startedAt,
      endedAt: input.observedAt,
      consistency: 'independent_source_reads',
    },
    personalView: {
      mode: 'visible',
      ...(input.preferenceRevision === undefined ? {} : { preferenceRevision: input.preferenceRevision }),
    },
  };
}

function belongsToPeriod(input: {
  timestamp: number;
  before?: number;
  period: UserMentionPersonalPreviewPeriod;
  cutover: number;
  now: number;
}): boolean {
  if (input.before !== undefined && input.timestamp >= input.before) return false;
  const group = classifyUserMentionPeriod(input.timestamp, input.cutover, input.now);
  switch (input.period) {
    case 'all':
      return true;
    case 'week':
      return group !== 'earlier';
    default:
      return group === input.period;
  }
}

/** Full selected-period snapshot for a personal bulk ignore confirmation; never paginated or writable. */
export async function readUserMentionPersonalPreview(input: {
  ownerUserId: string;
  period: UserMentionPersonalPreviewPeriod;
  before?: number;
  cutover: number;
  now: number;
  messageStore?: PreviewStore;
  readIgnoredItemPreferences?: (ownerUserId: string) => IgnoredItemSnapshot | Promise<IgnoredItemSnapshot>;
}): Promise<PersonalPreviewResponse> {
  const startedAt = Date.now();
  if (!input.messageStore) {
    return partialResponse({ ...input, startedAt, observedAt: Date.now(), reason: 'mention_source_unverified' });
  }
  try {
    const rows = await input.messageStore.listUserMentionRequests(input.ownerUserId);
    const revisions = await input.messageStore.getUserMentionStateRevisions(input.ownerUserId);
    const counts = { week: 0, earlier: 0 };
    for (const message of rows) {
      const group = classifyUserMentionPeriod(message.timestamp, input.cutover, input.now);
      counts[group === 'earlier' ? 'earlier' : 'week']++;
    }
    const selected = rows.filter((message) => belongsToPeriod({ ...input, timestamp: message.timestamp }));
    const items = selected.map((message) => {
      const revision = revisions[message.threadId];
      if (revision === undefined) throw new Error('Missing mention revision');
      return projectUserMentionTodoItem(message, input.ownerUserId, revision);
    });
    const preference = await readDecisionPersonalPreferences(
      { mode: 'visible', read: input.readIgnoredItemPreferences },
      input.ownerUserId,
    );
    const projection = projectDecisionPersonalView({
      pageItems: items,
      attentionItems: [],
      ownerUserId: input.ownerUserId,
      personal: { mode: 'visible', snapshot: preference.snapshot, state: preference.state },
    });
    if (!projection.sourceExact) {
      const reason =
        preference.state.status === 'available' && preference.state.exhaustiveness === 'complete'
          ? 'mention_coordinate_unverified'
          : 'personal_preference_read_unverified';
      return partialResponse({
        ...input,
        startedAt,
        observedAt: Date.now(),
        reason,
        preferenceRevision: projection.view?.preferenceRevision,
      });
    }
    if (!projection.counts) {
      return partialResponse({
        ...input,
        startedAt,
        observedAt: Date.now(),
        reason: 'mention_coordinate_unverified',
      });
    }
    const preferenceRevision = projection.view?.preferenceRevision;
    if (preferenceRevision === undefined) {
      return partialResponse({
        ...input,
        startedAt,
        observedAt: Date.now(),
        reason: 'mention_coordinate_unverified',
      });
    }
    const requests = projection.pageItems.map((item): PersonalPreviewRequest => {
      if (!item.userMention) throw new Error('Incomplete mention source');
      if (!item.preferenceCoordinate) throw new Error('Incomplete mention coordinate');
      const expectedRevision = item.userMention.expectedRevision;
      if (expectedRevision === undefined) throw new Error('Incomplete mention revision');
      return {
        threadId: item.userMention.threadId,
        messageId: item.userMention.messageId,
        expectedRevision,
        preferenceCoordinate: item.preferenceCoordinate,
      };
    });
    const observedAt = Date.now();
    return {
      ownerUserId: input.ownerUserId,
      period: input.period,
      coverage: { state: 'complete' },
      consistency: { state: 'verified', reasons: [] },
      counts,
      requests,
      observedAt,
      readWindow: { startedAt, endedAt: observedAt, consistency: 'independent_source_reads' },
      personalView: {
        mode: 'visible',
        preferenceRevision,
        originalCount: projection.counts.originalTotalCount,
        visibleCount: projection.counts.visibleTotalCount,
        ignoredCount: projection.counts.ignoredTotalCount,
      },
    };
  } catch {
    return partialResponse({ ...input, startedAt, observedAt: Date.now(), reason: 'mention_source_unverified' });
  }
}
