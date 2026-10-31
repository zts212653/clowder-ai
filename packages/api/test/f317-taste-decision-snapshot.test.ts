import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { SessionMutex } from '../src/domains/cats/services/agents/invocation/SessionMutex.js';
import { validateHostCompanionReply } from '../src/domains/plugin/desktop-window-runtime/companion-private-wire.js';
import { approveTasteProposal } from '../src/domains/taste/services/approveTasteProposal.js';
import {
  matchesTasteDecisionSnapshot,
  tasteDecisionSnapshot,
} from '../src/domains/taste/services/taste-decision-snapshot.js';
import { InMemoryTasteProposalStore } from '../src/domains/taste/stores/InMemoryTasteProposalStore.js';

async function anchoredProposal(store: InMemoryTasteProposalStore, takeaway?: string) {
  const proposal = store.create({
    proposalId: randomUUID(),
    userId: 'owner',
    catId: 'codex',
    threadId: 'home',
    sourceMessageId: 'source-1',
    scene: '讨论留白',
    quote: '不要塞满',
    ...(takeaway ? { takeaway } : {}),
    tags: ['留白'],
    dimension: 'visual-quality',
    privacy: 'sensitive',
  });
  await store.commitEnvelope(proposal.id, {
    canonicalProposalId: proposal.id,
    sourceFeatureId: 'F221',
    ownerUserId: 'owner',
    requesterCatId: 'codex',
    originRef: { kind: 'message', threadId: 'home', messageId: 'source-1' },
    approvalCardRef: { threadId: 'home', messageId: 'card-1' },
    createdAt: proposal.createdAt,
  });
  const anchored = await store.get(proposal.id);
  assert.ok(anchored);
  return anchored;
}

test('a voice decision snapshot requires an anchored, pending canonical proposal', async () => {
  const store = new InMemoryTasteProposalStore();
  const staged = store.create({
    userId: 'owner',
    catId: 'codex',
    threadId: 'home',
    scene: '场景',
    quote: '原话',
    tags: [],
    dimension: 'visual-quality',
    privacy: 'public',
  });
  assert.equal(tasteDecisionSnapshot(staged), null);
  const proposal = await anchoredProposal(store);
  const snapshot = tasteDecisionSnapshot(proposal);
  assert.ok(snapshot);
  assert.match(snapshot.digest, /^[0-9a-f]{64}$/);
  assert.equal(snapshot.proposalId, proposal.id);
  assert.equal(snapshot.ownerUserId, 'owner');
  assert.equal(snapshot.fields.publication, JSON.stringify(proposal.publication));
  assert.equal(snapshot.fields.takeaway, '', 'legacy proposals have one stable empty-string snapshot value');
});

test('the decision snapshot includes the takeaway that a real vignette would publish', async () => {
  const store = new InMemoryTasteProposalStore();
  const proposal = await anchoredProposal(store, 'ORIGINAL');
  const snapshot = tasteDecisionSnapshot(proposal);
  assert.ok(snapshot);
  assert.equal(snapshot.fields.takeaway, 'ORIGINAL');
  const changed = { ...proposal, takeaway: 'MUTATED AFTER PREVIEW' };
  assert.equal(matchesTasteDecisionSnapshot(changed, snapshot), false);
  const preview = {
    kind: 'f221-preview',
    snapshot: { ...snapshot, nonce: 'a'.repeat(48), expiresAt: Date.now() + 120_000 },
  };
  assert.equal(validateHostCompanionReply(preview), true);
  const omitted = structuredClone(preview);
  Reflect.deleteProperty(omitted.snapshot.fields, 'takeaway');
  assert.equal(validateHostCompanionReply(omitted), false, 'Host must not silently drop published material');
});

