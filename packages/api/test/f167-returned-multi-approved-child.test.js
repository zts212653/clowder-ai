import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  advanceAcrossChildSegments,
  carrierRefreshEvidenceRef,
  delegateEvidence,
  fixture,
  NEW_CAT,
  NEW_CHILD,
  NEW_PROPOSAL,
  OLD_CAT,
  OLD_CHILD,
  OWNER_CAT,
  retargetCurrentGeneration,
} from './helpers/f167-multi-approved-child-fixture.js';

test('returned Task owner reattaches to another independently approved child', async () => {
  const f = fixture();
  const result = await f.service.admit(f.request);

  assert.equal(result.admit, true);
  assert.equal(result.outcome, 'reattached');
  assert.equal(result.lease.generation, 3);
  assert.deepEqual(result.lease.holderCatIds, [NEW_CAT]);
  assert.equal(result.lease.holderThreadId, NEW_CHILD);
  assert.ok(result.lease.evidenceRefs.includes(delegateEvidence(NEW_PROPOSAL, NEW_CHILD, NEW_CAT)));
});

for (const target of [
  { catId: NEW_CAT, threadId: NEW_CHILD },
  { catId: 'kimi', threadId: OLD_CHILD },
]) {
  test(`a delegate refreshed before its first return can reattach in ${target.threadId}`, async () => {
    const f = fixture({
      targetCatId: target.catId,
      targetThreadId: target.threadId,
      refreshBeforeReturn: true,
    });
    assert.equal(f.current().generation, 3);
    assert.ok(f.current().evidenceRefs.includes(carrierRefreshEvidenceRef(f.current().leaseId, 2)));

    const result = await f.service.admit(f.request);
    assert.equal(result.outcome, 'reattached');
    assert.equal(result.lease.generation, 4);
  });
}

test('terminal replacement after an initial carrier refresh remains valid history', async () => {
  const f = fixture({ replaceAfterRefresh: true });
  assert.equal(f.current().generation, 4);
  assert.equal(f.current().replacementTransitions[0]?.fromGeneration, 2);

  const result = await f.service.admit(f.request);
  assert.equal(result.outcome, 'reattached');
  assert.equal(result.lease.generation, 5);
});

test('consecutive server carrier refresh generations remain recursively traceable', async () => {
  const f = fixture({ refreshCount: 2 });
  assert.equal(f.current().generation, 4);
  assert.ok(f.current().evidenceRefs.includes(carrierRefreshEvidenceRef(f.current().leaseId, 2)));
  assert.ok(f.current().evidenceRefs.includes(carrierRefreshEvidenceRef(f.current().leaseId, 3)));

  const result = await f.service.admit(f.request);
  assert.equal(result.outcome, 'reattached');
  assert.equal(result.lease.generation, 5);
});

test('a refresh marker cannot override a conflicting replacement endpoint', async () => {
  const f = fixture({ replaceAfterRefresh: true });
  f.current().replacementTransitions[0].toHolderCatIds = ['kimi'];
  f.current().evidenceRefs.push(carrierRefreshEvidenceRef(f.current().leaseId, 3));

  await assert.rejects(f.service.admit(f.request), /standing|approved|lineage/i);
});

test('returned Task owner cannot assemble a cat and child across approved proposals', async () => {
  const f = fixture({ targetCatId: OLD_CAT });

  await assert.rejects(f.service.admit(f.request), /standing|approved|child/i);
  assert.equal(f.current().generation, 2);
  assert.deepEqual(f.current().holderCatIds, [OWNER_CAT]);
});

test('moving children still requires current standing for the child that returned', async () => {
  const f = fixture({ oldProposalStatus: 'withdrawn' });

  await assert.rejects(f.service.admit(f.request), /standing|approved|child/i);
  assert.equal(f.current().generation, 2);
  assert.deepEqual(f.current().holderCatIds, [OWNER_CAT]);
});

test('proposal evidence alone cannot invent a returned-child lineage anchor', async () => {
  const f = fixture({ returningCatId: 'kimi' });

  await assert.rejects(f.service.admit(f.request), /standing|approved|child|lineage/i);
  assert.equal(f.current().generation, 2);
  assert.deepEqual(f.current().holderCatIds, [OWNER_CAT]);
});

