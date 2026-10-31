import {
  collectiveAccountabilityAttentionItemSchema,
  collectiveProjectAttentionItemSchema,
  isValidRichBlock,
  type UnifiedAttentionReadV1,
  unifiedAttentionChoiceRequestSchema,
} from '@cat-cafe/shared';

/**
 * Structural guard for `GET /api/concierge/work/decisions?view=unified` (F310 delivery record).
 *
 * F310 deliberately does not export a runtime schema for the whole response (only the upstream source schemas), so this
 * checks the fields the 小信箱 reads — version, status, identity, per-source state, consistency, item keys and kinds,
 * `totalCount`, page — and nothing else. Extra fields pass through. A body that fails here is never an "empty success":
 * the caller treats it as unavailable.
 *
 * Approval rows are NOT re-validated against ApprovalHubItem here: F310 already runs the canonical approval schema on
 * the producer side, and the canonical card renders them. This guard only refuses a row that has no addressable
 * approval at all.
 */

const OVERALL_STATUS = new Set(['available', 'partial', 'unavailable']);
const SOURCE_STATUS = new Set(['available', 'unavailable', 'unauthenticated', 'forbidden', 'invalid']);
const EXHAUSTIVENESS = new Set(['complete', 'partial', 'unknown']);
const ITEM_KIND = new Set(['approval', 'judgment', 'repair', 'user_mention']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isSourceRead(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.status === 'string' &&
    SOURCE_STATUS.has(value.status) &&
    typeof value.exhaustiveness === 'string' &&
    EXHAUSTIVENESS.has(value.exhaustiveness)
  );
}

function isChoiceRequest(value: unknown): boolean {
  return unifiedAttentionChoiceRequestSchema.safeParse(value).success;
}

function isRuntimeInteraction(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !isNonBlankString(value.interactionId) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 0 ||
    !isNonBlankString(value.requesterCatId) ||
    !Number.isSafeInteger(value.createdAt) ||
    !isNonBlankString(value.title) ||
    !isRecord(value.cardRef)
  )
    return false;
  const ref = value.cardRef;
  if (!['threadId', 'messageId', 'blockId'].every((k) => isNonBlankString(ref[k]))) return false;
  if (value.sourceKind === 'conversation_decision')
    return (
      value.kind === 'conversation_decision' &&
      Number(value.revision) > 0 &&
      typeof value.allowTextResponse === 'boolean' &&
      isValidRichBlock(value.presentation) &&
      value.presentation.kind === 'interactive' &&
      value.presentation.id === ref.blockId &&
      typeof ref.blockDigest === 'string' &&
      /^[a-f0-9]{64}$/.test(ref.blockDigest) &&
      Number.isSafeInteger(ref.publishedAt) &&
      Number(ref.publishedAt) >= 0 &&
      (value.deadlineAt === undefined || (Number.isSafeInteger(value.deadlineAt) && Number(value.deadlineAt) > 0))
    );
  return (
    (value.sourceKind === undefined || value.sourceKind === 'provider_request') &&
    ['approval', 'question', 'elicitation'].includes(String(value.kind))
  );
}

function isUserMention(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const handlingProvenanceValid =
    value.handledReason === undefined && value.handledAt === undefined
      ? true
      : value.handled === true &&
        ['viewed', 'replied', 'ignored'].includes(String(value.handledReason)) &&
        typeof value.handledAt === 'number' &&
        Number.isSafeInteger(value.handledAt) &&
        value.handledAt >= 0;
  return (
    isNonBlankString(value.threadId) &&
    isNonBlankString(value.messageId) &&
    isNonBlankString(value.catId) &&
    typeof value.content === 'string' &&
    (value.threadTitle === undefined || typeof value.threadTitle === 'string') &&
    (value.expectedRevision === undefined ||
      (typeof value.expectedRevision === 'number' &&
        Number.isSafeInteger(value.expectedRevision) &&
        value.expectedRevision >= 0)) &&
    (value.handled === undefined || typeof value.handled === 'boolean') &&
    handlingProvenanceValid &&
    typeof value.timestamp === 'number' &&
    Number.isFinite(value.timestamp)
  );
}

function isPreferenceCoordinate(value: unknown, decisionRef: string): boolean {
  return (
    isRecord(value) && value.kind === 'mailbox' && value.decisionRef === decisionRef && isNonBlankString(value.version)
  );
}

