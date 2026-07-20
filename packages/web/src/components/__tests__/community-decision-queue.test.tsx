/**
 * F168 Phase E — E-PR2 Decision Queue UX (RED tests)
 *
 * These tests cover the CommunityPanel integration surface, not only the leaf
 * components: queue placement, real mutation endpoints, close-via-GitHub
 * semantics, and bounded text layout.
 */
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockResolveCatName } = vi.hoisted(() => ({
  mockResolveCatName: vi.fn((catId: string) => catId),
}));

vi.mock('@/hooks/useCatNameResolver', () => ({
  useCatNameResolver: () => mockResolveCatName,
}));

vi.mock('@/components/ThreadSidebar/thread-navigation', () => ({
  pushThreadRouteWithHistory: vi.fn(),
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (s: Record<string, unknown>) => unknown) => selector({}),
}));

import { CommunityPanel } from '@/components/CommunityPanel';
import { pushThreadRouteWithHistory } from '@/components/ThreadSidebar/thread-navigation';

const DEFAULT_REPO = 'zts212653/clowder-ai';
const NOW = 1_786_000_000_000;

const MOCK_BOARD = {
  repo: DEFAULT_REPO,
  issues: [
    {
      id: 'iss-open',
      repo: DEFAULT_REPO,
      issueNumber: 42,
      issueType: 'bug',
      title: 'Fix login callback race',
      state: 'discussing',
      replyState: 'replied',
      assignedThreadId: 'thread-abc',
      assignedCatId: 'opus',
      directionCard: null,
      updatedAt: NOW - 1_000,
    },
    {
      id: 'iss-ready',
      repo: DEFAULT_REPO,
      issueNumber: 99,
      issueType: 'feature',
      title: 'Ready to close after public report',
      state: 'fixed',
      replyState: 'replied',
      assignedThreadId: 'thread-ready',
      assignedCatId: 'codex',
      directionCard: null,
      closureChecklist: { readyToClose: true, blockers: [], waiverPresent: false },
      updatedAt: NOW - 2_000,
    },
  ],
  prItems: [],
};

const URGENT_FINDING_ITEM = {
  id: 'decision:reconciliation-finding:issue:zts212653/clowder-ai#42:find-urgent',
  repo: DEFAULT_REPO,
  subjectKey: `issue:${DEFAULT_REPO}#42`,
  subjectType: 'issue',
  number: 42,
  kind: 'reconciliation-finding',
  priority: 'urgent',
  actor: 'case-owner',
  status: 'open',
  title: 'Issue #42: case-closed-github-open',
  ask: 'Review and resolve the reconciliation finding for issue #42.',
  why: 'GitHub is open while the internal case is already closed.',
  recommendedActions: [
    {
      kind: 'acknowledge-finding',
      label: 'Acknowledge',
      endpoint: '/api/community-findings/find-urgent/acknowledge',
      method: 'POST',
    },
    {
      kind: 'resolve-finding',
      label: 'Resolve',
      endpoint: '/api/community-findings/find-urgent/resolve',
      method: 'POST',
    },
    {
      kind: 'waive-finding',
      label: 'Waive',
      endpoint: '/api/community-findings/find-urgent/waive',
      method: 'POST',
      requiresAuditForm: true,
    },
  ],
  evidenceRefs: [
    {
      label: 'Evidence fp-urgent',
      source: 'reconciler-finding',
      text: 'GitHub state and projection state diverged.',
    },
  ],
  source: { findingId: 'find-urgent' },
  firstSeenAt: NOW - 5_000,
  lastUpdatedAt: NOW - 500,
};

