import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ApprovalHubItem,
  ApprovalProducerId,
  ProfileUpdateProposal,
  RichCardBlock,
  SessionHandoffProposal,
} from '@cat-cafe/shared';
import Fastify from 'fastify';
import { buildApprovalCardBlock } from '../../src/domains/approval-hub/buildApprovalCardBlock.js';
import { buildHandoffProposalCardBlock } from '../../src/domains/cats/services/session/sessionHandoffPropose.js';
import { MessageStore } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { readCompanionDecisionProjection } from '../../src/routes/companion-decision-read-service.js';
import { buildProfileUpdateCardBlock } from '../../src/routes/profile-update-card-block.js';
import { informationalOriginalFixture } from './informational-original-card.fixture.js';
import { approval } from './unified-attention-fixtures.js';

const ownerUserId = 'owner';
const requesterCatId = 'codex-sol';
const cardThreadId = 'thread-card';

function originalCard(producerId: 'F225' | 'F231', proposalId: string): RichCardBlock {
  const featureCard =
    producerId === 'F225'
      ? buildHandoffProposalCardBlock(handoffProposal(proposalId))
      : buildProfileUpdateCardBlock(profileProposal(proposalId));
  return buildApprovalCardBlock({ producerId, canonicalProposalId: proposalId }, featureCard) as RichCardBlock;
}

for (const feature of ['F193', 'F221', 'F260'] as const) {
  test(`${feature} verifies its real no-actions publication against the current owner snapshot`, async (t) => {
    const fixture = await informationalOriginalFixture(feature);
    t.after(fixture.close);
    const result = await fixture.project();
    assert.deepEqual(result.items[0]?.originalApprovalCard?.block, fixture.block);
    assert.deepEqual(result.items[0]?.originalApprovalCard?.cardRef, {
      ...fixture.envelope.approvalCardRef,
      blockId: fixture.block.id,
    });
    assert.equal(result.items[0]?.approval?.inlineApprovable, true);
    assert.equal(result.consistency.state, 'verified');
    assert.equal(result.totalCount, 1);
  });
}

test('F221 correction verifies the correction branch and exact suggested patch', async (t) => {
  const fixture = await informationalOriginalFixture('F221', true);
  t.after(fixture.close);
  const result = await fixture.project();
  assert.deepEqual(result.items[0]?.originalApprovalCard?.block, fixture.block);
});

const informationMutations: Array<[string, (block: RichCardBlock) => RichCardBlock[]]> = [
  ['duplicate id', (block) => [block, { ...block, meta: undefined }]],
  ['duplicate stamp', (block) => [block, { ...block, id: 'another-card' }]],
  [
    'wrong producer',
    (block) => [{ ...block, meta: { approval: { ...(block.meta?.approval as object), producerId: 'F225' } } }],
  ],
  [
    'wrong proposal',
    (block) => [
      { ...block, meta: { approval: { ...(block.meta?.approval as object), canonicalProposalId: 'different' } } },
    ],
  ],
  ['empty actions', (block) => [{ ...block, actions: [] }]],
  [
    'injected action',
    (block) => [{ ...block, actions: [{ label: 'Approve', action: 'approve', payload: { proposalId: 'different' } }] }],
  ],
  ['changed id', (block) => [{ ...block, id: 'fake-card' }]],
  ['changed title', (block) => [{ ...block, title: 'Different decision' }]],
  ['changed body', (block) => [{ ...block, bodyMarkdown: 'Different original request' }]],
  ['changed tone', (block) => [{ ...block, tone: 'warning' }]],
  [
    'changed fields',
    (block) => [
      {
        ...block,
        fields: block.fields?.map((field, index) => (index === 0 ? { ...field, value: 'Different source' } : field)),
      },
    ],
  ],
  ['extra metadata', (block) => [{ ...block, meta: { ...block.meta, fakeAuthority: true } }]],
  [
    'extra stamp key',
    (block) => [{ ...block, meta: { approval: { ...(block.meta?.approval as object), authorized: true } } }],
  ],
];