function isItem(value: unknown): boolean {
  if (!isItemRecord(value)) return false;
  if (
    value.preferenceCoordinate !== undefined &&
    !isPreferenceCoordinate(value.preferenceCoordinate, value.decisionRef)
  )
    return false;
  if (value.runtimeInteraction !== undefined && !isRuntimeInteraction(value.runtimeInteraction)) return false;
  if (value.choiceRequest !== undefined && !isChoiceRequest(value.choiceRequest)) return false;
  if (!isCollectiveAccountabilityItem(value)) return false;
  if (value.collectiveProjectAttention !== undefined) {
    const parsed = collectiveProjectAttentionItemSchema.safeParse(value.collectiveProjectAttention);
    if (
      !parsed.success ||
      value.kind !== 'judgment' ||
      value.linkedNeedsMe.length !== 0 ||
      value.decisionRef !== `${parsed.data.producerId}:${parsed.data.subjectRef}` ||
      value.collectiveAccountabilityRequest !== undefined
    )
      return false;
  }
  if (value.kind === 'user_mention') return isUserMention(value.userMention);
  if (value.approval === undefined) return true;
  return isRecord(value.approval) && isNonBlankString(value.approval.proposalId);
}

function isItemRecord(value: unknown): value is Record<string, unknown> & {
  decisionRef: string;
  kind: string;
  summary: string;
  linkedNeedsMe: unknown[];
} {
  return Boolean(
    isRecord(value) &&
      isNonBlankString(value.decisionRef) &&
      typeof value.kind === 'string' &&
      ITEM_KIND.has(value.kind) &&
      typeof value.summary === 'string' &&
      Array.isArray(value.linkedNeedsMe),
  );
}

function isCollectiveAccountabilityItem(value: Record<string, unknown>): boolean {
  if (value.collectiveAccountabilityRequest === undefined) return true;
  const parsed = collectiveAccountabilityAttentionItemSchema.safeParse(value.collectiveAccountabilityRequest);
  return Boolean(
    parsed.success &&
      value.kind === 'judgment' &&
      Array.isArray(value.linkedNeedsMe) &&
      value.linkedNeedsMe.length === 0 &&
      value.decisionRef === `${parsed.data.producerId}:${parsed.data.subjectRef}`,
  );
}

function hasOwnerIdentity(body: Record<string, unknown>): boolean {
  return isRecord(body.identity) && isNonBlankString(body.identity.ownerUserId);
}

function hasSources(body: Record<string, unknown>): boolean {
  return (
    isRecord(body.sources) &&
    isSourceRead(body.sources.approvals) &&
    isSourceRead(body.sources.needsMe) &&
    (body.sources.collectiveAccountabilityRequests === undefined ||
      (isSourceRead(body.sources.collectiveAccountabilityRequests) &&
        isRecord(body.sources.collectiveAccountabilityRequests) &&
        body.sources.collectiveAccountabilityRequests.coverage ===
          'pending_f290_collective_accountability_requests')) &&
    (body.sources.collectiveProjectAttention === undefined ||
      (isSourceRead(body.sources.collectiveProjectAttention) &&
        isRecord(body.sources.collectiveProjectAttention) &&
        body.sources.collectiveProjectAttention.coverage === 'pending_f290_project_materials_and_dates')) &&
    (body.sources.structuredChoices === undefined || isSourceRead(body.sources.structuredChoices)) &&
    (body.sources.userMentions === undefined || isSourceRead(body.sources.userMentions)) &&
    (body.sources.personalPreferences === undefined || isSourceRead(body.sources.personalPreferences))
  );
}

function itemsMatchSources(body: Record<string, unknown>): boolean {
  if (!Array.isArray(body.items) || !isRecord(body.sources)) return false;
  const accountabilityItems = body.items.filter(
    (item) => isRecord(item) && item.collectiveAccountabilityRequest !== undefined,
  );
  const source = body.sources.collectiveAccountabilityRequests;
  if (accountabilityItems.length && (!isRecord(source) || source.status !== 'available')) return false;
  const projectItems = body.items.filter((item) => isRecord(item) && item.collectiveProjectAttention !== undefined);
  const projectSource = body.sources.collectiveProjectAttention;
  return projectItems.length === 0 || (isRecord(projectSource) && projectSource.status === 'available');
}

function hasConsistency(body: Record<string, unknown>): boolean {
  return (
    isRecord(body.consistency) && (body.consistency.state === 'verified' || body.consistency.state === 'uncertain')
  );
}

function validMentionCounts(body: Record<string, unknown>): boolean {
  if (body.mentionCounts === undefined) return true;
  if (!isRecord(body.mentionCounts)) return false;
  const counts = body.mentionCounts;
  return ['today', 'week', 'earlier', 'handled'].every(
    (key) => Number.isInteger(counts[key]) && (counts[key] as number) >= 0,
  );
}

function hasValidTotal(body: Record<string, unknown>): boolean {
  return (
    validMentionCounts(body) &&
    (body.mentionPeriod === undefined ||
      ['recent', 'today', 'week', 'earlier', 'handled', 'all'].includes(body.mentionPeriod as string)) &&
    (body.totalCount === undefined || (Number.isInteger(body.totalCount) && (body.totalCount as number) >= 0)) &&
    (body.attentionCount === undefined ||
      (Number.isInteger(body.attentionCount) && (body.attentionCount as number) >= 0))
  );
}

