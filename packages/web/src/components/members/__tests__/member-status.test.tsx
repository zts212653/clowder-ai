import type { RoutingContextReadModelV1 } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { useRoutingContext } from '../../routing-context/useRoutingContext';
import { MemberCopyContext } from '../editor-presentation';
import { MemberRoutingHistory } from '../MemberRoutingHistory';
import { MemberStatus } from '../MemberStatus';
import { membersCopy } from '../members.shell-copy';

vi.mock('../../routing-context/useRoutingContext', () => ({ useRoutingContext: vi.fn() }));

it('translates the interface status while preserving an owner-authored note verbatim', () => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  const root = createRoot(container);
  const status = { label: '额度紧张', detail: '可用', detailIsNote: true, tone: 'warning' as const };
  try {
    act(() =>
      root.render(
        <MemberCopyContext.Provider value={membersCopy.en}>
          <MemberStatus status={status} />
        </MemberCopyContext.Provider>,
      ),
    );
    expect(container.querySelector('.member-status-label')?.textContent).toContain('Low quota');
    act(() => container.querySelector<HTMLButtonElement>('button')?.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('可用');
  } finally {
    act(() => root.unmount());
  }
});
it.each([500, 1500])('does not label a closed history assertion with its deadline at time %s', (now) => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const data: RoutingContextReadModelV1 = {
    v: 1,
    ownerId: 'owner',
    observedAt: 400,
    catalogRevision: 'revision',
    preferenceRevisions: [],
    resolution: {
      state: 'degraded',
      reason: 'routing_store_unavailable',
      affectedCatIds: ['member'],
      candidateBindings: [],
    },
    signalEvents: [
      {
        v: 1,
        ownerId: 'owner',
        eventId: 'failure',
        commandId: 'fail',
        subjectRef: { type: 'cat', catId: 'member' },
        source: 'provider_error',
        reasonCode: 'provider_error',
        observedAt: 100,
        evidenceRef: 'failure-source',
        eventType: 'asserted',
        state: 'unavailable',
        validUntil: 1000,
      },
      {
        v: 1,
        ownerId: 'owner',
        eventId: 'success',
        commandId: 'success',
        subjectRef: { type: 'cat', catId: 'member' },
        source: 'dispatch_success',
        reasonCode: 'dispatch_success_probe',
        observedAt: 400,
        probeStartedAt: 200,
        evidenceRef: 'success-source',
        eventType: 'recovered',
        state: 'available',
        closesSignalIds: [],
      },
    ],
  };
  vi.mocked(useRoutingContext).mockReturnValue({ data, loading: false, error: null, refresh: vi.fn(async () => true) });
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    act(() =>
      root.render(
        <MemberCopyContext.Provider value={membersCopy.en}>
          <MemberRoutingHistory cat={{ id: 'member' } as CatData} />
        </MemberCopyContext.Provider>,
      ),
    );
    const old = container.querySelector('details:last-child summary')?.textContent;
    expect(old).toContain('Provider error');
    expect(old).not.toContain('Until');
    expect(old).not.toContain('Expired');
    expect(container.querySelectorAll('details')).toHaveLength(2);
  } finally {
    act(() => root.unmount());
    vi.restoreAllMocks();
  }
});