test('the decision snapshot binds the exact source revision and patch of a correction proposal', async () => {
  const store = new InMemoryTasteProposalStore();
  const proposal = store.create({
    proposalId: randomUUID(),
    userId: 'owner',
    catId: 'codex',
    threadId: 'home',
    scene: '修订已有品味',
    quote: '原话',
    tags: ['source-bound'],
    dimension: 'cognitive-honesty',
    privacy: 'public',
    correctionTarget: {
      sourceAnchor: 'taste-vignette:docs/taste/vignettes/example.md',
      expectedRevision: `sha256:${'a'.repeat(64)}`,
      reason: 'outdated',
      suggestedPatch: { takeaway: '更新后的判断。' },
    },
  });
  await store.commitEnvelope(proposal.id, {
    canonicalProposalId: proposal.id,
    sourceFeatureId: 'F221',
    ownerUserId: proposal.userId,
    requesterCatId: proposal.catId,
    originRef: { kind: 'message', threadId: proposal.threadId, messageId: 'source-correction' },
    approvalCardRef: { threadId: proposal.threadId, messageId: 'card-correction' },
    createdAt: proposal.createdAt,
  });
  const anchored = store.get(proposal.id);
  assert.ok(anchored);
  const snapshot = tasteDecisionSnapshot(anchored);
  assert.ok(snapshot);
  assert.equal(snapshot.fields.correctionTarget, JSON.stringify(anchored.correctionTarget));
  const changed = structuredClone(anchored);
  assert.ok(changed.correctionTarget);
  changed.correctionTarget.expectedRevision = `sha256:${'b'.repeat(64)}`;
  assert.equal(matchesTasteDecisionSnapshot(changed, snapshot), false);
});

test('snapshot CAS refuses a changed proposal, wrong owner, and duplicate confirmation', async () => {
  const store = new InMemoryTasteProposalStore();
  const proposal = await anchoredProposal(store);
  const snapshot = tasteDecisionSnapshot(proposal);
  assert.ok(snapshot);
  assert.equal(store.claimForApproval(proposal.id, 'other', snapshot), null);
  const internal = Reflect.get(store, 'proposals') as Map<string, typeof proposal>;
  const mutableProposal = internal.get(proposal.id);
  assert.ok(mutableProposal);
  mutableProposal.quote = '改过的原话';
  assert.equal(store.claimForApproval(proposal.id, 'owner', snapshot), null);
  mutableProposal.quote = proposal.quote;
  assert.equal(store.claimForApproval(proposal.id, 'owner', snapshot)?.status, 'approving');
  assert.equal(store.claimForApproval(proposal.id, 'owner', snapshot), null);
});

test('snapshot rejection cannot settle a changed or already claimed proposal', async () => {
  const store = new InMemoryTasteProposalStore();
  const proposal = await anchoredProposal(store);
  const snapshot = tasteDecisionSnapshot(proposal);
  assert.ok(snapshot);
  const wrong = { ...snapshot, fields: { ...snapshot.fields, privacy: 'public' } };
  assert.equal(store.markRejected(proposal.id, '不合适', 'owner', wrong), null);
  assert.equal(store.markRejected(proposal.id, '不合适', 'owner', snapshot)?.status, 'rejected');
  assert.equal(store.markRejected(proposal.id, '重复', 'owner', snapshot), null);
});

test('snapshot approval writes once and cannot turn recovery into a fresh confirmation', async () => {
  const store = new InMemoryTasteProposalStore();
  const proposal = await anchoredProposal(store);
  const snapshot = tasteDecisionSnapshot(proposal);
  assert.ok(snapshot);
  let writes = 0;
  const deps = {
    store,
    lock: new SessionMutex(),
    lockKey: () => 'taste-test',
    expectedSnapshot: snapshot,
    writeVignette: async () => {
      writes++;
      return { slug: 'vignette', path: 'docs/taste/vignettes/vignette.md' };
    },
  };
  assert.equal((await approveTasteProposal(proposal.id, 'owner', deps)).ok, true);
  const repeated = await approveTasteProposal(proposal.id, 'owner', deps);
  assert.equal(repeated.ok, false);
  assert.equal(writes, 1);
});

test('a private Host confirmation receipt binds its owner and exact Host generation', () => {
  const receipt = {
    kind: 'f221-trial-receipt',
    origin: 'host-native-dialog',
    nonce: 'a'.repeat(48),
    proposalId: '11111111-1111-4111-8111-111111111111',
    digest: 'b'.repeat(64),
    action: 'approve',
    confirmedAt: 1000,
  };
  assert.equal(validateHostCompanionReply(receipt), false, 'unbound receipts cannot become producer authority');
  assert.equal(validateHostCompanionReply({ ...receipt, ownerUserId: 'owner', hostGeneration: 3 }), true);
  assert.equal(
    validateHostCompanionReply({
      ...receipt,
      ownerUserId: 'owner',
      hostGeneration: 3,
      callId: '22222222-2222-4222-8222-222222222222',
    }),
    true,
  );
});
