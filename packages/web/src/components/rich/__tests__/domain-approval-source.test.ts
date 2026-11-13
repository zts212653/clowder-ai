import type { RichCardBlock, UnifiedAttentionItemV1 } from '@cat-cafe/shared';
import { beforeEach, expect, it, vi } from 'vitest';
import { collectiveFailure } from '@/components/shell/mailbox/__tests__/collective-failure.fixture';
import { approvalRow, okRead, storeItem } from '@/components/shell/mailbox/__tests__/mailbox-fixtures';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { apiFetch } from '@/utils/api-client';
import { readDomainApprovalSource } from '../read-domain-approval-source';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
const block: RichCardBlock = {
  id: 'dispatch-p-1',
  kind: 'card',
  v: 1,
  title: 'Original proposal',
  bodyMarkdown: 'Original request',
  meta: { approval: { producerId: 'F193', canonicalProposalId: 'p-1' } },
};
const item = storeItem({
  sourceFeatureId: 'F193',
  createdAt: Date.now(),
  detail: { content: 'Original request' },
  navigation: {
    state: 'anchored',
    originRef: { kind: 'message', threadId: 'thread-src', messageId: 'origin' },
    approvalCardRef: { threadId: 'thread-src', messageId: 'card-msg' },
  },
});
const coordinate = { threadId: 'thread-src', messageId: 'card-msg' };
const row = { ...approvalRow(item), originalApprovalCard: { cardRef: { ...coordinate, blockId: block.id }, block } };
function body(rows: UnifiedAttentionItemV1[] = [row], offset = 0, hasMore = false) {
  const state = okRead(rows, { page: { offset, limit: 20, scope: 'known_rows', hasMore } });
  return state.kind === 'ok' ? state.read : null;
}
beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  useApprovalHubStore.setState({ items: [], pendingReadAvailable: false, isLoading: false });
  vi.mocked(apiFetch).mockImplementation(
    async (path) =>
      ({
        ok: true,
        json: async () =>
          String(path) === '/api/session'
            ? { userId: 'owner-1' }
            : String(path).includes('/approval-hub/pending')
              ? { items: [item], count: 1 }
              : body(),
      }) as Response,
  );
});
it('reads an ignored but still pending original card from the canonical vector', async () => {
  expect((await readDomainApprovalSource(block, coordinate))?.item.proposalId).toBe(item.proposalId);
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.filter(([path]) => String(path).includes('/concierge/'))
      .every(([path]) => !String(path).includes('personalView')),
  ).toBe(true);
});
it('finds the twenty-first original card rather than treating the first page as handled', async () => {
  vi.mocked(apiFetch).mockImplementation(
    async (path) =>
      ({
        ok: true,
        json: async () =>
          String(path) === '/api/session'
            ? { userId: 'owner-1' }
            : String(path).includes('/approval-hub/pending')
              ? { items: [item], count: 1 }
              : String(path).includes('offset=20')
                ? body([row], 20)
                : body(
                    Array.from({ length: 20 }, (_, index) =>
                      approvalRow(storeItem({ proposalId: `earlier-${index}` })),
                    ),
                    0,
                    true,
                  ),
      }) as Response,
  );
  expect((await readDomainApprovalSource(block, coordinate))?.item.proposalId).toBe(item.proposalId);
  expect(vi.mocked(apiFetch).mock.calls.some(([path]) => String(path).includes('offset=20'))).toBe(true);
});
it('keeps absence unverified and does not fabricate a handled record', async () => {
  vi.mocked(apiFetch).mockImplementation(
    async (path) =>
      ({
        ok: true,
        json: async () => (String(path) === '/api/session' ? { userId: 'owner-1' } : body([])),
      }) as Response,
  );
  expect(await readDomainApprovalSource(block, coordinate)).toBeNull();
});
it('refuses a mismatched publication and a changed owner', async () => {
  expect(await readDomainApprovalSource({ ...block, title: 'Altered' }, coordinate)).toBeNull();
  expect(await readDomainApprovalSource(block, { ...coordinate, messageId: 'foreign' })).toBeNull();
  useApprovalHubStore.setState({ items: [item], pendingReadAvailable: true });
  vi.mocked(apiFetch).mockImplementation(
    async (path) =>
      ({
        ok: true,
        json: async () =>
          String(path) === '/api/session' ? { userId: 'owner-1' } : { ...body(), identity: { ownerUserId: 'other' } },
      }) as Response,
  );
  expect(await readDomainApprovalSource(block, coordinate)).toBeNull();
});
it('refuses a fresh Hub copy anchored to another publication', async () => {
  vi.mocked(apiFetch).mockImplementation(
    async (path) =>
      ({
        ok: true,
        json: async () =>
          String(path) === '/api/session'
            ? { userId: 'owner-1' }
            : String(path).includes('/approval-hub/pending')
              ? {
                  items: [
                    {
                      ...item,
                      navigation: {
                        ...item.navigation,
                        approvalCardRef: { threadId: 'different-thread', messageId: 'different-card' },
                      },
                    },
                  ],
                  count: 1,
                }
              : body(),
      }) as Response,
  );
  expect(await readDomainApprovalSource(block, coordinate)).toBeNull();
});

