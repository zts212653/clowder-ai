/**
 * F260 T0: approvalHubStore per-feature endpoint routing.
 *
 * Hub frontend was hardcoding `/api/dispatch-proposals/` for all features.
 * F260 entity proposals use `/api/entity-proposals/`. This test proves
 * the store routes to the correct endpoint based on the item's sourceFeatureId.
 *
 * [宪宪/Claude Opus 4.6🐾]
 */

import type { ApprovalItem, EntityConflictContext } from '@cat-cafe/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { anchoredApprovalNavigation } from '@/test-support/approval-navigation';

const mockApiFetch = vi.fn().mockImplementation(async () => ({
  ok: true,
  json: async () => ({ proposalId: 'f260-1', entityId: 'concept:new', status: 'approved' }),
}));
vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

import { useApprovalHubStore } from '../approvalHubStore';
import { useToastStore } from '../toastStore';

const NOW = Date.now();
const CONFLICT: EntityConflictContext = {
  version: 1,
  reason: 'surface-collision',
  fingerprint: 'a'.repeat(64),
  incoming: {
    entityId: 'concept:new',
    entityType: 'concept',
    canonicalName: 'New',
    aliases: ['沉迷护栏'],
    stance: 'endorsed',
    visibilityScope: 'workspace',
    status: 'active',
  },
  candidates: [
    {
      entityId: 'concept:old',
      entityType: 'concept',
      canonicalName: 'Old',
      aliases: ['沉迷护栏'],
      stance: 'endorsed',
      visibilityScope: 'workspace',
      status: 'active',
    },
  ],
  conflictingSurfaces: ['沉迷护栏'],
  canonicalReplacementRequiredFor: [],
  allowedActions: ['correct', 'transfer', 'polysemy', 'reject'],
};

function makeItem(overrides: Partial<ApprovalItem> & { proposalId: string }): ApprovalItem {
  return {
    sourceFeatureId: 'F193',
    navigation: anchoredApprovalNavigation('thread-1'),
    requesterCatId: 'opus',
    ownerUserId: 'user-1',
    status: 'pending',
    summary: 'test',
    detail: {},
    inlineApprovable: true,
    createdAt: NOW,
    ...overrides,
  };
}

