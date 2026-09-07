export const THREAD_ID = 'thread-f307-real-surface-adapters';
export const OTHER_THREAD_ID = 'thread-f307-owner-b';
export const WORKTREE_ID = 'worktree-f307-phase-c';
export const OTHER_WORKTREE_ID = 'worktree-f307-owner-b';
export const FILE_PATH = 'docs/features/F307-composable-workbench.md';
export const INVOCATION_ID = 'inv-f307-real-run';
export const SESSION_ID = 'session-f307-real-run';
export const EVOLUTION_PROGRAM_ID = `evolution-program:${'e'.repeat(32)}`;

export const evolutionProgramProjection = {
  program: {
    schemaVersion: 1,
    programId: EVOLUTION_PROGRAM_ID,
    workspaceId: 'user:f307-real-adapter-user',
    objectRef: { ownerFeatureId: 'F311', ownerStateRef: 'capability:development-process-harness-effectiveness' },
    claimRef: { ownerFeatureId: 'F311', ownerStateRef: `evolution-claim:${EVOLUTION_PROGRAM_ID}` },
    certificates: {},
    measurementRoleRefs: {},
    currentAssetVersionRefs: [],
    lifecycle: 'active',
    stage: 'constituting',
    cycle: 1,
    sequence: 1,
    createdAt: '2026-09-04T08:42:00.000Z',
    updatedAt: '2026-09-04T08:42:00.000Z',
  },
  cycles: [
    {
      programId: EVOLUTION_PROGRAM_ID,
      cycle: 1,
      stage: 'constituting',
      lineageRefIds: [
        'capability:development-process-harness-effectiveness',
        `evolution-claim:${EVOLUTION_PROGRAM_ID}`,
      ],
      openedAt: '2026-09-04T08:42:00.000Z',
    },
  ],
  drafts: {
    goal: { ownerFeatureId: 'F311', ownerStateRef: `evolution-goal-draft:${EVOLUTION_PROGRAM_ID}` },
    claim: { ownerFeatureId: 'F311', ownerStateRef: `evolution-claim-draft:${EVOLUTION_PROGRAM_ID}` },
    measurement: { ownerFeatureId: 'F267', ownerStateRef: `evolution-measurement-draft:${EVOLUTION_PROGRAM_ID}` },
    economic: { ownerFeatureId: 'F311', ownerStateRef: `evolution-economic-draft:${EVOLUTION_PROGRAM_ID}` },
    roles: {
      observer: { ownerFeatureId: 'F267', ownerStateRef: `evolution-role-draft:${EVOLUTION_PROGRAM_ID}:observer` },
      calibrator: { ownerFeatureId: 'F267', ownerStateRef: `evolution-role-draft:${EVOLUTION_PROGRAM_ID}:calibrator` },
    },
  },
  blockers: [
    {
      code: 'measurement_certificate_missing',
      message: 'Measurement certificate remains owned by F267.',
      ownerFeatureId: 'F267',
    },
  ],
  nextAction: { code: 'complete_constitution', label: '继续自动建制' },
  observation: {
    status: 'connected',
    trajectory: {
      ref: { ownerFeatureId: 'F299', ownerStateRef: `inv:${INVOCATION_ID}` },
      invocationId: INVOCATION_ID,
      threadId: THREAD_ID,
    },
    connectedEyes: [
      {
        sourceKind: 'human-disposition',
        ownerSurfaceRef: { ownerFeatureId: 'F281', ownerStateRef: 'human-disposition:f307-main-attention' },
        joinKey: 'message:f307-main-attention',
        namedConsumerRef: { ownerFeatureId: 'F311', ownerStateRef: 'evolution-consumer:program' },
        instrumentationRef: { ownerFeatureId: 'F281', ownerStateRef: 'instrumentation:human-disposition-v1' },
        ownerHref: '/api/human-disposition-feedback/episodes?subjectRef=f307-main-attention',
      },
    ],
    gaps: [],
    trigger: {
      registrationRef: { ownerFeatureId: 'F192', ownerStateRef: 'eval-domain:eval:capability-evolution' },
      channels: ['event', 'quota', 'time'],
    },
    nextEvaluationAt: '2026-09-05T08:42:00.000Z',
  },
  attribution: null,
  lineage: { cycles: [{ cycle: 1, changes: [] }] },
};

