import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useMemberClock } from '../useMemberClock';

it('uses current time when a slow owner snapshot arrives, then ticks at its deadline', () => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const container = document.createElement('div');
  const root = createRoot(container);
  type Model = Parameters<typeof useMemberClock>[0];
  function Clock({ model }: { model: Model }) {
    return <span>{useMemberClock(model)}</span>;
  }
  try {
    act(() => root.render(<Clock model={null} />));
    expect(container.textContent).toBe('1000');
    vi.setSystemTime(5000);
    const model: Model = {
      signalEvents: [
        {
          v: 1,
          eventId: 'signal',
          commandId: 'command',
          ownerId: 'owner',
          subjectRef: { type: 'cat', catId: 'member' },
          reasonCode: 'weekly_quota_low',
          source: 'quota_probe',
          observedAt: 4000,
          evidenceRef: 'evidence',
          eventType: 'asserted',
          state: 'scarce',
          validUntil: 6000,
        },
      ],
    };
    act(() => root.render(<Clock model={model} />));
    expect(container.textContent).toBe('5000');
    act(() => vi.advanceTimersByTime(1000));
    expect(container.textContent).toBe('6000');
  } finally {
    act(() => root.unmount());
    vi.useRealTimers();
  }
});

it('updates a due preference at the actual review deadline without an owner write', () => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const rootNode = document.createElement('div');
  const root = createRoot(rootNode);
  const model = {
    signalEvents: [],
    preferenceRevisions: [
      {
        v: 1 as const,
        ownerId: 'owner',
        preferenceId: 'preference',
        revisionId: 'revision',
        commandId: 'command',
        appliesWhen: {},
        prefer: [{ type: 'cat' as const, catId: 'a' }],
        over: [{ type: 'cat' as const, catId: 'b' }],
        rationale: 'Owner reason',
        evidenceRefs: ['owner-evidence'],
        version: 1,
        validFrom: 100,
        lifecycle: 'active' as const,
        reviewAfter: 2000,
      },
    ],
  };
  function ReviewDue() {
    return <span>{useMemberClock(model) >= 2000 ? 'Review due' : 'Current'}</span>;
  }
  try {
    act(() => root.render(<ReviewDue />));
    expect(rootNode.textContent).toBe('Current');
    act(() => vi.advanceTimersByTime(1000));
    expect(rootNode.textContent).toBe('Review due');
  } finally {
    act(() => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
