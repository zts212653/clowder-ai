/**
 * F246 / F322 S3-2b-2: what each decision request saw, as evidence a second host can read.
 *
 * The store used to squash every failed decision into one global `error` string, so a host that renders the same card
 * somewhere else (the 待办 panel) could not tell a final 401 from a 403 from "the request may or may not have landed".
 * `decisionAttempts[proposalId]` records the raw fact of the latest attempt: that it is under way, the HTTP status that
 * came back, that no response came back, or that the card refused before sending. It is never a business outcome and
 * its absence never means success: whether the proposal was decided is for a canonical re-read to say.
 */
import type { ApprovalHubItem, EntityConflictResolutionRequest } from '@cat-cafe/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { anchoredApprovalNavigation } from '@/test-support/approval-navigation';

const mockApiFetch = vi.fn();
vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

import { useApprovalHubStore } from '../approvalHubStore';

const base = {
  navigation: anchoredApprovalNavigation('thread-src'),
  requesterCatId: 'opus',
  ownerUserId: 'owner-1',
  resolution: 'open',
  materialization: { state: 'not_started' },
  createdAt: 1234,
} as const;

const GENERIC: ApprovalHubItem = {
  ...base,
  proposalId: 'p-generic',
  sourceFeatureId: 'F128',
  summary: 'New thread: 记一条品味',
  detail: {},
  inlineApprovable: true,
};
const PERSON: ApprovalHubItem = {
  ...base,
  proposalId: 'p-person',
  sourceFeatureId: 'F276',
  decisionMode: 'claim-select',
  summary: '记住人物：黄挺',
  detail: { displayName: '黄挺', remainingDraftIds: ['d1', 'd2'] },
  inlineApprovable: true,
};
const ENTITY: ApprovalHubItem = {
  ...base,
  proposalId: 'p-entity',
  sourceFeatureId: 'F260',
  summary: 'Entity proposal: 沉迷护栏',
  detail: { entityId: 'concept:沉迷护栏' },
  inlineApprovable: true,
};
const CONFLICT = {
  version: 1,
  reason: 'existing-entity-change',
  fingerprint: 'b'.repeat(64),
  allowedActions: ['merge-aliases', 'reject'],
  canonicalReplacementRequiredFor: [],
};
const RESOLVE = { action: 'merge-aliases', fingerprint: 'a'.repeat(64) } as EntityConflictResolutionRequest;

const store = () => useApprovalHubStore.getState();

interface ActionCase {
  name: string;
  kind: string;
  item: ApprovalHubItem;
  okBody: unknown;
  run: () => Promise<unknown>;
}

const ACTIONS: ActionCase[] = [
  {
    name: 'approve',
    kind: 'approve',
    item: GENERIC,
    okBody: {},
    run: () => store().approveProposal(GENERIC.proposalId),
  },
  {
    name: 'reject',
    kind: 'reject',
    item: GENERIC,
    okBody: {},
    run: () => store().rejectProposal(GENERIC.proposalId, { reasonCode: 'wrong' }),
  },
  {
    name: 'person-memory approve',
    kind: 'person-memory-approve',
    item: PERSON,
    okBody: { status: 'materialized' },
    run: () => store().approvePersonMemory(PERSON.proposalId, ['d1']),
  },
  {
    name: 'person-memory not-now',
    kind: 'person-memory-not-now',
    item: PERSON,
    okBody: {},
    run: () => store().notNowPersonMemory(PERSON.proposalId),
  },
  {
    name: 'person-memory withdraw',
    kind: 'person-memory-withdraw',
    item: PERSON,
    okBody: {},
    run: () => store().withdrawPersonMemory(PERSON.proposalId),
  },
  {
    name: 'entity resolve',
    kind: 'entity-resolve',
    item: ENTITY,
    okBody: { proposalId: 'p-entity', entityId: 'concept:沉迷护栏', status: 'approved' },
    run: () => store().resolveEntityConflict(ENTITY.proposalId, RESOLVE),
  },
];

const respond = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