export const invocationSummary = {
  invocationId: INVOCATION_ID,
  threadId: THREAD_ID,
  sessionId: SESSION_ID,
  sessionSeq: 1,
  sessionStatus: 'active',
  catId: 'codex-sol',
  status: 'running',
  startedAt: 1_787_831_703_606,
  durationMs: 4_000,
  eventCount: 1,
  statusEventCount: 1,
  toolUseCount: 0,
  toolResultCount: 0,
  messageCount: 1,
  errorCount: 0,
  toolNames: [],
  keyMessages: ['real owner-backed Agent Run'],
};

const artifacts = [
  {
    type: 'code',
    name: 'real-surface-adapters.ts',
    catId: 'codex-sol',
    createdAt: 1_787_831_702_000,
    sourceMessageId: 'message-real-adapter',
    ref: 'packages/web/src/components/workbench/real-surface-adapters.ts',
  },
  {
    type: 'pr',
    name: 'PR #307 Real Surface Adapters',
    catId: 'codex-terra',
    createdAt: 1_787_831_701_000,
    sourceMessageId: 'message-real-review',
    ref: 'owner/cat-cafe#307',
  },
];

const otherArtifacts = [
  {
    type: 'code',
    name: 'owner-b.ts',
    catId: 'codex-terra',
    createdAt: 1_787_831_703_000,
    sourceMessageId: 'message-owner-b',
    ref: 'packages/web/src/owner-b.ts',
  },
];

const needsMeApprovalOwnerRead = {
  envelope: {
    subjectRef: 'task:work:f307-inline-approval',
    ownerRef: 'task:item:f307-inline-approval',
    admissionReceiptRef: 'task:receipt:f307-inline-approval:4',
    sourceRefs: ['message:thread-f307-real-surface-adapters:source-inline-approval'],
    revision: 4,
    freshness: { state: 'current', observedRevision: 4 },
    visibility: { ownerUserId: 'f307-real-adapter-user', human: true, cat: true },
  },
  brief: {
    outcome: { state: 'unknown' },
    current: { state: 'doing', ownerRef: 'task:item:f307-inline-approval', revision: 4 },
    verifiedMilestone: { kind: 'needs_judgment', evidenceRef: 'approval:proposal/one', revision: 7 },
    nextOwner: {
      kind: 'human',
      ownerRef: 'user:f307-real-adapter-user',
      evidence: [{ producerId: 'f246.approval', ownerRef: 'approval:proposal/one', revision: 7 }],
    },
    needsMe: {
      state: 'needed',
      evidence: [{ producerId: 'f246.approval', ownerRef: 'approval:proposal/one', revision: 7 }],
    },
  },
  preparedArtifact: {
    artifactRef: 'packages/web/src/components/ActivityBar.tsx',
    artifactRevision: '4',
    completenessRef: 'packages/web/src/components/ActivityBar.tsx#available:4',
    previewRef: 'packages/web/src/components/ActivityBar.tsx#preview:4',
    openInWorkspaceRef: 'workspace:artifact:thread-f307-real-surface-adapters:4:ActivityBar.tsx',
  },
  timeRefs: [],
  attentionReceipts: [
    {
      eligible: true,
      producer: {
        producerId: 'f246.approval',
        ownerRef: 'approval:proposal/one',
        subjectRef: 'approval:proposal/one',
        revision: 7,
      },
      taskRef: { subjectRef: 'task:work:f307-inline-approval', observedRevision: 4 },
      kind: 'judgment',
      reasonCode: 'approval_required',
      recommendation: 'Review the inline Approval owner surface',
      salience: 'normal',
      action: { actionRef: '/api/proposals/proposal%2Fone', expectedProducerRevision: 7 },
      reEvaluateActionRef: 'approval:proposal/one#reevaluate',
    },
  ],
};

export function activeExecutionFixture(enabled) {
  return {
    projectPath: '/project/cat-cafe',
    executions: enabled
      ? [
          {
            executionId: INVOCATION_ID,
            threadId: THREAD_ID,
            threadTitle: 'F307 Real Surface Adapters',
            catId: 'codex-sol',
            kind: 'live_invocation',
            startedAt: invocationSummary.startedAt,
            cancelability: { state: 'not_cancelable', reason: 'foreign_principal' },
          },
        ]
      : [],
  };
}