describe('approvalHubStore — per-feature endpoint routing', () => {
  beforeEach(() => {
    mockApiFetch.mockClear();
    useApprovalHubStore.setState({
      items: [
        makeItem({ proposalId: 'f193-1', sourceFeatureId: 'F193', inlineApprovable: true }),
        makeItem({ proposalId: 'f139-1', sourceFeatureId: 'F139', inlineApprovable: true }),
        makeItem({ proposalId: 'f225-1', sourceFeatureId: 'F225', inlineApprovable: false }),
        makeItem({ proposalId: 'f221-1', sourceFeatureId: 'F221', inlineApprovable: true }),
        makeItem({ proposalId: 'f260-1', sourceFeatureId: 'F260', inlineApprovable: true }),
        makeItem({ proposalId: 'f231-1', sourceFeatureId: 'F231', inlineApprovable: true }),
      ],
      count: 6,
      selectedIds: new Set<string>(),
      batchResults: [],
      deciding: {},
      error: null,
    });
    useToastStore.setState({ toasts: [] });
  });

  // --- Single approve ---

  it('approveProposal routes F193 to /api/dispatch-proposals/', async () => {
    await useApprovalHubStore.getState().approveProposal('f193-1');
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/dispatch-proposals/f193-1/approve',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('approveProposal routes F260 to /api/entity-proposals/', async () => {
    await useApprovalHubStore.getState().approveProposal('f260-1');
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/entity-proposals/f260-1/approve',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('approveProposal routes F139 to /api/schedule-proposals/', async () => {
    await useApprovalHubStore.getState().approveProposal('f139-1');
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/schedule-proposals/f139-1/approve',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('keeps candidates and reason on the item when first approve discovers a conflict', async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({
        error: 'entity_surface_conflict',
        message: '请选择如何处理同名实体',
        conflict: CONFLICT,
      }),
    });

    await useApprovalHubStore.getState().approveProposal('f260-1');

    const item = useApprovalHubStore.getState().items.find(({ proposalId }) => proposalId === 'f260-1');
    expect(item?.detail.conflict).toEqual(CONFLICT);
    expect(item?.detail.conflictError).toBe('请选择如何处理同名实体');
    expect(useApprovalHubStore.getState().error).not.toBe('entity_surface_conflict');
  });

  it('posts an explicit resolution body and removes the item only after success', async () => {
    const resolution = {
      action: 'polysemy' as const,
      fingerprint: CONFLICT.fingerprint,
    };

    await useApprovalHubStore.getState().resolveEntityConflict('f260-1', resolution);

    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/entity-proposals/f260-1/resolve',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(resolution) }),
    );
    expect(useApprovalHubStore.getState().items.some(({ proposalId }) => proposalId === 'f260-1')).toBe(false);
  });

  it('confirms which same-looking proposal resolved while preserving an older pending card', async () => {
    useApprovalHubStore.setState((state) => ({
      items: [
        ...state.items.map((item) =>
          item.proposalId === 'f260-1'
            ? {
                ...item,
                detail: {
                  ...item.detail,
                  entityId: CONFLICT.incoming.entityId,
                  canonicalName: CONFLICT.incoming.canonicalName,
                  conflict: CONFLICT,
                },
              }
            : item,
        ),
        makeItem({
          proposalId: 'f260-old',
          sourceFeatureId: 'F260',
          summary: 'Entity proposal: New (concept)',
          detail: { entityId: 'concept:old-id', canonicalName: 'New', aliases: ['沉迷护栏'] },
        }),
      ],
      count: state.count + 1,
    }));

    await useApprovalHubStore.getState().resolveEntityConflict('f260-1', {
      action: 'merge-aliases',
      fingerprint: CONFLICT.fingerprint,
    });

    expect(useApprovalHubStore.getState().items.some(({ proposalId }) => proposalId === 'f260-old')).toBe(true);
    const toast = useToastStore.getState().toasts.at(-1);
    expect(toast?.type).toBe('success');
    expect(`${toast?.title} ${toast?.message}`).toContain('f260-1');
    expect(`${toast?.title} ${toast?.message}`).toContain('concept:new');
  });

  it('keeps the item and replaces stale conflict truth returned by resolution', async () => {
    const fresh = { ...CONFLICT, fingerprint: 'b'.repeat(64) };
    mockApiFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({
        error: 'entity_conflict_stale',
        message: '实体真相已变化，请重新确认',
        conflict: fresh,
      }),
    });

    await useApprovalHubStore.getState().resolveEntityConflict('f260-1', {
      action: 'polysemy',
      fingerprint: CONFLICT.fingerprint,
    });

    const item = useApprovalHubStore.getState().items.find(({ proposalId }) => proposalId === 'f260-1');
    expect(item?.detail.conflict).toEqual(fresh);
    expect(item?.detail.conflictError).toBe('实体真相已变化，请重新确认');
    expect(useApprovalHubStore.getState().deciding['f260-1']).toBeUndefined();
  });

  it('approveProposal routes F221 to /api/taste-proposals/', async () => {
    await useApprovalHubStore.getState().approveProposal('f221-1');
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/taste-proposals/f221-1/approve',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('shows the backend detail when an F221 approval write fails', async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({
        error: 'Vignette write failed',
        detail: 'Taste repository cannot find a checked-out refs/heads/main worktree',
      }),
    });

    await useApprovalHubStore.getState().approveProposal('f221-1');

    expect(useApprovalHubStore.getState().error).toBe(
      'Vignette write failed: Taste repository cannot find a checked-out refs/heads/main worktree',
    );
    expect(useApprovalHubStore.getState().items.some((item) => item.proposalId === 'f221-1')).toBe(true);
  });

  it('approveProposal routes F231 to its registered profile-update endpoint', async () => {
    await useApprovalHubStore.getState().approveProposal('f231-1');
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/profile-updates/f231-1/approve',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  // --- Single reject ---

  it('rejectProposal routes F221 to /api/taste-proposals/', async () => {
    await useApprovalHubStore.getState().rejectProposal('f221-1');
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/taste-proposals/f221-1/reject',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('rejectProposal routes F139 to /api/schedule-proposals/', async () => {
    await useApprovalHubStore.getState().rejectProposal('f139-1');
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/schedule-proposals/f139-1/reject',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('rejectProposal routes F260 to /api/entity-proposals/', async () => {
    await useApprovalHubStore.getState().rejectProposal('f260-1');
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/entity-proposals/f260-1/reject',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('posts F225 feedback in the feature-owned request body', async () => {
    const success = await useApprovalHubStore
      .getState()
      .rejectProposal('f225-1', { reasonCode: 'other', detail: '不属于这次交接' });
    expect(success).toBe(true);
    expect(mockApiFetch).toHaveBeenCalledWith('/api/session-handoff/f225-1/reject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feedback: { reasonCode: 'other', detail: '不属于这次交接' } }),
    });
  });

  it('keeps unsupported producers on their existing body-less reject path', async () => {
    await useApprovalHubStore.getState().rejectProposal('f193-1', { reasonCode: 'wrong' });
    expect(mockApiFetch).toHaveBeenCalledWith('/api/dispatch-proposals/f193-1/reject', { method: 'POST' });
  });

  // --- Batch approve ---

  it('batchApprove routes each item to its feature endpoint', async () => {
    useApprovalHubStore.setState({
      selectedIds: new Set(['f193-1', 'f260-1']),
    });
    await useApprovalHubStore.getState().batchApprove();

    const calls = mockApiFetch.mock.calls.map((c) => c[0] as string);
    expect(calls).toContain('/api/dispatch-proposals/f193-1/approve');
    expect(calls).toContain('/api/entity-proposals/f260-1/approve');
  });

  it('excludes conflict items from selection and batch decisions', async () => {
    useApprovalHubStore.setState((state) => ({
      items: state.items.map((item) =>
        item.proposalId === 'f260-1' ? { ...item, detail: { ...item.detail, conflict: CONFLICT } } : item,
      ),
    }));

    useApprovalHubStore.getState().toggleSelection('f260-1');
    useApprovalHubStore.getState().selectAllInline();
    expect(useApprovalHubStore.getState().selectedIds.has('f260-1')).toBe(false);

    await useApprovalHubStore.getState().batchApprove();
    const calls = mockApiFetch.mock.calls.map((call) => call[0] as string);
    expect(calls).not.toContain('/api/entity-proposals/f260-1/approve');
  });

  it('keeps typed conflict context when batch approval discovers a late registry race', async () => {
    useApprovalHubStore.setState({ selectedIds: new Set(['f260-1']) });
    mockApiFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({
        error: 'entity_surface_conflict',
        message: '请选择如何处理同名实体',
        conflict: CONFLICT,
      }),
    });

    const results = await useApprovalHubStore.getState().batchApprove();

    expect(results).toEqual([{ proposalId: 'f260-1', success: false, error: '请选择如何处理同名实体' }]);
    const item = useApprovalHubStore.getState().items.find(({ proposalId }) => proposalId === 'f260-1');
    expect(item?.detail.conflict).toEqual(CONFLICT);
    expect(item?.detail.conflictError).toBe('请选择如何处理同名实体');
  });

  // --- Batch reject ---

  it('batchReject routes each item to its feature endpoint', async () => {
    useApprovalHubStore.setState({
      selectedIds: new Set(['f193-1', 'f260-1']),
    });
    await useApprovalHubStore.getState().batchReject();

    const calls = mockApiFetch.mock.calls.map((c) => c[0] as string);
    expect(calls).toContain('/api/dispatch-proposals/f193-1/reject');
    expect(calls).toContain('/api/entity-proposals/f260-1/reject');
  });

  // --- Fallback for unknown item ---

  it('falls back to dispatch-proposals when proposalId not found in items', async () => {
    await useApprovalHubStore.getState().approveProposal('unknown-id');
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/dispatch-proposals/unknown-id/approve',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