test('the newly approved child supports a later same-child successor without freezing preferredCats', async () => {
  const f = fixture();
  const first = await f.service.admit(f.request);
  assert.equal(first.outcome, 'reattached');

  const returned = f.returnCurrent();
  f.request.holderCatIds = ['kimi'];
  f.request.dispatchId = 'cross-post:new-child-successor';
  f.request.evidenceRef = 'message:new-child-successor';
  f.request.incomingActionLeaseRef = { leaseId: returned.leaseId, generation: returned.generation };
  f.request.action.replace = { leaseId: returned.leaseId, expectedGeneration: returned.generation };
  f.request.now = 500;

  const second = await f.service.admit(f.request);
  assert.equal(second.outcome, 'reattached');
  assert.equal(second.lease.generation, 5);
  assert.deepEqual(second.lease.holderCatIds, ['kimi']);
  assert.equal(second.lease.holderThreadId, NEW_CHILD);
  assert.ok(second.lease.evidenceRefs.includes(delegateEvidence(NEW_PROPOSAL, NEW_CHILD, NEW_CAT)));
});

for (const outcome of ['failed', 'canceled', 'unavailable', 'interrupted']) {
  test(`new child retains ${outcome} recovery after the previous child had a replacement`, async () => {
    const f = fixture({ targetCatId: 'kimi', targetThreadId: OLD_CHILD });
    await advanceAcrossChildSegments(f);

    if (outcome !== 'interrupted') f.terminal(outcome);
    retargetCurrentGeneration(f, 'codex6-luna', NEW_CHILD);
    if (outcome === 'interrupted') {
      f.request.interruptedGenerationEvidence = {
        leaseId: f.current().leaseId,
        generation: f.current().generation,
        evidenceRef:
          `carrier-interrupted-after-read:${f.current().leaseId}` + `:g${f.current().generation}:kimi@${NEW_CHILD}`,
      };
    }

    if (outcome === 'interrupted') {
      await assert.rejects(f.service.admit(f.request), /standing/);
      assert.equal(
        f.current().generation,
        8,
        'legacy interruption evidence cannot replace an active canonical execution',
      );
    } else {
      const result = await f.service.admit(f.request);
      assert.equal(result.outcome, 'replaced');
      assert.equal(result.lease.generation, 9);
    }
  });
}

test('an invalid historical child segment cannot be ignored by a valid current child', async () => {
  const f = fixture({ targetCatId: 'kimi', targetThreadId: OLD_CHILD });
  await advanceAcrossChildSegments(f);
  f.terminal();
  f.current().replacementTransitions[0].issuerThreadId = 'thread-forged-owner';
  retargetCurrentGeneration(f, 'codex6-luna', NEW_CHILD);

  await assert.rejects(f.service.admit(f.request), /standing|lineage|owner/i);
  assert.equal(f.current().generation, 8);
});

test('a missing historical entry edge cannot be hidden by an exact current entry', async () => {
  const f = fixture({ targetCatId: 'kimi', targetThreadId: OLD_CHILD });
  await advanceAcrossChildSegments(f);
  f.current().replacementTransitions = [];
  f.terminal();
  retargetCurrentGeneration(f, 'codex6-luna', NEW_CHILD);

  await assert.rejects(f.service.admit(f.request), /standing|lineage|owner/i);
  assert.equal(f.current().generation, 8);
});

test('generation drift without an entry edge cannot grant same-child successor standing', async () => {
  const f = fixture();
  assert.equal((await f.service.admit(f.request)).outcome, 'reattached');
  f.current().generation += 1;
  f.terminal();
  retargetCurrentGeneration(f, 'codex6-luna', NEW_CHILD);

  await assert.rejects(f.service.admit(f.request), /standing|approved|lineage/i);
});

test('a caller-shaped refresh marker after return cannot disguise generation drift', async () => {
  const f = fixture();
  assert.equal((await f.service.admit(f.request)).outcome, 'reattached');
  f.current().generation += 1;
  f.current().evidenceRefs.push(carrierRefreshEvidenceRef(f.current().leaseId, f.current().generation));
  f.terminal();
  retargetCurrentGeneration(f, 'codex6-luna', NEW_CHILD);

  await assert.rejects(f.service.admit(f.request), /standing|approved|lineage/i);
});

test('a missing terminal replacement edge cannot grant same-child successor standing', async () => {
  const f = fixture();
  assert.equal((await f.service.admit(f.request)).outcome, 'reattached');
  f.returnCurrent();
  retargetCurrentGeneration(f, 'kimi', NEW_CHILD);
  assert.equal((await f.service.admit(f.request)).outcome, 'reattached');
  f.terminal();
  retargetCurrentGeneration(f, 'codex6-luna', NEW_CHILD);
  assert.equal((await f.service.admit(f.request)).outcome, 'replaced');
  assert.equal(f.current().replacementTransitions.length, 1);
  f.current().replacementTransitions = [];
  f.terminal();
  retargetCurrentGeneration(f, 'gpt52', NEW_CHILD);

  await assert.rejects(f.service.admit(f.request), /standing|approved|lineage/i);
});
