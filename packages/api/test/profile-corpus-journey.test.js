/**
 * F231 Phase E T13: S1 corpus journey — propose → approve r1 → another persona reads r1
 * → correction approve r2 → r1 fail closed → reject branch no write.
 *
 * Uses InMemoryProfileUpdateProposalStore (no Redis needed for the core path).
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

describe('F231 Phase E: corpus lifecycle journey (InMemory)', () => {
  let dataDir;
  let repository;
  let StoreMod;
  let MutexMod;
  let approveMod;
  let writeMod;
  let profileContract;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'f231-corpus-journey-'));
    approveMod = await import('../dist/domains/cats/services/profile/approveProfileUpdate.js');
    writeMod = await import('../dist/domains/cats/services/profile/writeProfileUpdate.js');
    StoreMod = await import('../dist/domains/cats/services/stores/ports/ProfileUpdateProposalStore.js');
    MutexMod = await import('../dist/domains/cats/services/agents/invocation/SessionMutex.js');
    const RepoMod = await import('../dist/domains/cats/services/profile/ProfileRepository.js');
    profileContract = await import('@cat-cafe/shared/profile-contract');
    repository = new RepoMod.FileProfileRepository({
      dataDir,
      relationshipKeyForCat: (catId) => ({ opus: 'ragdoll', codex: 'maine-coon' })[catId],
    });
    // Create profile dirs for test user
    const profileDir = repository.profileDir('operator');
    mkdirSync(join(profileDir, 'relationship'), { recursive: true });
    mkdirSync(join(profileDir, 'corpus'), { recursive: true });
  });

  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  const corpusPath = () => profileContract.PROFILE_CORPUS_RELATIVE_PATH;

  const makeCorpusProposal = (store, content, over = {}) =>
    store.create({
      sourceThreadId: 'thread_corpus',
      sourceInvocationId: 'inv_corpus',
      sourceCatId: 'opus',
      targetLayer: 'corpus',
      targetPath: corpusPath(),
      beforeContent: '',
      baseContentHash: writeMod.hashContent(''),
      afterContent: content,
      rationale: 'owner-wide fact',
      signalProvenance: { kind: 'cvo-instructed', sourceThreadId: 'thread_corpus' },
      createdBy: 'operator',
      ...over,
    });

  const deps = (store, lock) => ({ store, lock, repository });

  it('full corpus lifecycle: propose → approve r1 → read → update r2 → r1 stale → reject no-write', async () => {
    const store = new StoreMod.InMemoryProfileUpdateProposalStore();
    const lock = new MutexMod.SessionMutex();

    // Step 1: Propose corpus update
    const p1 = makeCorpusProposal(store, 'You birthday: January 1st');

    // Step 2: Approve → writes corpus/shared-facts.md
    const r1 = await approveMod.approveProfileUpdate(p1.proposalId, 'operator', deps(store, lock));
    assert.equal(r1.ok, true);
    assert.equal(r1.targetLayer, 'corpus');
    assert.ok(r1.revision);
    assert.ok(r1.revision.startsWith('sha256:'));

    // Verify file exists
    const profileDir = repository.profileDir('operator');
    const corpusFile = join(profileDir, 'corpus', 'shared-facts.md');
    assert.equal(readFileSync(corpusFile, 'utf8'), 'You birthday: January 1st');

    // Step 3: Another persona reads the same corpus
    const corpus = repository.readCorpus('operator');
    assert.ok(corpus);
    assert.equal(corpus.content, 'You birthday: January 1st');
    const { profileRevisionOf } = await import('@cat-cafe/shared/profile-revision');
    assert.equal(profileRevisionOf(corpus.content), r1.revision);

    // Step 4: Correction — propose updated corpus
    const p2 = makeCorpusProposal(store, 'You birthday: February 2nd. Likes cats.', {
      sourceCatId: 'codex', // different persona
      beforeContent: 'You birthday: January 1st',
      baseContentHash: writeMod.hashContent('You birthday: January 1st'),
    });

    const r2 = await approveMod.approveProfileUpdate(p2.proposalId, 'operator', deps(store, lock));
    assert.equal(r2.ok, true);
    assert.equal(r2.targetLayer, 'corpus');
    assert.notEqual(r2.revision, r1.revision, 'r2 revision must differ from r1');

    // Step 5: r1 revision is now stale — any r1-based proposal hits stale_hash
    const p3 = makeCorpusProposal(store, 'Stale attempt', {
      beforeContent: 'You birthday: January 1st',
      baseContentHash: writeMod.hashContent('You birthday: January 1st'),
    });

    const r3 = await approveMod.approveProfileUpdate(p3.proposalId, 'operator', deps(store, lock));
    assert.equal(r3.ok, false);
    assert.equal(r3.reason, 'stale_hash');
    // File unchanged
    assert.equal(readFileSync(corpusFile, 'utf8'), 'You birthday: February 2nd. Likes cats.');

    // Step 6: Reject branch — no write
    const p4 = makeCorpusProposal(store, 'Should not be written', {
      beforeContent: 'You birthday: February 2nd. Likes cats.',
      baseContentHash: writeMod.hashContent('You birthday: February 2nd. Likes cats.'),
    });
    store.markRejected(p4.proposalId, 'operator');

    // Rejected proposal cannot be approved
    const r4 = await approveMod.approveProfileUpdate(p4.proposalId, 'operator', deps(store, lock));
    assert.equal(r4.ok, false);
    // File still has the r2 content
    assert.equal(readFileSync(corpusFile, 'utf8'), 'You birthday: February 2nd. Likes cats.');
  });

  it('corpus provenance file is created alongside the corpus write', async () => {
    const store = new StoreMod.InMemoryProfileUpdateProposalStore();
    const lock = new MutexMod.SessionMutex();
    const p = makeCorpusProposal(store, 'Owner fact');

    const r = await approveMod.approveProfileUpdate(p.proposalId, 'operator', deps(store, lock));
    assert.equal(r.ok, true);
    assert.ok(r.proposal.provenancePath);
    assert.ok(existsSync(r.proposal.provenancePath));
    const provenance = readFileSync(r.proposal.provenancePath, 'utf8');
    assert.match(provenance, /layer:\s*corpus/i, 'provenance must record corpus layer');
  });
});