it.each([
  'F193',
  'F221',
  'F260',
] as const)('keeps %s original approval cards readable during Collective plugin, connection, and project attention outages', async (feature) => {
  const prefix = feature === 'F193' ? 'dispatch' : feature === 'F221' ? 'taste-proposal' : 'entity-proposal';
  const featureBlock: RichCardBlock = {
    id: `${prefix}-p-1`,
    kind: 'card',
    v: 1,
    title: 'Original proposal',
    bodyMarkdown: 'Original request',
    meta: { approval: { producerId: feature, canonicalProposalId: 'p-1' } },
  };
  const featureItem = storeItem({
    sourceFeatureId: feature,
    createdAt: Date.now(),
    detail: { content: 'Original request' },
    navigation: item.navigation,
  });
  const featureRow = {
    ...approvalRow(featureItem),
    originalApprovalCard: { cardRef: { ...coordinate, blockId: featureBlock.id }, block: featureBlock },
  };
  const dualOutage = collectiveFailure(okRead([featureRow]), true);
  if (dualOutage.kind !== 'ok') throw new Error('Expected ok read');

  const partialMultiConnection = structuredClone(dualOutage.read);
  partialMultiConnection.sources.collectiveAccountabilityRequests = {
    status: 'available',
    coverage: 'pending_f290_collective_accountability_requests',
    exhaustiveness: 'partial',
    startedAt: 1,
    observedAt: 2,
  };
  partialMultiConnection.sources.collectiveProjectAttention = {
    status: 'available',
    coverage: 'pending_f290_project_materials_and_dates',
    exhaustiveness: 'partial',
    startedAt: 1,
    observedAt: 2,
  };
  partialMultiConnection.consistency = {
    state: 'uncertain',
    reasons: ['collective_accountability_connection_read_failed', 'collective_project_attention_source_unavailable'],
  };

  const revokingAuthorityOutage = structuredClone(dualOutage.read);
  revokingAuthorityOutage.sources.collectiveAccountabilityRequests = {
    status: 'unavailable',
    coverage: 'pending_f290_collective_accountability_requests',
    exhaustiveness: 'partial',
    startedAt: 1,
    observedAt: 2,
  };
  revokingAuthorityOutage.consistency = {
    state: 'uncertain',
    reasons: ['collective_accountability_connection_authority_unavailable'],
  };

  for (const candidateRead of [dualOutage.read, partialMultiConnection, revokingAuthorityOutage]) {
    useApprovalHubStore.setState({ items: [], pendingReadAvailable: false, isLoading: false });
    vi.mocked(apiFetch).mockImplementation(
      async (path) =>
        ({
          ok: true,
          json: async () =>
            String(path) === '/api/session'
              ? { userId: 'owner-1' }
              : String(path).includes('/approval-hub/pending')
                ? { items: [featureItem], count: 1 }
                : candidateRead,
        }) as Response,
    );
    expect((await readDomainApprovalSource(featureBlock, coordinate))?.item.proposalId).toBe(featureItem.proposalId);
  }

  const degradedApprovals = structuredClone(dualOutage.read);
  degradedApprovals.sources.approvals.exhaustiveness = 'partial';
  vi.mocked(apiFetch).mockImplementation(
    async (path) =>
      ({
        ok: true,
        json: async () =>
          String(path) === '/api/session'
            ? { userId: 'owner-1' }
            : String(path).includes('/approval-hub/pending')
              ? { items: [featureItem], count: 1 }
              : degradedApprovals,
      }) as Response,
  );
  expect(await readDomainApprovalSource(featureBlock, coordinate)).toBeNull();

  const conflictRead = structuredClone(dualOutage.read);
  conflictRead.consistency.reasons = ['collective_project_attention_identity_conflict'];
  vi.mocked(apiFetch).mockImplementation(
    async (path) =>
      ({
        ok: true,
        json: async () =>
          String(path) === '/api/session'
            ? { userId: 'owner-1' }
            : String(path).includes('/approval-hub/pending')
              ? { items: [featureItem], count: 1 }
              : conflictRead,
      }) as Response,
  );
  expect(await readDomainApprovalSource(featureBlock, coordinate)).toBeNull();
});