for (const feature of ['F193', 'F221', 'F260'] as const) {
  test(`${feature} rejects altered informational publication and suppresses all exact counts`, async (t) => {
    const fixture = await informationalOriginalFixture(feature);
    t.after(fixture.close);
    const mutations = [
      ...informationMutations.map(
        ([name, mutate]) =>
          [
            name,
            (message: typeof fixture.stored) => ({
              ...message,
              extra: { ...message.extra, rich: { v: 1 as const, blocks: mutate(fixture.block) } },
            }),
          ] as const,
      ),
      ['foreign owner', (message: typeof fixture.stored) => ({ ...message, userId: 'foreign' })] as const,
      ['foreign thread', (message: typeof fixture.stored) => ({ ...message, threadId: 'foreign' })] as const,
      [
        'foreign message reference',
        (message: typeof fixture.stored) => ({ ...message, id: 'another-message' }),
      ] as const,
      [
        'foreign requester',
        (message: typeof fixture.stored) => ({
          ...message,
          from: { kind: 'agent' as const, catId: 'kimi' as never },
          catId: 'kimi' as never,
        }),
      ] as const,
      ['deleted', (message: typeof fixture.stored) => ({ ...message, deletedAt: Date.now() })] as const,
      ['tombstoned', (message: typeof fixture.stored) => ({ ...message, _tombstone: true })] as const,
      ['missing reference', () => null] as const,
    ];
    for (const [name, mutate] of mutations) {
      await t.test(name, async () => {
        const result = await fixture.project(mutate);
        assert.equal(result.items[0]?.originalApprovalCard, undefined);
        assert.equal(result.consistency.state, 'uncertain');
        assert.ok(result.consistency.reasons.includes('original_approval_card_unverified'));
        for (const field of [
          'totalCount',
          'attentionCount',
          'approvalCount',
          'needsMeCount',
          'otherNeedsMeCount',
        ] as const)
          assert.equal(result[field], undefined, field);
        assert.equal(result.personalView?.originalTotalCount, undefined);
        assert.equal(result.personalView?.groupCounts, undefined);
      });
    }
  });
}

test('proof withdrawal invalidates Ignore without settling the original proposal', async (t) => {
  const fixture = await informationalOriginalFixture('F221');
  t.after(fixture.close);
  const original = await fixture.project();
  const coordinate = original.items[0]?.preferenceCoordinate;
  assert.ok(coordinate);
  const ignored = [{ coordinate, ignoredAt: Date.now() }];
  assert.equal((await fixture.project(undefined, ignored)).items.length, 0);
  const changed = await fixture.project((message) => ({ ...message, deletedAt: Date.now() }), ignored);
  assert.equal(changed.items.length, 1);
  assert.notEqual(changed.items[0]?.preferenceCoordinate?.version, coordinate.version);
  assert.equal(fixture.taste.get('taste-one')?.status, 'pending');
});

test('F221 approving retains the same proof without ordinary pending authority', async (t) => {
  const fixture = await informationalOriginalFixture('F221');
  t.after(fixture.close);
  assert.ok(fixture.taste.claimForApproval('taste-one', 'owner'));
  const result = await fixture.project();
  assert.deepEqual(result.items[0]?.originalApprovalCard?.block, fixture.block);
  assert.equal(result.items[0]?.approval?.resolution, 'accepted');
  assert.equal(result.items[0]?.approval?.inlineApprovable, false);
});

for (const feature of ['F193', 'F221', 'F260'] as const) {
  test(`${feature} terminal source retires the original proof instead of creating a second lifecycle`, async (t) => {
    const fixture = await informationalOriginalFixture(feature);
    t.after(fixture.close);
    if (feature === 'F193') await fixture.dispatch.reject('dispatch-one', 'owner');
    else if (feature === 'F221') fixture.taste.markRejected('taste-one', 'declined', 'owner');
    else fixture.entity.markRejected('entity-one', 'owner');
    assert.equal((await fixture.project()).items.length, 0);
  });
}

function handoffProposal(proposalId: string): SessionHandoffProposal {
  return {
    kind: 'session_handoff',
    proposalId,
    status: 'pending',
    sourceThreadId: cardThreadId,
    sourceSessionId: 'session-one',
    sourceCatId: requesterCatId as never,
    sourceMessageId: 'origin-message',
    userId: ownerUserId,
    note: {
      proposalId,
      sourceSessionId: 'session-one',
      done: 'Finished the current step',
      nextSteps: 'Continue after approval',
      persistedAt: 10,
    },
    createdAt: 10,
    updatedAt: 10,
  };
}

function profileProposal(proposalId: string): ProfileUpdateProposal {
  return {
    proposalId,
    status: 'pending',
    sourceThreadId: cardThreadId,
    sourceInvocationId: 'invocation-one',
    sourceCatId: requesterCatId as never,
    targetLayer: 'primer',
    targetPath: 'relationship/sol-primer.md',
    beforeContent: 'before',
    baseContentHash: 'hash',
    afterContent: 'after',
    rationale: 'Keep the relationship fact current',
    signalProvenance: {
      kind: 'message-coordinate',
      sourceThreadId: cardThreadId,
      sourceMessageId: 'origin-message',
    },
    createdBy: ownerUserId,
    createdAt: 10,
  };
}

