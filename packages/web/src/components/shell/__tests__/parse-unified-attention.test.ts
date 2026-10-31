import { describe, expect, it } from 'vitest';
import { parseUnifiedAttentionRead } from '../parse-unified-attention';

const source = (overrides: Record<string, unknown> = {}) => ({
  status: 'available',
  startedAt: 1,
  observedAt: 2,
  coverage: 'all_registered_F246_producers',
  exhaustiveness: 'complete',
  ...overrides,
});

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    status: 'available',
    scope: 'owner_all_projects',
    identity: { ownerUserId: 'owner-1' },
    observedAt: 3,
    sources: { approvals: source(), needsMe: source({ coverage: 'current_linked_F310_five_producers' }) },
    readWindow: { startedAt: 1, endedAt: 3, consistency: 'independent_source_reads' },
    consistency: { state: 'verified', reasons: [] },
    items: [
      {
        decisionRef: 'approval:F309:p1',
        kind: 'approval',
        summary: '一件',
        linkedNeedsMe: [],
        approval: { proposalId: 'p1', sourceFeatureId: 'F309' },
      },
    ],
    totalCount: 1,
    page: { offset: 0, limit: 20, scope: 'known_rows', hasMore: false },
    ...overrides,
  };
}

function personalBody(personalOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  return body({
    attentionCount: 1,
    sources: {
      approvals: source(),
      needsMe: source({ coverage: 'current_linked_F310_five_producers' }),
      personalPreferences: source({ coverage: 'owner_personal_ignored_items' }),
    },
    items: [
      {
        decisionRef: 'approval:F221:p1',
        kind: 'approval',
        summary: '一件',
        linkedNeedsMe: [],
        approval: { proposalId: 'p1', sourceFeatureId: 'F221' },
        preferenceCoordinate: {
          kind: 'mailbox',
          decisionRef: 'approval:F221:p1',
          version: 'sha256:abc',
        },
      },
    ],
    personalView: {
      mode: 'visible',
      preferenceRevision: 3,
      originalTotalCount: 2,
      visibleTotalCount: 1,
      ignoredTotalCount: 1,
      originalAttentionCount: 2,
      visibleAttentionCount: 1,
      ignoredAttentionCount: 1,
      groupCounts: {
        original: { decisions: 2, userMentions: 0, other: 0 },
        visible: { decisions: 1, userMentions: 0, other: 0 },
        ignored: { decisions: 1, userMentions: 0, other: 0 },
      },
      ...personalOverrides,
    },
  });
}