function deferred() {
  let settle: (value: unknown) => void = () => undefined;
  const promise = new Promise((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

describe('approvalHubStore decisionAttempts', () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    useApprovalHubStore.setState({
      items: [GENERIC, PERSON, ENTITY],
      count: 3,
      deciding: {},
      selectedIds: new Set<string>(),
      batchResults: [],
      error: null,
      decisionAttempts: {},
    });
  });

  describe.each(ACTIONS)('$name', ({ kind, item, okBody, run }) => {
    it('is visible as submitting while the request is in flight, tied to the action and the exact item', async () => {
      const pending = deferred();
      mockApiFetch.mockImplementationOnce(() => pending.promise);
      const done = run();

      const attempt = store().decisionAttempts[item.proposalId];
      expect(attempt).toMatchObject({
        action: kind,
        sourceFeatureId: item.sourceFeatureId,
        createdAt: item.createdAt,
        state: { phase: 'submitting' },
      });
      expect(typeof attempt?.attemptId).toBe('number');

      pending.settle(respond(200, okBody));
      await done;
    });

    it('records a 2xx as a response received and nothing more', async () => {
      mockApiFetch.mockResolvedValueOnce(respond(200, okBody));
      await run();
      expect(store().decisionAttempts[item.proposalId]?.state).toEqual({
        phase: 'response_received',
        status: 200,
        ok: true,
      });
    });

    it.each([
      401, 403, 409, 500,
    ])('records a %i with the status the server answered, and keeps the global error', async (status) => {
      mockApiFetch.mockResolvedValueOnce(respond(status, { error: 'refused_by_server', message: '服务端说不行' }));
      await run();
      expect(store().decisionAttempts[item.proposalId]?.state).toMatchObject({
        phase: 'response_received',
        status,
        ok: false,
        errorCode: 'refused_by_server',
      });
      expect(store().error).toContain('服务端说不行');
    });

    it('records a request that got no response at all as transport_unknown, and keeps the global error', async () => {
      mockApiFetch.mockRejectedValueOnce(new Error('offline'));
      await run();
      expect(store().decisionAttempts[item.proposalId]?.state).toEqual({ phase: 'transport_unknown' });
      expect(store().error).toBe('offline');
    });

    it('lets a newer attempt replace the older at once, and an older answer arriving late cannot overwrite it', async () => {
      const first = deferred();
      const second = deferred();
      mockApiFetch.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);

      const firstDone = run();
      const firstId = store().decisionAttempts[item.proposalId]?.attemptId;
      const secondDone = run();
      const secondId = store().decisionAttempts[item.proposalId]?.attemptId;
      expect(secondId).toBeGreaterThan(firstId as number);

      second.settle(respond(200, okBody));
      await secondDone;
      first.settle(respond(403, { error: 'forbidden' }));
      await firstDone;

      expect(store().decisionAttempts[item.proposalId]).toMatchObject({
        attemptId: secondId,
        state: { phase: 'response_received', status: 200, ok: true },
      });
    });

    it('is cleared only by consuming its own attempt, and a later attempt starts clean', async () => {
      mockApiFetch.mockResolvedValueOnce(respond(403, { error: 'forbidden' }));
      await run();
      const attemptId = store().decisionAttempts[item.proposalId]?.attemptId as number;

      store().consumeDecisionAttempt(item.proposalId, attemptId + 1000);
      expect(store().decisionAttempts[item.proposalId]?.attemptId).toBe(attemptId);

      store().consumeDecisionAttempt(item.proposalId, attemptId);
      expect(store().decisionAttempts[item.proposalId]).toBeUndefined();

      const pending = deferred();
      mockApiFetch.mockImplementationOnce(() => pending.promise);
      useApprovalHubStore.setState({ items: [GENERIC, PERSON, ENTITY], count: 3 });
      const done = run();
      expect(store().decisionAttempts[item.proposalId]?.state).toEqual({ phase: 'submitting' });
      pending.settle(respond(200, okBody));
      await done;
    });
  });

  describe('when the card refuses before sending anything', () => {
    it('records an empty F276 selection as client_validation and sends nothing', async () => {
      await store().approvePersonMemory(PERSON.proposalId, []);
      expect(mockApiFetch).not.toHaveBeenCalled();
      expect(store().decisionAttempts[PERSON.proposalId]).toMatchObject({
        action: 'person-memory-approve',
        state: { phase: 'client_validation' },
      });
      expect(store().error).toBe('Person memory approval requires an exact non-empty draft selection');
    });

    it('records a stale F276 selection as client_validation and sends nothing', async () => {
      await store().approvePersonMemory(PERSON.proposalId, ['d1', 'gone']);
      expect(mockApiFetch).not.toHaveBeenCalled();
      expect(store().decisionAttempts[PERSON.proposalId]?.state).toMatchObject({ phase: 'client_validation' });
      expect(store().error).toBe('Person memory approval selection is stale');
    });

    it('records not-now and withdraw on something that is not a person-memory proposal the same way', async () => {
      await store().notNowPersonMemory(GENERIC.proposalId);
      expect(store().decisionAttempts[GENERIC.proposalId]).toMatchObject({
        action: 'person-memory-not-now',
        state: { phase: 'client_validation' },
      });
      await store().withdrawPersonMemory(GENERIC.proposalId);
      expect(store().decisionAttempts[GENERIC.proposalId]).toMatchObject({
        action: 'person-memory-withdraw',
        state: { phase: 'client_validation' },
      });
      expect(mockApiFetch).not.toHaveBeenCalled();
    });
  });

  describe('a producer whose decision belongs on its own origin card', () => {
    const RUNTIME: ApprovalHubItem = {
      ...base,
      proposalId: 'p-runtime',
      sourceFeatureId: 'F306',
      summary: '运行时请求',
      detail: {},
      inlineApprovable: false,
    };

    it.each([
      ['approve', () => store().approveProposal(RUNTIME.proposalId), 'approve'],
      ['reject', () => store().rejectProposal(RUNTIME.proposalId), 'reject'],
    ])('records %s as refused before sending, not as a request that may have landed', async (_name, run, kind) => {
      useApprovalHubStore.setState({ items: [RUNTIME], count: 1 });
      await run();
      expect(mockApiFetch).not.toHaveBeenCalled();
      expect(store().decisionAttempts[RUNTIME.proposalId]).toMatchObject({
        action: kind,
        state: { phase: 'client_validation' },
      });
      expect(store().error).toContain('canonical origin card');
    });
  });

  describe('a conflict the producer answered with a typed payload', () => {
    it('still updates the card for approve, and the attempt records the 409 beside it', async () => {
      mockApiFetch.mockResolvedValueOnce(
        respond(409, { error: 'conflict', message: '实体已变化', conflict: CONFLICT }),
      );
      await store().approveProposal(GENERIC.proposalId);

      const updated = store().items.find((candidate) => candidate.proposalId === GENERIC.proposalId);
      expect(updated?.detail.conflict).toEqual(CONFLICT);
      expect(updated?.detail.conflictError).toBe('实体已变化');
      expect(store().error).toBeNull();
      expect(store().decisionAttempts[GENERIC.proposalId]?.state).toMatchObject({
        phase: 'response_received',
        status: 409,
        ok: false,
      });
    });

    it('still updates the card for entity resolve, and the attempt records the 409 beside it', async () => {
      mockApiFetch.mockResolvedValueOnce(
        respond(409, { error: 'conflict', message: '指纹已变化', conflict: CONFLICT }),
      );
      await store().resolveEntityConflict(ENTITY.proposalId, RESOLVE);

      const updated = store().items.find((candidate) => candidate.proposalId === ENTITY.proposalId);
      expect(updated?.detail.conflict).toEqual(CONFLICT);
      expect(updated?.detail.conflictError).toBe('指纹已变化');
      expect(store().decisionAttempts[ENTITY.proposalId]?.state).toMatchObject({
        phase: 'response_received',
        status: 409,
      });
    });
  });

  it('keeps the attempts of different proposals apart', async () => {
    mockApiFetch.mockResolvedValueOnce(respond(403, { error: 'forbidden' })).mockResolvedValueOnce(respond(200, {}));
    await store().approveProposal(GENERIC.proposalId);
    await store().withdrawPersonMemory(PERSON.proposalId);
    expect(store().decisionAttempts[GENERIC.proposalId]?.state).toMatchObject({ status: 403 });
    expect(store().decisionAttempts[PERSON.proposalId]?.state).toMatchObject({ status: 200, ok: true });
  });
});