export function fixedFixture(pathname) {
  const fixtures = new Map([
    ['/api/session', { userId: 'f307-real-adapter-user' }],
    ['/api/health', { status: 'ok' }],
    ['/api/ready', { status: 'ok' }],
    ['/api/agent-hooks/status', { status: 'ready', targets: [] }],
    ['/api/approval-hub/pending', { items: [], count: 0 }],
    ['/api/approval-hub/settled', { items: [], count: 0 }],
    ['/api/entrusted-work/owner-reads', { ownerReads: [] }],
    ['/api/entrusted-work/needs-me', { ownerReads: [needsMeApprovalOwnerRead] }],
    [
      '/api/cats',
      {
        cats: [
          {
            id: 'codex-sol',
            displayName: '小太阳·砚砚',
            color: { primary: 'var(--color-codex-primary)', secondary: 'var(--color-codex-bg)' },
            mentionPatterns: ['@codex-sol'],
            clientId: 'openai',
            defaultModel: 'gpt-5.6-sol',
            avatar: '',
            roleDescription: '',
            personality: '',
            roster: { available: true },
          },
          {
            id: 'codex-terra',
            displayName: '小团团·砚砚',
            color: { primary: 'var(--color-codex-primary)', secondary: 'var(--color-codex-bg)' },
            mentionPatterns: ['@codex-terra'],
            clientId: 'openai',
            defaultModel: 'gpt-5.6-terra',
            avatar: '',
            roleDescription: '',
            personality: '',
            roster: { available: true },
          },
        ],
      },
    ],
    ['/api/config/cat-order', { catOrder: ['codex-sol', 'codex-terra'] }],
    ['/api/messages', { messages: [], hasMore: false }],
    ['/api/tasks', { tasks: [] }],
    ['/api/bootcamp/threads', { threads: [] }],
    ['/api/capability-evolution/programs', { programs: [evolutionProgramProjection] }],
    [`/api/capability-evolution/programs/${encodeURIComponent(EVOLUTION_PROGRAM_ID)}`, evolutionProgramProjection],
    [
      '/api/threads',
      {
        threads: [
          { id: THREAD_ID, title: 'F307 Real Surface Adapters', projectPath: '/project/cat-cafe' },
          { id: OTHER_THREAD_ID, title: 'Owner B', projectPath: '/project/cat-cafe-b' },
        ],
      },
    ],
    [
      `/api/threads/${THREAD_ID}`,
      { id: THREAD_ID, title: 'F307 Real Surface Adapters', projectPath: '/project/cat-cafe' },
    ],
    [`/api/threads/${THREAD_ID}/sessions`, { sessions: [] }],
    [`/api/threads/${THREAD_ID}/artifacts`, { threadId: THREAD_ID, artifacts }],
    [`/api/threads/${OTHER_THREAD_ID}`, { id: OTHER_THREAD_ID, title: 'Owner B', projectPath: '/project/cat-cafe-b' }],
    [`/api/threads/${OTHER_THREAD_ID}/artifacts`, { threadId: OTHER_THREAD_ID, artifacts: otherArtifacts }],
    [
      '/api/artifacts',
      {
        artifacts: otherArtifacts.map((artifact) => ({
          ...artifact,
          threadId: OTHER_THREAD_ID,
          threadTitle: 'Owner B',
        })),
        total: otherArtifacts.length,
      },
    ],
    [
      `/api/invocations/${INVOCATION_ID}/trajectory`,
      { invocationId: INVOCATION_ID, threadId: THREAD_ID, sessionId: SESSION_ID },
    ],
    [
      `/api/sessions/${SESSION_ID}/invocations/${INVOCATION_ID}`,
      {
        invocationId: INVOCATION_ID,
        total: 1,
        summary: invocationSummary,
        events: [
          {
            v: 1,
            t: invocationSummary.startedAt,
            threadId: THREAD_ID,
            catId: 'codex-sol',
            sessionId: SESSION_ID,
            invocationId: INVOCATION_ID,
            eventNo: 0,
            event: { type: 'text', content: 'real owner-backed Agent Run' },
          },
        ],
      },
    ],
  ]);
  return fixtures.get(pathname);
}