const DIRECTION_ITEM = {
  id: 'decision:direction-decision:issue:zts212653/clowder-ai#12:iss-direction',
  repo: DEFAULT_REPO,
  subjectKey: `issue:${DEFAULT_REPO}#12`,
  subjectType: 'issue',
  number: 12,
  kind: 'direction-decision',
  priority: 'high',
  actor: 'cvo',
  status: 'open',
  title: 'Add a deterministic routing policy',
  ask: 'Decide the routing direction for issue #12.',
  why: 'Narrator recommends accepting and assigning this to the owner thread.',
  recommendedActions: [
    {
      kind: 'open-thread',
      label: 'Open thread',
      threadId: 'thread-owner',
    },
    {
      kind: 'resolve-direction',
      label: 'Resolve direction',
      endpoint: '/api/community-issues/iss-direction/resolve',
      method: 'POST',
    },
  ],
  evidenceRefs: [{ label: 'Direction card', source: 'direction-card', text: 'Accept and route to owner thread.' }],
  source: { projectionState: 'pending-decision', directionCardEntryId: 'entry-1' },
  firstSeenAt: NOW - 7_000,
  lastUpdatedAt: NOW - 7_000,
};

const ROUTED_DIRECTION_ITEM = {
  ...DIRECTION_ITEM,
  id: 'decision:direction-decision:issue:zts212653/clowder-ai#13:iss-direction-routed',
  source: {
    projectionState: 'pending-decision',
    directionCardEntryId: 'entry-routed',
    catId: 'opus',
    assignedCatId: 'codex',
    routeRecommendation: { kind: 'existing-thread', threadId: 'thread-owner' },
  },
};

const READY_TO_CLOSE_ITEM = {
  id: 'decision:closure-action:issue:zts212653/clowder-ai#99:ready-to-close',
  repo: DEFAULT_REPO,
  subjectKey: `issue:${DEFAULT_REPO}#99`,
  subjectType: 'issue',
  number: 99,
  kind: 'closure-action',
  priority: 'high',
  actor: 'case-owner',
  status: 'open',
  title: 'Ready to close after public report',
  ask: 'Close issue #99 on GitHub.',
  why: 'Closure checklist is complete; close the GitHub issue and let the webhook/Reconciler confirm.',
  recommendedActions: [
    {
      kind: 'close-via-github',
      label: 'Close on GitHub',
      endpoint: `https://github.com/${DEFAULT_REPO}/issues/99`,
      method: 'GET',
    },
  ],
  evidenceRefs: [
    {
      label: 'Closure checklist ready',
      source: 'closure-checklist',
      text: 'All closure blockers are cleared.',
    },
  ],
  source: { projectionState: 'fixed', nextOwner: 'codex' },
  firstSeenAt: NOW - 2_000,
  lastUpdatedAt: NOW - 2_000,
};

const REPORT_CLOSURE_ITEM = {
  ...READY_TO_CLOSE_ITEM,
  id: 'decision:closure-action:issue:zts212653/clowder-ai#99:fixed-not-reported',
  ask: 'Report the public reply for issue #99.',
  recommendedActions: [
    {
      kind: 'mark-reported',
      label: 'Mark reported',
      endpoint: '/api/community-issues/iss-ready/report',
      method: 'POST',
      requiresAuditForm: true,
    },
  ],
  source: { projectionState: 'fixed', nextOwner: 'none', assignedCatId: 'codex' },
};

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as Response;
}

function installFetchMock(
  queueItems: unknown[],
  opts: { repos?: string[]; board?: typeof MOCK_BOARD; queueRepo?: string } = {},
) {
  const repos = opts.repos ?? [DEFAULT_REPO];
  const board = opts.board ?? MOCK_BOARD;
  const queueRepo = opts.queueRepo ?? board.repo;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.startsWith('/api/community-board')) return jsonResponse(board);
    if (url.startsWith('/api/community-decision-queue')) {
      return jsonResponse({ repo: queueRepo, items: queueItems, warnings: [] });
    }
    if (url.startsWith('/api/community-findings?')) return jsonResponse({ findings: [] });
    if (url.startsWith('/api/community-repos')) return jsonResponse({ repos });
    if (url === '/api/community-findings/find-urgent/acknowledge' && init?.method === 'POST') {
      return jsonResponse({ finding: { findingId: 'find-urgent', status: 'acknowledged' } });
    }
    return jsonResponse({});
  });
}

