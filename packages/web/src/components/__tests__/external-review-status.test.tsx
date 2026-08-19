import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExternalReviewStatus } from '@/components/community/ExternalReviewStatus';

const HEAD = 'abcdef1234567890';

function aggregate(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'maintainer_review',
    cloudPolicy: 'optional',
    lifecycle: 'rereview_required',
    currentHeadSha: HEAD,
    headGeneration: 1,
    lastReviewedHeadSha: null,
    lastReviewedHeadGeneration: null,
    lastDeliveredHeadSha: null,
    lastDeliveredHeadGeneration: null,
    ci: { headSha: HEAD, status: 'pass', observedAt: Date.now() },
    cloud: { headSha: HEAD, status: 'clean', observedAt: Date.now() },
    wake: null,
    delivery: null,
    reviewerCatId: 'codex-sol',
    reviewerThreadId: 'thread-review',
    actionLeaseRef: null,
    ...overrides,
  };
}

describe('ExternalReviewStatus', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T20:00:00.000Z'));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    React.act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('renders nothing for an ordinary PR without external review custody', () => {
    React.act(() => root.render(<ExternalReviewStatus aggregate={null} />));
    expect(container.querySelector('[data-testid="external-review-status"]')).toBeNull();
  });

  it('shows current readiness and pending-delivery age', () => {
    const createdAt = Date.now() - 2 * 60 * 60 * 1000;
    React.act(() =>
      root.render(
        <ExternalReviewStatus
          aggregate={
            aggregate({
              lifecycle: 'pending_delivery',
              delivery: {
                kind: 'pending_delivery',
                headSha: HEAD,
                ownerCatId: 'codex-sol',
                reason: 'GitHub unavailable',
                createdAt,
              },
            }) as never
          }
        />,
      ),
    );

    const status = container.querySelector('[data-testid="external-review-status"]');
    expect(status?.textContent).toContain('HEAD abcdef1');
    expect(status?.textContent).toContain('CI 绿');
    expect(status?.textContent).toContain('云端通过');
    expect(status?.textContent).toContain('待送达 2小时');
    expect(status?.getAttribute('title')).toContain('GitHub unavailable');
  });

  it('labels a delivered proof from an older head generation as historical', () => {
    React.act(() =>
      root.render(
        <ExternalReviewStatus
          aggregate={
            aggregate({
              lifecycle: 'delivered',
              currentHeadSha: 'fedcba9876543210',
              headGeneration: 2,
              lastDeliveredHeadSha: HEAD,
              lastDeliveredHeadGeneration: 1,
              delivery: {
                kind: 'delivered',
                headSha: HEAD,
                githubUrl: 'https://github.com/owner/repo/pull/88#pullrequestreview-1',
                deliveredAt: Date.now(),
              },
            }) as never
          }
        />,
      ),
    );

    expect(container.textContent).toContain('HEAD fedcba9');
    expect(container.textContent).toContain('历史送达 abcdef1');
    expect(container.textContent).not.toContain('已送达 abcdef1');
  });

  it('does not present an older A proof as current after A to B to A', () => {
    React.act(() =>
      root.render(
        <ExternalReviewStatus
          aggregate={
            aggregate({
              lifecycle: 'rereview_required',
              headGeneration: 3,
              lastDeliveredHeadSha: HEAD,
              lastDeliveredHeadGeneration: 1,
            }) as never
          }
        />,
      ),
    );

    expect(container.textContent).toContain('HEAD abcdef1');
    expect(container.textContent).toContain('历史送达 abcdef1');
    expect(container.textContent).not.toContain('已送达 abcdef1');
  });

  it('shows delivered proof as current only for the active generation', () => {
    React.act(() =>
      root.render(
        <ExternalReviewStatus
          aggregate={
            aggregate({
              lifecycle: 'delivered',
              headGeneration: 3,
              lastDeliveredHeadSha: HEAD,
              lastDeliveredHeadGeneration: 3,
            }) as never
          }
        />,
      ),
    );

    expect(container.textContent).toContain('已送达 abcdef1');
    expect(container.textContent).not.toContain('历史送达 abcdef1');
  });
});
