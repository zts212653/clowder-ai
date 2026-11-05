import { CONTRACT_THREAD_ID } from './f311-workspace-browser.harness.mjs';

export const PROGRAM_ID = 'evolution-program:ba0f4524e49cc879279164d5b272cf8c';
export const PROPOSAL_ID = 'f311-isolated-request-review-candidate';
export const CURRENT_VERSION = {
  ownerFeatureId: 'F100',
  ownerStateRef: 'skill:cat-cafe-skills/request-review/SKILL.md',
  version: 'a'.repeat(64),
  assetKind: 'skill',
  assetId: 'cat-cafe-skills/request-review/SKILL.md',
};
export const CANDIDATE_VERSION = { ...CURRENT_VERSION, version: 'b'.repeat(64) };

const sourceRef = (state, version) => ({
  ownerFeatureId: 'F100',
  ownerStateRef: state,
  ...(version ? { version } : {}),
});

export function pendingProjection(snapshot) {
  const projection = structuredClone(snapshot);
  const current = {
    caseRef: { ownerFeatureId: 'F266', ownerStateRef: 'eval-repair-case:f311-isolated-candidate' },
    proposalRef: { ownerFeatureId: 'F266', ownerStateRef: `eval-repair-proposal:${PROPOSAL_ID}` },
    ownerAuthorizationRef: sourceRef('execution-permission:f311-isolated-candidate'),
    targetVersionRef: CANDIDATE_VERSION,
    status: 'pending',
  };
  projection.lineage = { cycles: [{ cycle: 1, changes: [current] }], current };
  return projection;
}

export function approvalItem() {
  const decisionExplanation = {
    schemaVersion: 1,
    expectedChange: '让后续审阅结果显示它实际沿用的规则版本',
    beforeSummary: '后续结果没有可追溯的规则来源',
    afterSummary: '后续结果显示 exact version，并从原项目进入治理操作',
    changeSetSummary: '真实使用回执、持久来源和 Chat 阅读入口作为一组成套改动',
    attributionBoundary: '只证明当前任务使用了该版本；不证明候选已获批准或整体交付改善',
    independentVerification: '隔离旅程核对真实入口、状态恢复和零 Program 写入',
    rejectedCandidates: ['从回复文案推断版本', '打开候选后立即写成已采用'],
    costAndRollback: '来源行可移除；回退动作仍由 Program owner 执行',
  };
  return {
    proposalId: PROPOSAL_ID,
    sourceFeatureId: 'F266',
    requesterCatId: 'codex-sol',
    ownerUserId: 'default-user',
    summary: '隔离夹具 · request-review 来源提示候选',
    detail: {
      expectedChange: decisionExplanation.expectedChange,
      costAndRollback: decisionExplanation.costAndRollback,
      decisionExplanation,
      withdrawalCondition: 'exact target、owner 或授权变化时撤回',
      targetVersionRef: CANDIDATE_VERSION,
      ownerRef: sourceRef('request-review-owner:isolated-fixture'),
      ownerAuthorizationRef: sourceRef('request-review-authorization:isolated-fixture'),
    },
    navigation: {
      state: 'anchored',
      originRef: { kind: 'message', threadId: CONTRACT_THREAD_ID, messageId: 'f311-candidate-origin' },
      approvalCardRef: { threadId: CONTRACT_THREAD_ID, messageId: 'f311-candidate-card' },
    },
    inlineApprovable: true,
    decisionMode: 'approve-reject',
    createdAt: Date.parse('2026-10-14T18:00:00.000Z'),
    resolution: 'open',
    materialization: { state: 'not_started' },
  };
}

