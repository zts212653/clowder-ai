/**
 * F260 T0: Entity proposal card rendering + approve/reject affordance.
 *
 * Proves the P1 fix: F260 items with inlineApprovable=true now render
 * approve/reject buttons (previously hardcoded to F193 only). Also
 * verifies badge, detail section, and filter chip presence.
 *
 * [宪宪/Claude Opus 4.6🐾]
 */

import type { ApprovalItem, EntityConflictContext } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { anchoredApprovalNavigation } from '@/test-support/approval-navigation';

const F260_ITEM: ApprovalItem = {
  proposalId: 'ent-f260-1',
  sourceFeatureId: 'F260',
  navigation: anchoredApprovalNavigation('thread-entity-src'),
  requesterCatId: 'opus',
  ownerUserId: 'user-1',
  status: 'pending',
  summary: 'Entity proposal: 未婚喵 (concept)',
  detail: {
    entityId: 'concept:未婚喵',
    entityType: 'concept',
    canonicalName: '未婚喵',
    aliases: ['未婚喵', '未婚猫'],
    stance: 'endorsed',
    visibilityScope: 'workspace',
    rationale: 'Recurring term in thread discussions, needs registry entry',
  },
  inlineApprovable: true,
  expiresAt: Date.now() + 14 * 24 * 60 * 60 * 1000,
  createdAt: Date.now() - 300_000,
};

const SAME_ENTITY_CONFLICT: EntityConflictContext = {
  version: 1,
  reason: 'existing-entity-change',
  fingerprint: 'a'.repeat(64),
  incoming: {
    entityId: 'concept:沉迷护栏',
    entityType: 'concept',
    canonicalName: '猫猫安全护栏',
    aliases: ['猫猫安全护栏', '安全护栏', 'AI沉迷护栏'],
    stance: 'endorsed',
    visibilityScope: 'workspace',
    status: 'active',
  },
  candidates: [
    {
      entityId: 'concept:沉迷护栏',
      entityType: 'concept',
      canonicalName: '防AI沉迷护栏',
      aliases: ['沉迷护栏'],
      stance: 'endorsed',
      visibilityScope: 'workspace',
      status: 'active',
    },
  ],
  conflictingSurfaces: ['沉迷护栏'],
  canonicalReplacementRequiredFor: [],
  allowedActions: ['merge-aliases', 'replace', 'reject'],
};

const SURFACE_CONFLICT: EntityConflictContext = {
  ...SAME_ENTITY_CONFLICT,
  reason: 'surface-collision',
  fingerprint: 'b'.repeat(64),
  incoming: {
    ...SAME_ENTITY_CONFLICT.incoming,
    entityId: 'concept:new-guard',
    canonicalName: 'New Guard',
    aliases: ['防AI沉迷护栏'],
  },
  canonicalReplacementRequiredFor: ['concept:沉迷护栏'],
  allowedActions: ['correct', 'transfer', 'polysemy', 'reject'],
};

const storeMocks = vi.hoisted(() => ({
  approveProposal: vi.fn(),
  rejectProposal: vi.fn(),
  resolveEntityConflict: vi.fn(),
  deciding: {} as Record<string, string>,
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        threads: [],
        currentThreadId: null,
      }),
    {
      getState: () => ({ currentThreadId: null }),
    },
  ),
}));

vi.mock('@/stores/approvalHubStore', () => ({
  useApprovalHubStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      close: vi.fn(),
      approveProposal: storeMocks.approveProposal,
      rejectProposal: storeMocks.rejectProposal,
      resolveEntityConflict: storeMocks.resolveEntityConflict,
      deciding: storeMocks.deciding,
      selectedIds: new Set<string>(),
      toggleSelection: vi.fn(),
    }),
}));

vi.mock('@/utils/scrollToMessage', () => ({ scrollToMessage: vi.fn() }));
vi.mock('@/utils/teleport', () => ({ planTeleport: () => ({}), kickTeleportResolve: vi.fn() }));
vi.mock('../ThreadSidebar/thread-navigation', () => ({ pushThreadRouteWithHistory: vi.fn() }));

import { ApprovalItemCard } from '../ApprovalItemCard';