async function renderPanel(root: Root) {
  await React.act(async () => {
    root.render(React.createElement(CommunityPanel));
  });
  await React.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

describe('CommunityPanel decision queue (E-PR2)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.setSystemTime(NOW);
    mockResolveCatName.mockReset();
    mockResolveCatName.mockImplementation((catId: string) => catId);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    root.unmount();
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders the prioritized decision queue before raw Issues and shows urgent items first', async () => {
    installFetchMock([DIRECTION_ITEM, URGENT_FINDING_ITEM]);

    await renderPanel(root);

    const queue = container.querySelector('[data-testid="decision-queue-panel"]');
    const rawIssues = container.querySelector('[data-testid="raw-issues-section"]');
    if (!queue) throw new Error('Expected decision queue section');
    if (!rawIssues) throw new Error('Expected raw issues section');
    expect(queue.compareDocumentPosition(rawIssues) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const text = container.textContent === null ? '' : container.textContent;
    expect(text.indexOf('Issue #42: case-closed-github-open')).toBeLessThan(
      text.indexOf('Add a deterministic routing policy'),
    );
  });

  it('keeps backend actor-rank ordering before recency for same-priority items', async () => {
    installFetchMock([
      { ...READY_TO_CLOSE_ITEM, lastUpdatedAt: NOW - 100 },
      { ...DIRECTION_ITEM, lastUpdatedAt: NOW - 10_000 },
    ]);

    await renderPanel(root);

    const text = container.textContent === null ? '' : container.textContent;
    expect(text.indexOf('Add a deterministic routing policy')).toBeLessThan(
      text.indexOf('Ready to close after public report'),
    );
  });

  it('keeps decision actor roles outside member identity projection', async () => {
    mockResolveCatName.mockImplementation((catId: string) => `member:${catId}`);
    installFetchMock([DIRECTION_ITEM]);

    await renderPanel(root);

    const item = container.querySelector(`[data-testid="decision-item-${DIRECTION_ITEM.id}"]`);
    expect(item?.textContent).toContain('cvo');
    expect(item?.textContent).not.toContain('member:cvo');
    expect(mockResolveCatName).not.toHaveBeenCalledWith('cvo');
  });

  it('passes routeRecommendation with the assigned owner when accepting a direction queue item', async () => {
    const fetchSpy = installFetchMock([ROUTED_DIRECTION_ITEM]);

    await renderPanel(root);

    const button = container.querySelector(
      `[data-testid="decision-action-resolve-direction-${ROUTED_DIRECTION_ITEM.id}-accept"]`,
    ) as HTMLButtonElement | null;
    if (!button) throw new Error('Expected resolve-direction accept button');

    await React.act(async () => {
      button.click();
    });

    const actionCall = fetchSpy.mock.calls.find(
      (call: unknown[]) => call[0] === '/api/community-issues/iss-direction/resolve',
    );
    if (!actionCall) throw new Error('Expected resolve-direction POST call');
    expect(JSON.parse(String((actionCall[1] as RequestInit).body))).toEqual({
      catId: 'codex',
      decision: 'accepted',
      routeRecommendation: { kind: 'existing-thread', threadId: 'thread-owner' },
    });
  });

  it('opens the owner thread from a decision queue action', async () => {
    installFetchMock([ROUTED_DIRECTION_ITEM]);

    await renderPanel(root);

    const button = container.querySelector(
      `[data-testid="decision-action-open-thread-${ROUTED_DIRECTION_ITEM.id}"]`,
    ) as HTMLButtonElement | null;
    if (!button) throw new Error('Expected open-thread button');

    await React.act(async () => {
      button.click();
    });

    expect(pushThreadRouteWithHistory).toHaveBeenCalledWith('thread-owner', window);
  });

  it('selects the first discovered repo instead of booting into a hardcoded Clowder repo', async () => {
    const fetchSpy = installFetchMock([], {
      repos: ['acme/community'],
      board: { ...MOCK_BOARD, repo: 'acme/community', issues: [], prItems: [] },
      queueRepo: 'acme/community',
    });

    await renderPanel(root);

    expect(fetchSpy.mock.calls.some((call: unknown[]) => String(call[0]).includes('repo=acme%2Fcommunity'))).toBe(true);
    expect(fetchSpy.mock.calls.some((call: unknown[]) => String(call[0]).includes('repo=zts212653%2Fclowder-ai'))).toBe(
      false,
    );
  });

  it('finding action buttons call their mutation endpoint instead of only refreshing', async () => {
    const fetchSpy = installFetchMock([URGENT_FINDING_ITEM]);

    await renderPanel(root);

    const button = container.querySelector(
      `[data-testid="decision-action-acknowledge-finding-${URGENT_FINDING_ITEM.id}"]`,
    ) as HTMLButtonElement | null;
    if (!button) throw new Error('Expected acknowledge-finding button');

    await React.act(async () => {
      button.click();
    });

    const actionCall = fetchSpy.mock.calls.find(
      (call: unknown[]) => call[0] === '/api/community-findings/find-urgent/acknowledge',
    );
    if (!actionCall) throw new Error('Expected acknowledge-finding POST call');
    expect((actionCall[1] as RequestInit).method).toBe('POST');
  });

  it('uses the queue owner actor for closure audit actions', async () => {
    const fetchSpy = installFetchMock([REPORT_CLOSURE_ITEM]);

    await renderPanel(root);

    const button = container.querySelector(
      `[data-testid="decision-action-mark-reported-${REPORT_CLOSURE_ITEM.id}"]`,
    ) as HTMLButtonElement | null;
    if (!button) throw new Error('Expected mark-reported button');

    await React.act(async () => {
      button.click();
    });

    const input = container.querySelector(
      '[data-testid="decision-report-url-mark-reported"]',
    ) as HTMLInputElement | null;
    if (!input) throw new Error('Expected public comment URL input');
    await React.act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(input, 'https://github.com/zts212653/clowder-ai/issues/99#issuecomment-1');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const submit = container.querySelector(
      '[data-testid="decision-audit-form-mark-reported"] button[type="submit"]',
    ) as HTMLButtonElement | null;
    if (!submit) throw new Error('Expected audit form submit');
    await React.act(async () => {
      submit.click();
    });

    const actionCall = fetchSpy.mock.calls.find(
      (call: unknown[]) => call[0] === '/api/community-issues/iss-ready/report',
    );
    if (!actionCall) throw new Error('Expected mark-reported POST call');
    expect(JSON.parse(String((actionCall[1] as RequestInit).body)).actor).toBe('codex');
  });

  it('renders close-via-github as an external action and never calls legacy PATCH close', async () => {
    const fetchSpy = installFetchMock([READY_TO_CLOSE_ITEM]);

    await renderPanel(root);

    const link = container.querySelector(
      `[data-testid="decision-action-close-via-github-${READY_TO_CLOSE_ITEM.id}"]`,
    ) as HTMLAnchorElement | null;
    if (!link) throw new Error('Expected close-via-github link');
    expect(link.href).toBe(`https://github.com/${DEFAULT_REPO}/issues/99`);
    expect(link.target).toBe('_blank');

    await React.act(async () => {
      link.click();
    });

    const legacyPatch = fetchSpy.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === 'string' &&
        call[0].includes('/api/community-issues/iss-ready') &&
        (call[1] as RequestInit | undefined)?.method === 'PATCH',
    );
    expect(legacyPatch).toBeUndefined();
  });

  it('wraps long queue titles and evidence text inside the queue item', async () => {
    const longItem = {
      ...URGENT_FINDING_ITEM,
      title:
        'Issue #42: ' +
        'a-very-long-unbroken-title-segment-that-should-not-force-horizontal-overflow-in-the-community-panel',
      why: 'a-very-long-unbroken-evidence-segment-that-should-wrap-or-break-inside-the-decision-queue-detail-region',
      evidenceRefs: [
        {
          label: 'Long evidence',
          source: 'reconciler-finding',
          text: 'a-very-long-unbroken-evidence-reference-that-should-not-overflow-the-panel',
        },
      ],
    };
    installFetchMock([longItem]);

    await renderPanel(root);

    const title = container.querySelector(`[data-testid="decision-item-title-${longItem.id}"]`);
    const evidence = container.querySelector(`[data-testid="decision-evidence-${longItem.id}-0"]`);
    if (!title) throw new Error('Expected long-title item title node');
    if (!evidence) throw new Error('Expected long-title item evidence node');
    expect(title.className).toContain('break-words');
    expect(evidence.className).toContain('break-words');
  });
});
