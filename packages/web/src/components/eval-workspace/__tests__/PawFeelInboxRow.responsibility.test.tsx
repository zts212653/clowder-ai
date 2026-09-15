import type { PawFeelInboxItem } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PawFeelInboxRow } from '../PawFeelInboxRow';

const staleRepair: PawFeelInboxItem = {
  disposition: {
    signalId: 'signal-stale-repair',
    sourceMessageId: 'message-stale-repair',
    sourceThreadId: 'thread-source',
    sourceCatId: 'codex-sol',
    markerDigest: 'a'.repeat(64),
    sameDigestOrdinal: 0,
    markerIndex: 0,
    state: 'fix',
    sequence: 2,
    discoveredAt: '2026-08-08T00:00:00.000Z',
    lastTransitionAt: '2026-08-08T00:01:00.000Z',
    ownerCatId: 'codex-sol',
    taskId: 'task-repair',
    actionLeaseRef: { leaseId: 'lease-stale', generation: 2 },
    custodyEvidenceRef: 'custody:task-repair:2',
    backfilled: false,
    captureMethod: 'typed',
    captureAssessment: 'confirmed',
  },
  responsibility: {
    state: 'unreviewed',
    validExit: false,
    exitKind: 'repair_binding',
    evidenceRefs: ['task:task-repair', 'lease:lease-stale:2', 'custody:task-repair:2'],
    ownerCatId: 'codex-sol',
    taskId: 'task-repair',
    leaseId: 'lease-stale',
  },
  issue: {
    resolution: 'open',
    continuation: {
      kind: 'done_unverified',
      evidenceRefs: ['task:task-repair:done'],
      ownerCatId: 'codex-sol',
      taskId: 'task-repair',
      leaseId: 'lease-stale',
    },
    ageMs: 4 * 3_600_000,
  },
  source: {
    availability: 'available',
    preview: '原消息预览 stale-repair',
    sourceHref: '/thread/thread-source?message=message-stale-repair',
    digestVerified: true,
  },
  ageMs: 3_600_000,
  overdue: false,
};

describe('PawFeelInboxRow responsibility truth', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('does not claim a stale repair lease is a valid business exit', () => {
    const root = createRoot(container);
    act(() => root.render(<PawFeelInboxRow item={staleRepair} />));

    const row = container.querySelector('[data-testid="paw-feel-inbox-row"]');
    expect(row?.getAttribute('data-state')).toBe('unreviewed');
    expect(row?.getAttribute('data-valid-exit')).toBe('false');
    expect(row?.getAttribute('data-resolution')).toBe('open');
    expect(row?.textContent).toContain('unreviewed · 尚无业务出口 · 尚未形成有效出口');
    expect(row?.textContent).toContain('当前 active lease 复验失败');
    expect(row?.textContent).toContain('问题仍开放');
    expect(row?.textContent).toContain('任务已结束，等待 owner 验证');

    act(() => root.unmount());
  });

  it('keeps the complete task, Approval, main, loaded, and verification journey visible', () => {
    const root = createRoot(container);
    const journey: PawFeelInboxItem = {
      ...staleRepair,
      issue: {
        resolution: 'resolved',
        ageMs: staleRepair.issue.ageMs,
        resolvedAt: '2026-09-07T00:00:00.000Z',
        continuation: {
          kind: 'verified_outcome',
          taskId: 'task:item:journey',
          leaseId: 'action-lease:journey',
          proposalId: 'proposal:journey',
          caseActionRef: 'case-action:journey',
          evidenceRefs: [
            'task:item:journey',
            'proposal:journey',
            `main-commit:${'a'.repeat(40)}`,
            'loaded:journey',
            'freshness:journey',
          ],
        },
      },
    };
    act(() => root.render(<PawFeelInboxRow item={journey} />));

    for (const ref of journey.issue.continuation.evidenceRefs) {
      expect(container.textContent).toContain(ref);
    }
    expect(container.textContent).toContain('Approval proposal:journey');

    act(() => root.unmount());
  });
});