describe('F260 T0: entity proposal card', () => {
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
    storeMocks.approveProposal.mockClear();
    storeMocks.rejectProposal.mockClear();
    storeMocks.resolveEntityConflict.mockClear();
    storeMocks.deciding = {};
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  // --- P1 fix: approve/reject buttons ---

  it('F260 inlineApprovable card shows decisions and both provenance anchors', async () => {
    await act(async () => {
      root.render(React.createElement(ApprovalItemCard, { item: F260_ITEM }));
    });

    const card = container.querySelector('[data-testid="approval-item-ent-f260-1"]');
    expect(card).not.toBeNull();

    const approveBtn = card?.querySelector('[data-testid="approve-btn"]');
    const rejectBtn = card?.querySelector('[data-testid="reject-btn"]');
    const cardLink = card?.querySelector('[data-testid="approval-card-link"]');
    const originLink = card?.querySelector('[data-testid="approval-origin-link"]');

    expect(approveBtn).not.toBeNull();
    expect(approveBtn!.textContent).toContain('批准');
    expect(rejectBtn).not.toBeNull();
    expect(rejectBtn!.textContent).toContain('拒绝');
    expect(cardLink?.textContent).toContain('查看审批卡');
    expect(originLink?.textContent).toContain('查看触发原文');
  });

  it('F260 non-inlineApprovable card hides approve but still shows reject', async () => {
    const nonInline: ApprovalItem = { ...F260_ITEM, proposalId: 'ent-f260-ni', inlineApprovable: false };
    await act(async () => {
      root.render(React.createElement(ApprovalItemCard, { item: nonInline }));
    });

    const card = container.querySelector('[data-testid="approval-item-ent-f260-ni"]');
    expect(card!.querySelector('[data-testid="approve-btn"]')).toBeNull();
    // Reject/dismiss is always available — approve needs context, reject doesn't
    expect(card!.querySelector('[data-testid="reject-btn"]')).not.toBeNull();
    expect(card!.querySelector('[data-testid="approval-card-link"]')).not.toBeNull();
    expect(card!.querySelector('[data-testid="approval-origin-link"]')).not.toBeNull();
  });

  // --- P2 fix: badge ---

  it('F260 card shows "Entity" badge', async () => {
    await act(async () => {
      root.render(React.createElement(ApprovalItemCard, { item: F260_ITEM }));
    });

    const card = container.querySelector('[data-testid="approval-item-ent-f260-1"]');
    expect(card!.textContent).toContain('Entity');
  });

  // --- Detail section ---

  it('F260 card shows canonicalName and entityType', async () => {
    await act(async () => {
      root.render(React.createElement(ApprovalItemCard, { item: F260_ITEM }));
    });

    const card = container.querySelector('[data-testid="approval-item-ent-f260-1"]');
    expect(card!.textContent).toContain('未婚喵');
    expect(card!.textContent).toContain('concept');
  });

  it('F260 card visibly identifies both the proposal and target entity', async () => {
    await act(async () => {
      root.render(React.createElement(ApprovalItemCard, { item: F260_ITEM }));
    });

    const card = container.querySelector('[data-testid="approval-item-ent-f260-1"]');
    expect(card!.textContent).toContain('ent-f260-1');
    expect(card!.textContent).toContain('concept:未婚喵');
  });

  it('F260 card shows aliases', async () => {
    await act(async () => {
      root.render(React.createElement(ApprovalItemCard, { item: F260_ITEM }));
    });

    const card = container.querySelector('[data-testid="approval-item-ent-f260-1"]');
    expect(card!.textContent).toContain('别名');
    expect(card!.textContent).toContain('未婚猫');
  });

  it('F260 card exposes the complete rationale through a visible disclosure', async () => {
    await act(async () => {
      root.render(React.createElement(ApprovalItemCard, { item: F260_ITEM }));
    });

    const card = container.querySelector('[data-testid="approval-item-ent-f260-1"]');
    const disclosure = card!.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
    expect(disclosure).not.toBeNull();
    await act(async () => disclosure?.click());
    expect(card!.textContent).toContain('Recurring term');
  });

  it('same-entity conflict renders before/after and replaces generic approve with explicit actions', async () => {
    const conflictItem: ApprovalItem = {
      ...F260_ITEM,
      proposalId: 'same-entity',
      detail: { ...F260_ITEM.detail, conflict: SAME_ENTITY_CONFLICT },
    };
    await act(async () => root.render(React.createElement(ApprovalItemCard, { item: conflictItem })));

    const panel = container.querySelector('[data-testid="entity-conflict-panel"]');
    expect(panel).not.toBeNull();
    expect(panel!.textContent).toContain('当前登记');
    expect(panel!.textContent).toContain('防AI沉迷护栏');
    expect(panel!.textContent).toContain('提案内容');
    expect(panel!.textContent).toContain('猫猫安全护栏');
    expect(panel!.querySelector('[data-testid="resolve-merge-aliases"]')).not.toBeNull();
    expect(panel!.querySelector('[data-testid="resolve-replace"]')).not.toBeNull();
    expect(panel!.querySelector('[data-testid="conflict-reject"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="approve-btn"]')).toBeNull();
  });

  it('submits merge-aliases with the rendered fingerprint', async () => {
    const conflictItem: ApprovalItem = {
      ...F260_ITEM,
      proposalId: 'merge-entity',
      detail: { ...F260_ITEM.detail, conflict: SAME_ENTITY_CONFLICT },
    };
    await act(async () => root.render(React.createElement(ApprovalItemCard, { item: conflictItem })));

    await act(async () => {
      (container.querySelector('[data-testid="resolve-merge-aliases"]') as HTMLButtonElement).click();
    });

    expect(storeMocks.resolveEntityConflict).toHaveBeenCalledWith('merge-entity', {
      action: 'merge-aliases',
      fingerprint: SAME_ENTITY_CONFLICT.fingerprint,
    });
  });

  it('surface collision shows every candidate and the correction/transfer/polysemy choices', async () => {
    const conflictItem: ApprovalItem = {
      ...F260_ITEM,
      proposalId: 'surface-entity',
      detail: { ...F260_ITEM.detail, conflict: SURFACE_CONFLICT },
    };
    await act(async () => root.render(React.createElement(ApprovalItemCard, { item: conflictItem })));

    const panel = container.querySelector('[data-testid="entity-conflict-panel"]');
    expect(panel!.textContent).toContain('同名 surface');
    expect(panel!.textContent).toContain('concept:沉迷护栏');
    expect(panel!.querySelector('[data-testid="resolve-correct"]')).not.toBeNull();
    expect(panel!.querySelector('[data-testid="resolve-transfer"]')).not.toBeNull();
    expect(panel!.querySelector('[data-testid="resolve-polysemy"]')).not.toBeNull();
    expect(panel!.querySelector('[data-testid="conflict-actions"]')!.className).toContain('flex-wrap');
  });

  it('requires and submits an explicit canonical replacement for moved canonical surfaces', async () => {
    const conflictItem: ApprovalItem = {
      ...F260_ITEM,
      proposalId: 'canonical-entity',
      detail: { ...F260_ITEM.detail, conflict: SURFACE_CONFLICT },
    };
    await act(async () => root.render(React.createElement(ApprovalItemCard, { item: conflictItem })));

    const input = container.querySelector('[data-testid="canonical-replacement-concept:沉迷护栏"]') as HTMLInputElement;
    const correct = container.querySelector('[data-testid="resolve-correct"]') as HTMLButtonElement;
    expect(input).not.toBeNull();
    expect(correct.disabled).toBe(true);

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, '旧防沉迷护栏');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(correct.disabled).toBe(false);
    await act(async () => correct.click());

    expect(storeMocks.resolveEntityConflict).toHaveBeenCalledWith('canonical-entity', {
      action: 'correct',
      fingerprint: SURFACE_CONFLICT.fingerprint,
      replacementCanonicalNames: { 'concept:沉迷护栏': '旧防沉迷护栏' },
    });
  });

  // --- Regression guard: F193 still works ---

  it('F193 card still shows approve/reject buttons (no regression)', async () => {
    const f193: ApprovalItem = {
      ...F260_ITEM,
      proposalId: 'reg-f193-1',
      sourceFeatureId: 'F193',
      detail: { targetThreadId: 'thread-t', targetCats: ['sonnet'], content: 'test' },
    };
    await act(async () => {
      root.render(React.createElement(ApprovalItemCard, { item: f193 }));
    });

    const card = container.querySelector('[data-testid="approval-item-reg-f193-1"]');
    expect(card!.querySelector('[data-testid="approve-btn"]')).not.toBeNull();
    expect(card!.querySelector('[data-testid="reject-btn"]')).not.toBeNull();
  });

  it('F221 recovery card exposes resume and reject/dismiss actions', async () => {
    const recoveryItem = {
      ...F260_ITEM,
      proposalId: 'taste-recovery-1',
      sourceFeatureId: 'F221',
      decisionMode: 'resume-only',
      summary: 'Taste approval needs recovery',
      detail: { scene: 'persisted approving state', quote: 'resume me', dimension: 'system-philosophy' },
    } as ApprovalItem & { decisionMode: 'resume-only' };
    await act(async () => {
      root.render(React.createElement(ApprovalItemCard, { item: recoveryItem }));
    });

    const card = container.querySelector('[data-testid="approval-item-taste-recovery-1"]');
    expect(card!.querySelector('[data-testid="resume-btn"]')).not.toBeNull();
    expect(card!.querySelector('[data-testid="resume-btn"]')!.textContent).toContain('继续完成');
    expect(card!.querySelector('[data-testid="approve-btn"]')).toBeNull();
    // Reject/dismiss is always available — user can dismiss stuck recovery proposals
    expect(card!.querySelector('[data-testid="reject-btn"]')).not.toBeNull();
  });
});