function executionResponse(pathname, exposeBackgroundRun) {
  if (pathname === '/api/executions/active') {
    return { body: activeExecutionFixture(exposeBackgroundRun) };
  }
  if (pathname === `/api/threads/${THREAD_ID}/invocations`) {
    return { body: { total: 1, invocations: [invocationSummary] } };
  }
  if (pathname === `/api/invocations/${INVOCATION_ID}/request-generations`) {
    return { body: { invocationId: INVOCATION_ID, threadId: THREAD_ID, generations: [], gaps: [] } };
  }
}

function workspaceResponse(url, method) {
  if (url.pathname === '/api/workspace/worktrees') {
    const ownerB = url.searchParams.get('repoRoot') === '/project/cat-cafe-b';
    return {
      body: {
        worktrees: ownerB
          ? [
              {
                id: OTHER_WORKTREE_ID,
                root: '/project/cat-cafe-b',
                branch: 'main',
                head: 'ownerb307',
              },
            ]
          : [
              {
                id: WORKTREE_ID,
                root: '/project/cat-cafe',
                branch: 'feat/f307-phase-c',
                head: 'abc307',
              },
              {
                id: OTHER_WORKTREE_ID,
                root: '/project/cat-cafe-feature',
                branch: 'fix/f307-worktree-selector',
                head: 'def307',
              },
            ],
      },
    };
  }
  if (url.pathname === '/api/workspace/tree') {
    return { body: { tree: [{ name: 'F307-composable-workbench.md', path: FILE_PATH, type: 'file' }] } };
  }
  if (url.pathname === '/api/workspace/search') {
    return {
      body: {
        results: [
          {
            path: 'src/F307-search-result.ts',
            line: 120,
            content: 'Composable Workbench',
            contextBefore: '',
            contextAfter: '',
          },
        ],
      },
    };
  }
  if (url.pathname === '/api/workspace/file') {
    const worktreeId = url.searchParams.get('worktreeId') ?? WORKTREE_ID;
    const requestedPath = url.searchParams.get('path') ?? FILE_PATH;
    const ownerLine = ['Owner file: ', worktreeId].join('');
    const code = requestedPath.endsWith('.ts');
    const content = code
      ? Array.from({ length: 160 }, (_, index) =>
          index === 119
            ? ['// ', ownerLine, ' · Composable Workbench match'].join('')
            : ['// line ', index + 1].join(''),
        ).join('\n')
      : ['# F307 Composable Workbench', '', ownerLine].join('\n');
    return {
      body: {
        path: requestedPath,
        content,
        sha256: 'abc307',
        size: content.length,
        mime: code ? 'text/typescript' : 'text/markdown',
        truncated: false,
      },
    };
  }
  if (url.pathname === '/api/workspace/diff') {
    const worktreeId = url.searchParams.get('worktreeId') ?? WORKTREE_ID;
    const path = `src/${worktreeId}.ts`;
    return {
      body: {
        changedFiles: [{ status: 'M', path }],
        diff: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`,
      },
    };
  }
  if (url.pathname === '/api/preview/status') return { body: { available: false, gatewayPort: 0 } };
  if (url.pathname === '/api/preview/target-health') return { body: { reachable: false } };
  if (url.pathname === '/api/preview/open' && method === 'POST') return { body: { allowed: true } };
  if (url.pathname === '/api/preview/navigate' && method === 'POST') return { body: { ok: true } };
  if (url.pathname === '/api/terminal/sessions' && method === 'POST') {
    return { body: { error: 'terminal transport unavailable in browser evidence' }, status: 503 };
  }
  if (url.pathname === '/api/terminal/agent-panes') return { body: [] };
}

function fallbackResponse(pathname) {
  if (pathname === '/api/debug/callback-auth') return { body: { error: 'forbidden' }, status: 403 };
  const fixed = fixedFixture(pathname);
  if (fixed !== undefined) return { body: fixed };
  if (pathname.endsWith('/task-progress')) return { body: { taskProgress: {} } };
  if (pathname.endsWith('/queue')) return { body: { queue: [], paused: false, activeInvocations: [] } };
  if (pathname.endsWith('/freshness-closures')) return { body: { closures: [], supplements: [] } };
  return { body: {} };
}

export function realSurfaceApiResponse(request, exposeBackgroundRun) {
  const url = new URL(request.url());
  return (
    executionResponse(url.pathname, exposeBackgroundRun) ??
    workspaceResponse(url, request.method()) ??
    fallbackResponse(url.pathname)
  );
}
