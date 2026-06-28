/**
 * F246 v2: ApprovalItemCard badge regression test for F231.
 *
 * Proves F231 items render with badge text "Profile" (not "Handoff"),
 * and that the badge color uses semantic-warning (amber), distinct from
 * F225's semantic-secondary (purple).
 *
 * Regression guard for the hardcoded-allowlist P1 found in review.
 */

import type { ApprovalItem } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const F231_ITEM: ApprovalItem = {
  proposalId: 'badge-f231',
  sourceFeatureId: 'F231',
  sourceThreadId: 'thread-profile-1',
  requesterCatId: 'opus',
  ownerUserId: 'user-1',
  status: 'pending',
  summary: 'Profile update: user prefers dark mode',
  detail: { rationale: 'prefers dark mode', targetLayer: 'preferences', targetPath: 'theme', signalKind: 'explicit' },
  inlineApprovable: false,
  createdAt: Date.now() - 600_000,
};

const F225_ITEM: ApprovalItem = {
  proposalId: 'badge-f225',
  sourceFeatureId: 'F225',
  sourceThreadId: 'thread-handoff-1',
  requesterCatId: 'sonnet',
  ownerUserId: 'user-1',
  status: 'pending',
  summary: 'Session handoff request',
  detail: {},
  inlineApprovable: false,
  createdAt: Date.now() - 1200_000,
};

// Mock stores to avoid real Zustand state
vi.mock('@/stores/approvalHubStore', () => ({
  useApprovalHubStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      close: vi.fn(),
      approveProposal: vi.fn(),
      rejectProposal: vi.fn(),
      deciding: {},
      selectedIds: new Set<string>(),
      toggleSelection: vi.fn(),
    }),
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: Object.assign(() => ({}), {
    getState: () => ({ currentThreadId: null }),
  }),
}));

vi.mock('@/utils/scrollToMessage', () => ({ scrollToMessage: vi.fn() }));
vi.mock('@/utils/teleport', () => ({ planTeleport: () => ({}), kickTeleportResolve: vi.fn() }));
vi.mock('../ThreadSidebar/thread-navigation', () => ({ pushThreadRouteWithHistory: vi.fn() }));

import { ApprovalItemCard } from '../ApprovalItemCard';

describe('F246 v2: ApprovalItemCard F231 badge', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as Record<string, unknown>).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as Record<string, unknown>).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('F231 card badge text is "Profile", not "Handoff"', async () => {
    await act(async () => {
      root.render(React.createElement(ApprovalItemCard, { item: F231_ITEM }));
    });

    const card = container.querySelector('[data-testid="approval-item-badge-f231"]');
    expect(card).not.toBeNull();

    // Find the badge span (first span in header row)
    const badgeSpans = card!.querySelectorAll('.text-micro span');
    const featureBadge = badgeSpans[0];
    expect(featureBadge).not.toBeNull();
    expect(featureBadge!.textContent).toBe('Profile');
  });

  it('F231 badge color uses semantic-warning (amber), not semantic-secondary (purple)', async () => {
    await act(async () => {
      root.render(React.createElement(ApprovalItemCard, { item: F231_ITEM }));
    });

    const card = container.querySelector('[data-testid="approval-item-badge-f231"]');
    const badgeSpans = card!.querySelectorAll('.text-micro span');
    const featureBadge = badgeSpans[0] as HTMLElement;
    expect(featureBadge.style.backgroundColor).toContain('semantic-warning');
  });

  it('F225 card badge is still "Handoff" (no regression)', async () => {
    await act(async () => {
      root.render(React.createElement(ApprovalItemCard, { item: F225_ITEM }));
    });

    const card = container.querySelector('[data-testid="approval-item-badge-f225"]');
    expect(card).not.toBeNull();
    const badgeSpans = card!.querySelectorAll('.text-micro span');
    const featureBadge = badgeSpans[0];
    expect(featureBadge!.textContent).toBe('Handoff');
  });
});