export function unifiedAttention(item) {
  const source = {
    status: 'available',
    startedAt: 1,
    observedAt: 3,
    coverage: 'all_registered_F246_producers',
    exhaustiveness: 'complete',
  };
  const { ownerUserId: _owner, ...approval } = item;
  return {
    version: 1,
    status: 'available',
    scope: 'owner_all_projects',
    identity: { ownerUserId: item.ownerUserId },
    observedAt: 3,
    sources: {
      approvals: source,
      needsMe: { ...source, coverage: 'current_linked_F310_five_producers' },
      structuredChoices: { ...source, coverage: 'pending_f306_structured_choices' },
      personalPreferences: { ...source, coverage: 'owner_personal_ignored_items' },
    },
    readWindow: { startedAt: 1, endedAt: 3, consistency: 'independent_source_reads' },
    consistency: { state: 'verified', reasons: [] },
    items: [
      {
        decisionRef: `approval:F266:${item.proposalId}`,
        kind: 'approval',
        summary: item.summary,
        approval,
        linkedNeedsMe: [],
        preferenceCoordinate: {
          kind: 'mailbox',
          decisionRef: `approval:F266:${item.proposalId}`,
          version: 'sha256:f311-isolated-visible-decision',
        },
      },
    ],
    totalCount: 1,
    attentionCount: 1,
    personalView: {
      mode: 'visible',
      preferenceRevision: 1,
      originalTotalCount: 1,
      visibleTotalCount: 1,
      ignoredTotalCount: 0,
      originalAttentionCount: 1,
      visibleAttentionCount: 1,
      ignoredAttentionCount: 0,
      groupCounts: {
        original: { decisions: 1, userMentions: 0, other: 0 },
        visible: { decisions: 1, userMentions: 0, other: 0 },
        ignored: { decisions: 0, userMentions: 0, other: 0 },
      },
    },
    page: { offset: 0, limit: 20, scope: 'known_rows', hasMore: false },
  };
}

export function assetReview(url, projection) {
  const selectedRaw = url.searchParams.get('selectedVersionRef');
  const selected = selectedRaw ? JSON.parse(selectedRaw) : undefined;
  const matches = (ref, other) =>
    ref &&
    other &&
    ref.ownerFeatureId === other.ownerFeatureId &&
    ref.ownerStateRef === other.ownerStateRef &&
    ref.version === other.version &&
    ref.assetKind === other.assetKind &&
    ref.assetId === other.assetId;
  const versions = [
    { versionRef: CURRENT_VERSION, title: '当前 request-review 规则', parentEdges: [] },
    {
      versionRef: CANDIDATE_VERSION,
      title: '待判断的来源提示候选',
      parentEdges: [
        {
          parentVersionRef: CURRENT_VERSION,
          edgeRef: sourceRef('git-parent:isolated-current:candidate'),
        },
      ],
    },
  ];
  const selectedVersion = versions.find((entry) => matches(entry.versionRef, selected));
  return {
    schemaVersion: 1,
    status: 'resolved',
    programRef: { ownerFeatureId: 'F311', ownerStateRef: PROGRAM_ID },
    objectRef: projection.program.objectRef,
    sourceRef: sourceRef('request-review-owner:isolated-fixture'),
    readAt: '2026-10-14T18:00:00.000Z',
    currentVersionRefs: [CURRENT_VERSION],
    currentProofRef: sourceRef('request-review-current:isolated-fixture'),
    versions,
    ...(selectedVersion
      ? {
          selected: {
            versionRef: selectedVersion.versionRef,
            diff: {
              status: 'available',
              comparedToVersionRef: CURRENT_VERSION,
              summary: matches(selectedVersion.versionRef, CURRENT_VERSION)
                ? '当前规则版本。'
                : '隔离候选；尚未批准或生效。',
              rawDiffRef: sourceRef('git-diff:isolated-fixture'),
            },
            evidence: [],
            uses: [],
          },
        }
      : {}),
    blockers: [],
  };
}

export function laterTaskMessage(show) {
  if (!show) return { messages: [], hasMore: false };
  return {
    messages: [
      {
        id: 'f311-later-task-result',
        from: { kind: 'agent', catId: 'codex-sol' },
        type: 'assistant',
        catId: 'codex-sol',
        content: '已完成本次独立审阅；结论与证据保留在原任务。',
        origin: 'callback',
        timestamp: Date.parse('2026-10-14T18:30:00.000Z'),
        extra: {
          evolutionUseSourceV1: {
            schemaVersion: 1,
            programId: PROGRAM_ID,
            assetVersionRef: CURRENT_VERSION,
            receiptRef: sourceRef('request-review-use:isolated-receipt'),
            use: 'applied',
            recordedAt: '2026-10-14T18:30:00.000Z',
          },
        },
      },
    ],
    hasMore: false,
  };
}