describe('parseUnifiedAttentionRead — a body is a read only if it is a version-1 read', () => {
  it('accepts a well-formed read and keeps extra fields the producer may add', () => {
    const parsed = parseUnifiedAttentionRead(body({ approvalCount: 1, futureField: true }));
    expect(parsed?.identity.ownerUserId).toBe('owner-1');
    expect(parsed?.totalCount).toBe(1);
    expect(parsed?.items).toHaveLength(1);
  });

  it('accepts a read with no totalCount and with no approval on an item', () => {
    const parsed = parseUnifiedAttentionRead(
      body({
        totalCount: undefined,
        items: [{ decisionRef: 'f306:s:1', kind: 'judgment', summary: 's', linkedNeedsMe: [] }],
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.totalCount).toBeUndefined();
  });

  it('accepts a canonical pending-question coordinate', () => {
    const parsed = parseUnifiedAttentionRead(
      body({
        items: [
          {
            decisionRef: 'f306.runtime_interaction:choice-1',
            kind: 'judgment',
            summary: '在哪里验收？',
            linkedNeedsMe: [],
            choiceRequest: {
              interactionId: 'choice-1',
              revision: 20,
              requesterCatId: 'codex-sol',
              createdAt: 10,
              title: '选择环境',
              questions: [{ id: 'env', header: '环境', question: '在哪里验收？' }],
              cardRef: { threadId: 'thread-1', messageId: 'message-1', blockId: 'card-1' },
            },
          },
        ],
      }),
    );
    expect(parsed?.items[0]?.choiceRequest?.cardRef.blockId).toBe('card-1');
  });

  it('accepts only a canonical pending Collective responsibility request with its declared source', () => {
    const request = {
      producerId: 'f290.collective_work_accountability_request',
      subjectRef: 'collective-accountability-request:svc_abcdefgh:col_abcdefgh:work_abcdefgh:accountability_abcdefgh',
      serviceInstanceId: 'svc_abcdefgh',
      collectiveId: 'col_abcdefgh',
      connectionId: 'con_abcdefgh',
      workId: 'work_abcdefgh',
      workRevision: 2,
      accountabilityRequestId: 'accountability_abcdefgh',
      targetHumanId: 'human_abcdefgh',
      targetDisplayName: 'WuLang',
      requestedByHumanId: 'human_requester',
      requestedByDisplayName: 'You',
      requestEventId: 'evt_request000',
      requestedAt: '2026-10-18T12:00:00.000Z',
      status: 'pending',
      roadmapId: 'roadmap_abcdefgh',
      projectTitle: '共同项目',
      channelId: 'general',
      workSourceEventId: 'evt_source0000',
      workTitle: '完成接责验收',
      actionRef:
        '/collective?target=accountability&connectionId=con_abcdefgh&workId=work_abcdefgh&workRevision=2&channelId=general&roadmapId=roadmap_abcdefgh&accountabilityRequestId=accountability_abcdefgh',
      expectedProducerRevision: 2,
    };
    const item = {
      decisionRef: `${request.producerId}:${request.subjectRef}`,
      kind: 'judgment',
      summary: 'You 邀请你负责',
      linkedNeedsMe: [],
      collectiveAccountabilityRequest: request,
    };
    const input = body({
      sources: {
        approvals: source(),
        needsMe: source({ coverage: 'current_linked_F310_five_producers' }),
        collectiveAccountabilityRequests: source({ coverage: 'pending_f290_collective_accountability_requests' }),
      },
      items: [item],
    });
    expect(parseUnifiedAttentionRead(input)?.items[0]?.collectiveAccountabilityRequest).toEqual(request);
    expect(
      parseUnifiedAttentionRead({
        ...input,
        sources: { approvals: source(), needsMe: source({ coverage: 'current_linked_F310_five_producers' }) },
      }),
    ).toBeNull();
    const stale = structuredClone(input);
    (stale.items as (typeof item)[])[0].collectiveAccountabilityRequest.expectedProducerRevision = 1;
    expect(parseUnifiedAttentionRead(stale)).toBeNull();
  });

  it('keeps the publication proof on a canonical provider question instead of rejecting the entire read', () => {
    const cardRef = {
      threadId: 'thread-1',
      messageId: 'message-1',
      blockId: 'card-1',
      blockDigest: 'a'.repeat(64),
      publishedAt: 10,
    };
    const input = body({
      items: [
        {
          decisionRef: 'f306.runtime_interaction:choice-1',
          kind: 'judgment',
          summary: 'Where should this run?',
          linkedNeedsMe: [],
          choiceRequest: {
            interactionId: 'choice-1',
            revision: 20,
            requesterCatId: 'codex61-sol',
            createdAt: 10,
            title: 'Choose an environment',
            questions: [{ id: 'env', header: 'Environment', question: 'Where should this run?' }],
            cardRef,
          },
        },
      ],
    });
    expect(parseUnifiedAttentionRead(input)?.items[0]?.choiceRequest?.cardRef).toEqual(cardRef);
    for (const invalid of [
      { blockDigest: 'not-a-digest' },
      { publishedAt: -1 },
      { publishedAt: Number.MAX_SAFE_INTEGER + 1 },
      { unknownProof: true },
    ]) {
      const broken = structuredClone(input);
      Object.assign((broken.items as { choiceRequest: { cardRef: object } }[])[0].choiceRequest.cardRef, invalid);
      expect(parseUnifiedAttentionRead(broken)).toBeNull();
    }
  });

  it('accepts typed @you handling provenance and rejects invented reasons', () => {
    const mention = {
      decisionRef: 'user-mention-handled:thread-1:message-1',
      kind: 'user_mention',
      summary: '对话中的请求',
      linkedNeedsMe: [],
      userMention: {
        threadId: 'thread-1',
        messageId: 'message-1',
        catId: 'codex-sol',
        content: '@you',
        timestamp: 10,
        handled: true,
        handledReason: 'viewed',
        handledAt: 20,
      },
    };
    expect(parseUnifiedAttentionRead(body({ items: [mention] }))?.items[0]?.userMention?.handledReason).toBe('viewed');
    expect(
      parseUnifiedAttentionRead(
        body({ items: [{ ...mention, userMention: { ...mention.userMention, handledReason: 'opened' } }] }),
      ),
    ).toBeNull();
    expect(
      parseUnifiedAttentionRead(
        body({ items: [{ ...mention, userMention: { ...mention.userMention, handledAt: undefined } }] }),
      ),
    ).toBeNull();
  });

  it('accepts an exact owner-personal view and keeps its mailbox coordinate and full-set counts', () => {
    const parsed = parseUnifiedAttentionRead(personalBody());
    expect(parsed?.personalView?.ignoredTotalCount).toBe(1);
    expect(parsed?.personalView?.groupCounts?.original.userMentions).toBe(0);
    expect(parsed?.items[0]?.preferenceCoordinate?.version).toBe('sha256:abc');
  });

  it.each([
    [
      'group counts without exact personal counts',
      body({
        sources: {
          approvals: source(),
          needsMe: source({ coverage: 'current_linked_F310_five_producers' }),
          personalPreferences: source({ coverage: 'owner_personal_ignored_items' }),
        },
        items: [],
        totalCount: undefined,
        personalView: {
          mode: 'visible',
          groupCounts: {
            original: { decisions: 0, userMentions: 0, other: 0 },
            visible: { decisions: 0, userMentions: 0, other: 0 },
            ignored: { decisions: 0, userMentions: 0, other: 0 },
          },
        },
      }),
    ],
    [
      'a group sum that contradicts the total',
      personalBody({
        groupCounts: {
          original: { decisions: 2, userMentions: 1, other: 0 },
          visible: { decisions: 1, userMentions: 0, other: 0 },
          ignored: { decisions: 1, userMentions: 1, other: 0 },
        },
      }),
    ],
    [
      'group partitions that do not add back to original',
      personalBody({
        groupCounts: {
          original: { decisions: 2, userMentions: 0, other: 0 },
          visible: { decisions: 1, userMentions: 0, other: 0 },
          ignored: { decisions: 0, userMentions: 0, other: 0 },
        },
      }),
    ],
  ])('rejects %s', (_label, input) => {
    expect(parseUnifiedAttentionRead(input)).toBeNull();
  });

  it.each([
    ['not an object', 'nope'],
    ['null', null],
    ['an array', []],
    ['another version', body({ version: 2 })],
    ['an unknown overall status', body({ status: 'ok' })],
    ['a missing owner identity', body({ identity: {} })],
    ['a blank owner identity', body({ identity: { ownerUserId: ' ' } })],
    ['a different scope', body({ scope: 'one_project' })],
    ['a missing source', body({ sources: { approvals: source() } })],
    ['an unknown source status', body({ sources: { approvals: source({ status: 'fine' }), needsMe: source() } })],
    [
      'an unknown exhaustiveness',
      body({ sources: { approvals: source({ exhaustiveness: 'all' }), needsMe: source() } }),
    ],
    ['an unknown consistency', body({ consistency: { state: 'maybe', reasons: [] } })],
    ['items that are not an array', body({ items: {} })],
    ['an item with no decisionRef', body({ items: [{ kind: 'approval', summary: 's', linkedNeedsMe: [] }] })],
    [
      'an item of an unknown kind',
      body({ items: [{ decisionRef: 'x', kind: 'chat', summary: 's', linkedNeedsMe: [] }] }),
    ],
    [
      'an item whose linkedNeedsMe is not an array',
      body({ items: [{ decisionRef: 'x', kind: 'repair', summary: 's' }] }),
    ],
    [
      'an approval with no proposalId',
      body({ items: [{ decisionRef: 'x', kind: 'approval', summary: 's', linkedNeedsMe: [], approval: {} }] }),
    ],
    ['a negative attentionCount', body({ attentionCount: -1 })],
    [
      'a malformed mailbox preference coordinate',
      body({
        items: [
          {
            decisionRef: 'approval:F221:p1',
            kind: 'approval',
            summary: '一件',
            linkedNeedsMe: [],
            approval: { proposalId: 'p1' },
            preferenceCoordinate: { kind: 'mailbox', decisionRef: 'approval:F221:p1', version: ' ' },
          },
        ],
      }),
    ],
    [
      'a personal view without its preference source',
      body({ personalView: { mode: 'visible', preferenceRevision: 0 } }),
    ],
    [
      'a personal view with a negative full-set count',
      body({
        sources: {
          approvals: source(),
          needsMe: source({ coverage: 'current_linked_F310_five_producers' }),
          personalPreferences: source({ coverage: 'owner_personal_ignored_items' }),
        },
        personalView: { mode: 'ignored', preferenceRevision: 1, ignoredTotalCount: -1 },
      }),
    ],
    [
      'a malformed choice-card coordinate',
      body({
        items: [
          {
            decisionRef: 'f306.runtime_interaction:choice-1',
            kind: 'judgment',
            summary: 's',
            linkedNeedsMe: [],
            choiceRequest: {
              interactionId: 'choice-1',
              revision: 20,
              requesterCatId: 'codex-sol',
              createdAt: 10,
              title: '选择环境',
              questions: [{ id: 'env', header: '环境', question: '在哪里验收？' }],
              cardRef: { threadId: 'thread-1', messageId: 'message-1', blockId: ' ' },
            },
          },
        ],
      }),
    ],
    [
      'a malformed structured-choice source',
      body({
        sources: {
          approvals: source(),
          needsMe: source({ coverage: 'current_linked_F310_five_producers' }),
          structuredChoices: { status: 'available' },
        },
      }),
    ],
    ['malformed mention counts', body({ mentionCounts: { today: 0, week: 0, earlier: '558', handled: 0 } })],
    ['an unknown mention filter', body({ mentionPeriod: 'urgent' })],
    ['a negative totalCount', body({ totalCount: -1 })],
    ['a fractional totalCount', body({ totalCount: 1.5 })],
    ['a missing page', body({ page: undefined })],
  ])('rejects %s, so it can never be read as an empty success', (_label, input) => {
    expect(parseUnifiedAttentionRead(input)).toBeNull();
  });
});

it('the all-time window retains the canonical four mention counters; it does not invent a fifth count', () => {
  const read = body({ mentionPeriod: 'all', mentionCounts: { today: 1, week: 2, earlier: 3, handled: 4 } });
  expect(parseUnifiedAttentionRead(read)?.mentionPeriod).toBe('all');
  expect(parseUnifiedAttentionRead(read)?.mentionCounts).toEqual({ today: 1, week: 2, earlier: 3, handled: 4 });
});
