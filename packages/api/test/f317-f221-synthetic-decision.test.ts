import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { SessionMutex } from '../src/domains/cats/services/agents/invocation/SessionMutex.js';
import { CompanionF221SyntheticDecision } from '../src/domains/concierge/live/CompanionF221SyntheticDecision.js';
import { CompanionF221Trial } from '../src/domains/concierge/live/CompanionF221Trial.js';
import type { CompanionOwnerClient } from '../src/domains/concierge/live/companion-owner-client.js';
import { approveTasteProposal } from '../src/domains/taste/services/approveTasteProposal.js';
import { tasteDecisionSnapshot } from '../src/domains/taste/services/taste-decision-snapshot.js';
import { InMemoryTasteProposalStore } from '../src/domains/taste/stores/InMemoryTasteProposalStore.js';

async function anchoredProposal(store: InMemoryTasteProposalStore) {
  const proposal = store.create({
    proposalId: randomUUID(),
    userId: 'owner',
    catId: 'codex',
    threadId: 'home',
    sourceMessageId: 'source-1',
    scene: '讨论留白',
    quote: '不要塞满',
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

async function syntheticCandidate(writeVignette?: (proposalId: string) => Promise<{ slug: string; path: string }>) {
  const store = new InMemoryTasteProposalStore();
  const proposal = await anchoredProposal(store);
  let clock = 1000;
  let context = { generation: 7, callId: '22222222-2222-4222-8222-222222222222' };
  let authorized = true;
  let reads = 0;
  let writes = 0;
  const client = {
    request: async () => {
      reads++;
      const fresh = await store.get(proposal.id);
      const snapshot = fresh && tasteDecisionSnapshot(fresh);
      if (!snapshot) throw new Error('candidate unavailable');
      return snapshot;
    },
  } as unknown as CompanionOwnerClient;
  const current = () => context;
  const now = () => clock;
  const trial = new CompanionF221Trial(client, 'owner', current, now);
  const lock = new SessionMutex();
  const approvalCoordinator = { lock, lockKey: () => 'canonical:taste-publication' };
  const candidate = new CompanionF221SyntheticDecision(
    trial,
    'owner',
    current,
    () => authorized,
    store,
    approvalCoordinator,
    async (currentProposal) => {
      writes++;
      return writeVignette?.(currentProposal.id) ?? { slug: 'synthetic', path: 'docs/taste/vignettes/synthetic.md' };
    },
    now,
  );
  return {
    store,
    proposal,
    candidate,
    lock,
    approvalCoordinator,
    counts: () => ({ reads, writes }),
    advance: (ms: number) => {
      clock += ms;
    },
    revoke: () => {
      authorized = false;
    },
    nextCall: () => {
      context = { generation: 8, callId: '33333333-3333-4333-8333-333333333333' };
    },
  };
}

test('isolated F221 Host confirmation applies one exact producer approval and reads back its effect', async () => {
  const f = await syntheticCandidate();
  const preview = await f.candidate.inspect(f.proposal.id);
  assert.equal(preview.snapshot.fields.publication.includes('anchored'), true);
  const applied = await f.candidate.decide(preview.snapshot.nonce, 'approve');
  assert.deepEqual(applied, {
    state: 'applied',
    producerStatus: 'approved',
    effectPath: 'docs/taste/vignettes/synthetic.md',
  });
  assert.equal((await f.store.get(f.proposal.id))?.status, 'approved');
  assert.deepEqual(await f.candidate.decide(preview.snapshot.nonce, 'approve'), { state: 'stale' });
  assert.deepEqual(f.counts(), { reads: 2, writes: 1 });
});

test('synthetic and ordinary approvals serialize one vignette writer on the canonical coordinator', async () => {
  let entered!: () => void;
  let releaseWriter!: () => void;
  const writerEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const writerRelease = new Promise<void>((resolve) => {
    releaseWriter = resolve;
  });
  const f = await syntheticCandidate(async () => {
    entered();
    await writerRelease;
    return { slug: 'shared', path: 'docs/taste/vignettes/shared.md' };
  });
  const preview = await f.candidate.inspect(f.proposal.id);
  const synthetic = f.candidate.decide(preview.snapshot.nonce, 'approve');
  await writerEntered;
  let ordinaryWrites = 0;
  const ordinary = approveTasteProposal(f.proposal.id, 'owner', {
    store: f.store,
    lock: f.approvalCoordinator.lock,
    lockKey: f.approvalCoordinator.lockKey,
    writeVignette: async () => {
      ordinaryWrites++;
      return { slug: 'duplicate', path: 'docs/taste/vignettes/duplicate.md' };
    },
  });
  let beforeRelease = -1;
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    beforeRelease = ordinaryWrites;
  } finally {
    releaseWriter();
  }
  const [syntheticOutcome, ordinaryOutcome] = await Promise.all([synthetic, ordinary]);
  assert.equal(beforeRelease, 0, 'ordinary approval must wait for the first writer');
  assert.equal(f.counts().writes + ordinaryWrites, 1);
  assert.equal(syntheticOutcome.state, 'applied');
  assert.equal(ordinaryOutcome.ok, true);
  assert.equal((await f.store.get(f.proposal.id))?.status, 'approved');
});

test('isolated F221 candidate refuses changed material, retired calls, revoked authority, and expiry', async () => {
  const changed = await syntheticCandidate();
  const first = await changed.candidate.inspect(changed.proposal.id);
  const internal = Reflect.get(changed.store, 'proposals') as Map<string, typeof changed.proposal>;
  const mutable = internal.get(changed.proposal.id);
  assert.ok(mutable);
  mutable.quote = '后来改过的原话';
  assert.deepEqual(await changed.candidate.decide(first.snapshot.nonce, 'approve'), { state: 'stale' });
  assert.equal((await changed.store.get(changed.proposal.id))?.status, 'pending');
  assert.equal(changed.counts().writes, 0);

  const retired = await syntheticCandidate();
  const second = await retired.candidate.inspect(retired.proposal.id);
  retired.nextCall();
  assert.deepEqual(await retired.candidate.decide(second.snapshot.nonce, 'approve'), { state: 'stale' });
  assert.equal(retired.counts().writes, 0);

  const revoked = await syntheticCandidate();
  const revokedPreview = await revoked.candidate.inspect(revoked.proposal.id);
  revoked.revoke();
  assert.deepEqual(await revoked.candidate.decide(revokedPreview.snapshot.nonce, 'approve'), { state: 'stale' });
  assert.equal(revoked.counts().writes, 0);

  const expired = await syntheticCandidate();
  const third = await expired.candidate.inspect(expired.proposal.id);
  expired.advance(120_001);
  assert.deepEqual(await expired.candidate.decide(third.snapshot.nonce, 'approve'), { state: 'stale' });
  assert.equal(expired.counts().writes, 0);
});

test('isolated F221 rejection reads back producer state; an uncertain write stays unknown', async () => {
  const rejected = await syntheticCandidate();
  const preview = await rejected.candidate.inspect(rejected.proposal.id);
  assert.deepEqual(await rejected.candidate.decide(preview.snapshot.nonce, 'reject'), {
    state: 'applied',
    producerStatus: 'rejected',
  });
  assert.equal(rejected.counts().writes, 0);

  const uncertain = await syntheticCandidate(async () => {
    const error = new Error('writer outcome unknown');
    Object.assign(error, { publicationOutcome: 'indeterminate' });
    throw error;
  });
  const candidate = await uncertain.candidate.inspect(uncertain.proposal.id);
  assert.deepEqual(await uncertain.candidate.decide(candidate.snapshot.nonce, 'approve'), {
    state: 'unknown',
    producerStatus: 'approving',
  });
  assert.equal(uncertain.counts().writes, 1);
});

test('revocation while waiting for the producer lock cannot start a decision', async () => {
  const f = await syntheticCandidate();
  const preview = await f.candidate.inspect(f.proposal.id);
  const release = await f.lock.acquire(f.approvalCoordinator.lockKey());
  const deciding = f.candidate.decide(preview.snapshot.nonce, 'approve');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(f.counts().reads, 2, 'Host receipt was confirmed before the lock was released');
  f.revoke();
  release();
  assert.deepEqual(await deciding, { state: 'stale' });
  assert.equal((await f.store.get(f.proposal.id))?.status, 'pending');
  assert.equal(f.counts().writes, 0);
});

test('revocation after the producer CAS rolls back before any effect starts', async () => {
  const f = await syntheticCandidate();
  const preview = await f.candidate.inspect(f.proposal.id);
  const claim = f.store.claimForApproval.bind(f.store);
  f.store.claimForApproval = (id, by, expected) => {
    const claimed = claim(id, by, expected);
    f.revoke();
    return claimed;
  };
  assert.deepEqual(await f.candidate.decide(preview.snapshot.nonce, 'approve'), { state: 'stale' });
  assert.equal((await f.store.get(f.proposal.id))?.status, 'pending');
  assert.equal(f.counts().writes, 0);
});

test('rejection rechecks its Host fence after waiting for the producer lock', async () => {
  for (const invalidate of ['revoke', 'nextCall', 'expire'] as const) {
    const f = await syntheticCandidate();
    const preview = await f.candidate.inspect(f.proposal.id);
    const release = await f.lock.acquire(f.approvalCoordinator.lockKey());
    const deciding = f.candidate.decide(preview.snapshot.nonce, 'reject');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(f.counts().reads, 2);
    if (invalidate === 'expire') f.advance(120_001);
    else f[invalidate]();
    release();
    assert.deepEqual(await deciding, { state: 'stale' }, invalidate);
    assert.equal((await f.store.get(f.proposal.id))?.status, 'pending', invalidate);
  }
});

test('lost approval claim reply reads the producer as unknown instead of throwing', async () => {
  const f = await syntheticCandidate();
  const preview = await f.candidate.inspect(f.proposal.id);
  const claim = f.store.claimForApproval.bind(f.store);
  f.store.claimForApproval = (id, by, expected) => {
    claim(id, by, expected);
    throw new Error('claim reply lost');
  };
  assert.deepEqual(await f.candidate.decide(preview.snapshot.nonce, 'approve'), {
    state: 'unknown',
    producerStatus: 'approving',
  });
  assert.equal(f.counts().writes, 0);
});

test('lost final approval and rejection replies read the settled producer state', async () => {
  const approved = await syntheticCandidate();
  const approvePreview = await approved.candidate.inspect(approved.proposal.id);
  const finalize = approved.store.finalizeApproval.bind(approved.store);
  approved.store.finalizeApproval = (id, by, slug, path) => {
    finalize(id, by, slug, path);
    throw new Error('finalize reply lost');
  };
  assert.deepEqual(await approved.candidate.decide(approvePreview.snapshot.nonce, 'approve'), {
    state: 'applied',
    producerStatus: 'approved',
    effectPath: 'docs/taste/vignettes/synthetic.md',
  });

  const rejected = await syntheticCandidate();
  const rejectPreview = await rejected.candidate.inspect(rejected.proposal.id);
  const mark = rejected.store.markRejected.bind(rejected.store);
  rejected.store.markRejected = (id, reason, by, expected) => {
    mark(id, reason, by, expected);
    throw new Error('reject reply lost');
  };
  assert.deepEqual(await rejected.candidate.decide(rejectPreview.snapshot.nonce, 'reject'), {
    state: 'applied',
    producerStatus: 'rejected',
  });
});