function hasPage(body: Record<string, unknown>): boolean {
  return isRecord(body.page) && typeof body.page.hasMore === 'boolean';
}

const PERSONAL_COUNT_FIELDS = [
  'originalTotalCount',
  'visibleTotalCount',
  'ignoredTotalCount',
  'originalAttentionCount',
  'visibleAttentionCount',
  'ignoredAttentionCount',
] as const;

const PERSONAL_GROUPS = ['decisions', 'userMentions', 'other'] as const;
const PERSONAL_PARTITIONS = ['original', 'visible', 'ignored'] as const;

function hasValidPersonalGroupCounts(
  value: unknown,
  totals: { original: number; visible: number; ignored: number },
): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  const counts: Record<(typeof PERSONAL_PARTITIONS)[number], Record<(typeof PERSONAL_GROUPS)[number], number>> = {
    original: { decisions: 0, userMentions: 0, other: 0 },
    visible: { decisions: 0, userMentions: 0, other: 0 },
    ignored: { decisions: 0, userMentions: 0, other: 0 },
  };
  for (const partition of PERSONAL_PARTITIONS) {
    const group = value[partition];
    if (!isRecord(group)) return false;
    let sum = 0;
    for (const key of PERSONAL_GROUPS) {
      const count = group[key];
      if (!Number.isSafeInteger(count) || (count as number) < 0) return false;
      counts[partition][key] = count as number;
      sum += count as number;
    }
    if (sum !== totals[partition]) return false;
  }
  return PERSONAL_GROUPS.every((key) => counts.original[key] === counts.visible[key] + counts.ignored[key]);
}

function hasValidPersonalCounts(view: Record<string, unknown>, body: Record<string, unknown>): boolean {
  const present = PERSONAL_COUNT_FIELDS.filter((field) => view[field] !== undefined);
  if (present.length === 0)
    return view.groupCounts === undefined && body.totalCount === undefined && body.attentionCount === undefined;
  if (present.length !== PERSONAL_COUNT_FIELDS.length || view.preferenceRevision === undefined) return false;
  const counts = PERSONAL_COUNT_FIELDS.map((field) => view[field]);
  if (counts.some((value) => !Number.isSafeInteger(value) || (value as number) < 0)) return false;
  const [originalTotal, visibleTotal, ignoredTotal, originalAttention, visibleAttention, ignoredAttention] =
    counts as number[];
  if (originalTotal !== visibleTotal + ignoredTotal || originalAttention !== visibleAttention + ignoredAttention)
    return false;
  const selectedTotal = view.mode === 'visible' ? visibleTotal : ignoredTotal;
  const selectedAttention = view.mode === 'visible' ? visibleAttention : ignoredAttention;
  return (
    hasValidPersonalGroupCounts(view.groupCounts, {
      original: originalTotal,
      visible: visibleTotal,
      ignored: ignoredTotal,
    }) &&
    body.totalCount === selectedTotal &&
    (body.attentionCount === undefined || body.attentionCount === selectedAttention)
  );
}

function personalItemsHaveCoordinates(items: unknown): boolean {
  return (
    Array.isArray(items) &&
    items.every((item) => isRecord(item) && isPreferenceCoordinate(item.preferenceCoordinate, String(item.decisionRef)))
  );
}

function hasPersonalView(body: Record<string, unknown>): boolean {
  if (body.personalView === undefined) return true;
  if (!isRecord(body.personalView) || !['visible', 'ignored'].includes(String(body.personalView.mode))) return false;
  const view = body.personalView;
  if (!isRecord(body.sources) || !isSourceRead(body.sources.personalPreferences)) return false;
  if (
    view.preferenceRevision !== undefined &&
    (!Number.isSafeInteger(view.preferenceRevision) || (view.preferenceRevision as number) < 0)
  )
    return false;
  return personalItemsHaveCoordinates(body.items) && hasValidPersonalCounts(view, body);
}

export function parseUnifiedAttentionRead(body: unknown): UnifiedAttentionReadV1 | null {
  if (!isRecord(body) || body.version !== 1 || body.scope !== 'owner_all_projects') return null;
  if (typeof body.status !== 'string' || !OVERALL_STATUS.has(body.status)) return null;
  if (!Array.isArray(body.items) || !body.items.every(isItem)) return null;
  const structurallyValid =
    hasOwnerIdentity(body) &&
    hasSources(body) &&
    itemsMatchSources(body) &&
    hasConsistency(body) &&
    hasValidTotal(body) &&
    hasPage(body) &&
    hasPersonalView(body);
  return structurallyValid ? (body as unknown as UnifiedAttentionReadV1) : null;
}
