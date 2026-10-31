import {
  type IgnoredItemSnapshot,
  ignoredItemKey,
  type UnifiedAttentionItemV1,
  type UnifiedAttentionPersonalGroupCountsV1,
  type UnifiedAttentionPersonalViewV1,
  type UnifiedAttentionSourceRead,
} from '@cat-cafe/shared';
import { attachDecisionPreferenceCoordinates } from './companion-decision-preference-coordinate.js';
import { decisionQualified, decisionQualifiedItems } from './companion-decision-qualification.js';
import type { UserMentionTodoRead } from './user-mention-todo-projection.js';

export { attachDecisionPreferenceCoordinates } from './companion-decision-preference-coordinate.js';

export interface DecisionPersonalViewInput {
  mode: 'visible' | 'ignored';
  snapshot?: IgnoredItemSnapshot;
  state: UnifiedAttentionSourceRead;
}

function groupCounts(items: UnifiedAttentionItemV1[]): UnifiedAttentionPersonalGroupCountsV1['original'] {
  const counts = { decisions: 0, userMentions: 0, other: 0 };
  for (const item of items) {
    if (item.kind === 'user_mention') counts.userMentions++;
    else if (decisionQualified(item)) counts.decisions++;
    else counts.other++;
  }
  return counts;
}

interface ExactPersonalCounts {
  originalTotalCount: number;
  visibleTotalCount: number;
  ignoredTotalCount: number;
  originalAttentionCount: number;
  visibleAttentionCount: number;
  ignoredAttentionCount: number;
  groupCounts: UnifiedAttentionPersonalGroupCountsV1;
}

interface PersonalProjection {
  pageItems: UnifiedAttentionItemV1[];
  attentionItems: UnifiedAttentionItemV1[];
  sourceExact: boolean;
  view?: UnifiedAttentionPersonalViewV1;
  counts?: ExactPersonalCounts;
}

function snapshotIsExact(
  snapshot: IgnoredItemSnapshot | undefined,
  ownerUserId: string,
): snapshot is IgnoredItemSnapshot {
  return Boolean(
    snapshot &&
      snapshot.ownerUserId === ownerUserId &&
      Number.isSafeInteger(snapshot.revision) &&
      snapshot.revision >= 0,
  );
}

function partition(
  items: UnifiedAttentionItemV1[],
  ignoredKeys: Set<string>,
): { visible: UnifiedAttentionItemV1[]; ignored: UnifiedAttentionItemV1[]; exact: boolean } {
  const visible: UnifiedAttentionItemV1[] = [];
  const ignored: UnifiedAttentionItemV1[] = [];
  let exact = true;
  for (const item of items) {
    if (!item.preferenceCoordinate) {
      exact = false;
      continue;
    }
    (ignoredKeys.has(ignoredItemKey(item.preferenceCoordinate)) ? ignored : visible).push(item);
  }
  return { visible, ignored, exact };
}

/** Personal presentation only: canonical membership and lifecycle stay untouched. */
export function projectDecisionPersonalView(input: {
  pageItems: UnifiedAttentionItemV1[];
  attentionItems: UnifiedAttentionItemV1[];
  ownerUserId: string;
  personal?: DecisionPersonalViewInput;
}): PersonalProjection {
  const pageItems = attachDecisionPreferenceCoordinates(input.pageItems);
  const attentionItems = attachDecisionPreferenceCoordinates(input.attentionItems);
  if (!input.personal) return { pageItems, attentionItems, sourceExact: true };

  const { mode, snapshot, state } = input.personal;
  const baseView: UnifiedAttentionPersonalViewV1 = { mode };
  const sourceExact =
    state.status === 'available' && state.exhaustiveness === 'complete' && snapshotIsExact(snapshot, input.ownerUserId);
  if (!sourceExact) return { pageItems: [], attentionItems: [], sourceExact: false, view: baseView };

  const ignoredKeys = new Set(
    snapshot.entries
      .filter((entry) => entry.coordinate.kind === 'mailbox')
      .map((entry) => ignoredItemKey(entry.coordinate)),
  );
  const page = partition(pageItems, ignoredKeys);
  const attention = partition(attentionItems, ignoredKeys);
  if (!page.exact || !attention.exact) {
    return {
      pageItems: [],
      attentionItems: [],
      sourceExact: false,
      view: { ...baseView, preferenceRevision: snapshot.revision },
    };
  }
  const counts = {
    originalTotalCount: pageItems.length,
    visibleTotalCount: page.visible.length,
    ignoredTotalCount: page.ignored.length,
    originalAttentionCount: attentionItems.length,
    visibleAttentionCount: attention.visible.length,
    ignoredAttentionCount: attention.ignored.length,
    groupCounts: {
      original: groupCounts(pageItems),
      visible: groupCounts(page.visible),
      ignored: groupCounts(page.ignored),
    },
  };
  return {
    pageItems: mode === 'visible' ? page.visible : page.ignored,
    attentionItems: mode === 'visible' ? attention.visible : attention.ignored,
    sourceExact: true,
    view: { mode, preferenceRevision: snapshot.revision },
    counts,
  };
}

export function selectDecisionPersonalItems(input: {
  canonicalItems: UnifiedAttentionItemV1[];
  reasons: Set<string>;
  userMentions?: UserMentionTodoRead;
  userId: string;
  personal?: DecisionPersonalViewInput;
}): PersonalProjection {
  const historicalMentions = input.userMentions?.period === 'earlier' || input.userMentions?.period === 'handled';
  const pageItems = historicalMentions
    ? [...(input.userMentions?.items ?? [])]
    : [...input.canonicalItems, ...(input.userMentions?.items ?? [])];
  const projection = projectDecisionPersonalView({
    pageItems,
    attentionItems: decisionQualifiedItems(input.canonicalItems),
    ownerUserId: input.userId,
    personal: input.personal,
  });
  if (input.personal && !projection.sourceExact) input.reasons.add('personal_preference_read_unverified');
  return projection;
}
