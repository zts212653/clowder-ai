import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

// F231 Phase C Task3: approveProfileUpdate service — per-target lock (SessionMutex) +
// P1-1 crash-recovery commit pipeline (checkpoint skip) + P1-2 optimistic lock state machine.
// Covers INV-3 (CAS claim) / INV-8 (hash optimistic lock) / INV-9 (lock always released) +
// ADV-1a/1b (crash recovery) / ADV-2 (concurrent same proposal) / ADV-3 (write fail rollback) /
// ADV-5 (approve after reject) / ADV-6a (sequential same primer) / ADV-6b (concurrent same primer).
describe('approveProfileUpdate service (lock + crash recovery + state machine)', () => {
  let profileDir;
  let mod;
  let writeMod;
  let StoreMod;
  let MutexMod;

  beforeEach(async () => {
    profileDir = mkdtempSync(join(tmpdir(), 'f231-approve-'));
    mkdirSync(join(profileDir, 'relationship'), { recursive: true });
    mod = await import('../dist/domains/cats/services/profile/approveProfileUpdate.js');
    writeMod = await import('../dist/domains/cats/services/profile/writeProfileUpdate.js');
    StoreMod = await import('../dist/domains/cats/services/stores/ports/ProfileUpdateProposalStore.js');
    MutexMod = await import('../dist/domains/cats/services/agents/invocation/SessionMutex.js');
  });

  afterEach(() => rmSync(profileDir, { recursive: true, force: true }));

  const seedPrimer = (content, catId = 'codex') => {
    writeFileSync(join(profileDir, 'relationship', `${catId}-primer.md`), content, 'utf8');
    return writeMod.hashContent(content);
  };

  const makeProposal = (store, over = {}) =>
    store.create({
      sourceThreadId: 'thread_1',
      sourceInvocationId: 'inv_1',
      sourceCatId: 'codex',
      targetLayer: 'primer',
      targetPath: join('relationship', 'codex-primer.md'),
      beforeContent: 'OLD',
      baseContentHash: writeMod.hashContent('OLD'),
      afterContent: 'NEW',
      rationale: 'landy likes blue',
      signalProvenance: { kind: 'cat-declared', sourceThreadId: 'thread_1' },
      createdBy: 'alice',
      ...over,
    });

  const deps = (store, lock, over = {}) => ({ store, lock, profileDir, ...over });
  const primerPath = () => join(profileDir, 'relationship', 'codex-primer.md');

  it('happy path: pending → approved, writes primer (afterContent) + provenance', async () => {
    seedPrimer('OLD');
    const store = new StoreMod.InMemoryProfileUpdateProposalStore();
    const lock = new MutexMod.SessionMutex();
    const p = makeProposal(store);
    const r = await mod.approveProfileUpdate(p.proposalId, 'alice', deps(store, lock));
    assert.equal(r.ok, true);
    assert.equal(r.proposal.status, 'approved');
    assert.equal(readFileSync(primerPath(), 'utf8'), 'NEW');
    assert.ok(existsSync(r.proposal.provenancePath));
    assert.ok(r.proposal.writtenPath);
  });

  it('ADV-6a: sequential approve of two proposals on same primer — 2nd hits stale_hash, no overwrite', async () => {
    seedPrimer('OLD');
    const store = new StoreMod.InMemoryProfileUpdateProposalStore();
    const lock = new MutexMod.SessionMutex();
    const x = makeProposal(store, { afterContent: 'X-WINS' });
    const y = makeProposal(store, { afterContent: 'Y-LOSES' });
    const rx = await mod.approveProfileUpdate(x.proposalId, 'alice', deps(store, lock));
    const ry = await mod.approveProfileUpdate(y.proposalId, 'alice', deps(store, lock));
    assert.equal(rx.ok, true);
    assert.equal(ry.ok, false);
    assert.equal(ry.reason, 'stale_hash');
    assert.equal(readFileSync(primerPath(), 'utf8'), 'X-WINS');
    assert.equal((await store.get(y.proposalId)).status, 'pending'); // rolled back, not overwritten
  });

  it('P2: independent proposals with identical afterContent still honor optimistic locking', async () => {
    seedPrimer('OLD');
    const store = new StoreMod.InMemoryProfileUpdateProposalStore();
    const lock = new MutexMod.SessionMutex();
    const x = makeProposal(store, { afterContent: 'SAME' });
    const y = makeProposal(store, { afterContent: 'SAME' });

    const rx = await mod.approveProfileUpdate(x.proposalId, 'alice', deps(store, lock));
    const ry = await mod.approveProfileUpdate(y.proposalId, 'alice', deps(store, lock));

    assert.equal(rx.ok, true);
    assert.equal(ry.ok, false);
    assert.equal(ry.reason, 'stale_hash');
    assert.equal(readFileSync(primerPath(), 'utf8'), 'SAME');
    assert.equal((await store.get(y.proposalId)).status, 'pending');
  });

  it('ADV-6b: CONCURRENT approve of two proposals on same primer — lock serializes, exactly one wins', async () => {
    seedPrimer('OLD');
    const store = new StoreMod.InMemoryProfileUpdateProposalStore();
    const lock = new MutexMod.SessionMutex();
    const x = makeProposal(store, { afterContent: 'X' });
    const y = makeProposal(store, { afterContent: 'Y' });
    const [rx, ry] = await Promise.all([
      mod.approveProfileUpdate(x.proposalId, 'alice', deps(store, lock)),
      mod.approveProfileUpdate(y.proposalId, 'alice', deps(store, lock)),
    ]);
    const oks = [rx, ry].filter((r) => r.ok);
    const stales = [rx, ry].filter((r) => !r.ok && r.reason === 'stale_hash');
    assert.equal(oks.length, 1, 'exactly one approve succeeds');
    assert.equal(stales.length, 1, 'the other hits optimistic-lock stale_hash');
    const finalContent = readFileSync(primerPath(), 'utf8');
    assert.ok(finalContent === 'X' || finalContent === 'Y', 'content is a winner afterContent, not corrupted');
  });

  it('ADV-2: concurrent approve of the SAME proposal — idempotent, single write', async () => {
    seedPrimer('OLD');
    const store = new StoreMod.InMemoryProfileUpdateProposalStore();
    const lock = new MutexMod.SessionMutex();
    const p = makeProposal(store);
    const [r1, r2] = await Promise.all([
      mod.approveProfileUpdate(p.proposalId, 'alice', deps(store, lock)),
      mod.approveProfileUpdate(p.proposalId, 'alice', deps(store, lock)),
    ]);
    assert.ok(r1.ok && r2.ok, 'both report ok (one fresh, one idempotent)');
    assert.equal((await store.get(p.proposalId)).status, 'approved');
    assert.equal(readFileSync(primerPath(), 'utf8'), 'NEW');
  });

  it('ADV-3: primer write failure rolls back to pending (no half-commit, no provenance)', async () => {
    seedPrimer('OLD');
    const store = new StoreMod.InMemoryProfileUpdateProposalStore();
    const lock = new MutexMod.SessionMutex();
    const p = makeProposal(store);
    const failWriter = () => {
      throw new Error('disk full');
    };
    const r = await mod.approveProfileUpdate(p.proposalId, 'alice', deps(store, lock, { writePrimer: failWriter }));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'write_failed');
    assert.equal((await store.get(p.proposalId)).status, 'pending'); // rolled back
    assert.equal(readFileSync(primerPath(), 'utf8'), 'OLD'); // untouched
  });

  it('P2: checkpoint failure after primer write returns committed path for cache invalidation', async () => {
    seedPrimer('OLD');
    class CheckpointFailingStore extends StoreMod.InMemoryProfileUpdateProposalStore {
      async recordCheckpoint(proposalId, checkpoint) {
        if (checkpoint.writtenPath) throw new Error('redis down after primer write');
        return super.recordCheckpoint(proposalId, checkpoint);
      }
    }
    const store = new CheckpointFailingStore();
    const lock = new MutexMod.SessionMutex();
    const p = makeProposal(store);

    const r = await mod.approveProfileUpdate(p.proposalId, 'alice', deps(store, lock));

    assert.equal(r.ok, false);
    assert.equal(r.reason, 'write_failed');
    assert.match(r.error, /redis down after primer write/);
    assert.equal(r.proposal.writtenPath, primerPath());
    assert.equal(readFileSync(primerPath(), 'utf8'), 'NEW');
    const stored = await store.get(p.proposalId);
    assert.equal(stored.status, 'approving');
    assert.equal(stored.writtenPath, undefined);
  });

  it('P2: finalize failure after checkpoints returns committed paths for cache invalidation', async () => {
    seedPrimer('OLD');
    class FinalizeFailingStore extends StoreMod.InMemoryProfileUpdateProposalStore {
      async finalizeApproval() {
        throw new Error('redis down during finalize');
      }
    }
    const store = new FinalizeFailingStore();
    const lock = new MutexMod.SessionMutex();
    const p = makeProposal(store);

    const r = await mod.approveProfileUpdate(p.proposalId, 'alice', deps(store, lock));

    assert.equal(r.ok, false);
    assert.equal(r.reason, 'write_failed');
    assert.match(r.error, /redis down during finalize/);
    assert.equal(r.proposal.writtenPath, primerPath());
    assert.ok(r.proposal.provenancePath);
    assert.equal(readFileSync(primerPath(), 'utf8'), 'NEW');
    assert.ok(existsSync(r.proposal.provenancePath));
    const stored = await store.get(p.proposalId);
    assert.equal(stored.status, 'approving');
    assert.equal(stored.writtenPath, primerPath());
    assert.ok(stored.provenancePath);
  });

  it('INV-9: lock is released on a failure path (next acquire does not block)', async () => {
    seedPrimer('OLD');
    const store = new StoreMod.InMemoryProfileUpdateProposalStore();
    const lock = new MutexMod.SessionMutex();
    const p = makeProposal(store);
    const failWriter = () => {
      throw new Error('boom');
    };
    await mod.approveProfileUpdate(p.proposalId, 'alice', deps(store, lock, { writePrimer: failWriter }));
    // If the lock leaked, this acquire hangs forever — race against a timeout.
    const acquired = await Promise.race([
      lock.acquire(p.targetPath).then((rel) => {
        rel();
        return true;
      }),
      new Promise((res) => setTimeout(() => res(false), 500)),
    ]);
    assert.equal(acquired, true, 'lock must be released after a failed approve (INV-9)');
  });

  it('ADV-1a: crash recovery — primer written, provenance not → resume provenance + finalize, no primer re-write', async () => {
    seedPrimer('OLD');
    const store = new StoreMod.InMemoryProfileUpdateProposalStore();
    const lock = new MutexMod.SessionMutex();
    const p = makeProposal(store);
    // Simulate crash AFTER primer write + checkpoint, BEFORE provenance.
    store.claimForApproval(p.proposalId, 'alice');
    const { writtenPath } = writeMod.writeProfilePrimer(p, profileDir); // primer now = NEW
    store.recordCheckpoint(p.proposalId, { writtenPath });
    // Recovery: primer must NOT be re-written (hash would mismatch) — inject a throwing primer writer.
    const noRewrite = () => {
      throw new Error('primer must not be rewritten during recovery');
    };
    const r = await mod.approveProfileUpdate(p.proposalId, 'alice', deps(store, lock, { writePrimer: noRewrite }));
    assert.equal(r.ok, true);
    assert.equal(r.proposal.status, 'approved');
    assert.ok(existsSync(r.proposal.provenancePath));
    assert.equal(readFileSync(writtenPath, 'utf8'), 'NEW');
  });

  it('ADV-1a2: crash recovery — primer written before checkpoint → detect exact content, checkpoint, finalize', async () => {
    seedPrimer('OLD');
    const store = new StoreMod.InMemoryProfileUpdateProposalStore();
    const lock = new MutexMod.SessionMutex();
    const p = makeProposal(store);
    // Simulate crash AFTER primer write, BEFORE writtenPath checkpoint.
    store.claimForApproval(p.proposalId, 'alice');
    writeFileSync(primerPath(), 'NEW', 'utf8');

    const r = await mod.approveProfileUpdate(p.proposalId, 'alice', deps(store, lock));

    assert.equal(r.ok, true);
    assert.equal(r.proposal.status, 'approved');
    assert.equal(r.proposal.writtenPath, primerPath());
    assert.ok(existsSync(r.proposal.provenancePath));
    assert.equal(readFileSync(primerPath(), 'utf8'), 'NEW');
  });

  it('ADV-1b: crash recovery — both written → finalize only (no re-write of either file)', async () => {
    seedPrimer('OLD');
    const store = new StoreMod.InMemoryProfileUpdateProposalStore();
    const lock = new MutexMod.SessionMutex();
    const p = makeProposal(store);
    store.claimForApproval(p.proposalId, 'alice');
    const { writtenPath } = writeMod.writeProfilePrimer(p, profileDir);
    store.recordCheckpoint(p.proposalId, { writtenPath });
    const { provenancePath } = writeMod.writeProfileProvenance(p, profileDir);
    store.recordCheckpoint(p.proposalId, { provenancePath });
    const failBoth = () => {
      throw new Error('no writes during finalize-only recovery');
    };
    const r = await mod.approveProfileUpdate(
      p.proposalId,
      'alice',
      deps(store, lock, { writePrimer: failBoth, writeProvenance: failBoth }),
    );
    assert.equal(r.ok, true);
    assert.equal(r.proposal.status, 'approved');
  });

  it('ADV-5: approve after reject → rejected, no write', async () => {
    seedPrimer('OLD');
    const store = new StoreMod.InMemoryProfileUpdateProposalStore();
    const lock = new MutexMod.SessionMutex();
    const p = makeProposal(store);
    store.markRejected(p.proposalId, 'alice', 'no thanks');
    const r = await mod.approveProfileUpdate(p.proposalId, 'alice', deps(store, lock));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'rejected');
    assert.equal(readFileSync(primerPath(), 'utf8'), 'OLD');
  });

  it('not_found for unknown proposalId', async () => {
    const store = new StoreMod.InMemoryProfileUpdateProposalStore();
    const lock = new MutexMod.SessionMutex();
    const r = await mod.approveProfileUpdate('nope', 'alice', deps(store, lock));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not_found');
  });
});