async function projectOriginalCard(input: {
  producerId?: 'F225' | 'F231';
  proposalId?: string;
  blocks?: RichCardBlock[];
  messageOwner?: string;
  messageRequester?: string;
  rowThreadId?: string;
  deleteMessage?: boolean;
}) {
  const producerId = input.producerId ?? 'F225';
  const proposalId = input.proposalId ?? 'proposal-one';
  const messages = new MessageStore();
  const stored = await messages.append({
    userId: input.messageOwner ?? ownerUserId,
    from: { kind: 'agent', catId: (input.messageRequester ?? requesterCatId) as never },
    threadId: cardThreadId,
    content: 'canonical original approval card',
    mentions: [],
    timestamp: 10,
    extra: { rich: { v: 1, blocks: input.blocks ?? [originalCard(producerId, proposalId)] } },
  });
  if (input.deleteMessage) await messages.softDelete(stored.id, ownerUserId);
  const row: ApprovalHubItem = {
    ...approval(proposalId, producerId),
    requesterCatId,
    navigation: {
      state: 'anchored',
      originRef: { kind: 'message', threadId: input.rowThreadId ?? cardThreadId, messageId: 'origin-message' },
      approvalCardRef: { threadId: input.rowThreadId ?? cardThreadId, messageId: stored.id },
    },
  };
  const app = Fastify();
  app.get('/api/approval-hub/pending', async () => ({ items: [row], coverage: { state: 'complete' } }));
  app.get('/api/entrusted-work/needs-me', async () => ({ ownerReads: [], coverage: { state: 'complete' } }));
  const result = await readCompanionDecisionProjection(app, ownerUserId, { offset: 0, limit: 20 }, messages);
  await app.close();
  return { result, stored, row };
}

for (const producerId of ['F225', 'F231'] as const satisfies readonly ApprovalProducerId[]) {
  test(`${producerId} exposes the verified original approval card without changing inline authority`, async () => {
    const { result, stored } = await projectOriginalCard({ producerId });
    const item = result.items[0] as (typeof result.items)[number] & {
      originalApprovalCard?: {
        cardRef: { threadId: string; messageId: string; blockId: string };
        block: RichCardBlock;
      };
    };

    assert.equal(item.approval?.inlineApprovable, false);
    assert.deepEqual(item.originalApprovalCard?.cardRef, {
      threadId: cardThreadId,
      messageId: stored.id,
      blockId: originalCard(producerId, 'proposal-one').id,
    });
    assert.deepEqual(item.originalApprovalCard?.block, originalCard(producerId, 'proposal-one'));
    assert.equal(result.consistency.state, 'verified');
    assert.equal(result.totalCount, 1);
  });
}

for (const [name, mutate] of [
  ['foreign owner', () => ({ messageOwner: 'other-owner' })],
  ['foreign thread', () => ({ rowThreadId: 'other-thread' })],
  ['foreign requester', () => ({ messageRequester: 'other-cat' })],
  ['deleted card', () => ({ deleteMessage: true })],
  [
    'multiple ingress stamps',
    () => ({
      blocks: [originalCard('F225', 'proposal-one'), originalCard('F225', 'proposal-one')],
    }),
  ],
  ['wrong proposal stamp', () => ({ blocks: [originalCard('F225', 'another-proposal')] })],
  [
    'wrong action payload',
    () => {
      const block = originalCard('F225', 'proposal-one');
      return {
        blocks: [
          {
            ...block,
            actions: block.actions?.map((action, index) =>
              index === 0 ? { ...action, payload: { proposalId: 'another-proposal' } } : action,
            ),
          },
        ],
      };
    },
  ],
] as const) {
  test(`${name} withholds write-capable original-card proof and every exact count`, async () => {
    const { result } = await projectOriginalCard(mutate());
    const item = result.items[0] as (typeof result.items)[number] & { originalApprovalCard?: unknown };
    assert.equal(item.originalApprovalCard, undefined);
    assert.equal(result.consistency.state, 'uncertain');
    assert.ok(result.consistency.reasons.includes('original_approval_card_unverified'));
    assert.equal(result.totalCount, undefined);
    assert.equal(result.attentionCount, undefined);
  });
}
