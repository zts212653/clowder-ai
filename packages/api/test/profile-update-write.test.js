import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

// F231 Phase C Task2: split commit points (P1-1) + path boundary (P1-2) + hash lock.
describe('writeProfilePrimer + writeProfileProvenance (split commit points)', () => {
  let profileDir;
  let mod;

  beforeEach(async () => {
    profileDir = mkdtempSync(join(tmpdir(), 'f231-write-'));
    mkdirSync(join(profileDir, 'relationship'), { recursive: true });
    mod = await import('../dist/domains/cats/services/profile/writeProfileUpdate.js');
  });

  afterEach(() => rmSync(profileDir, { recursive: true, force: true }));

  const seedPrimer = (content, catId = 'codex') => {
    const rel = join('relationship', `${catId}-primer.md`);
    writeFileSync(join(profileDir, rel), content, 'utf8');
    return { rel, hash: mod.hashContent(content) };
  };

  const baseProposal = (over = {}) => ({
    proposalId: 'prop_1',
    sourceCatId: 'codex',
    sourceThreadId: 'thread_1',
    targetLayer: 'primer',
    targetPath: join('relationship', 'codex-primer.md'),
    afterContent: 'NEW primer content',
    beforeContent: 'OLD primer',
    baseContentHash: '',
    rationale: 'landy prefers blue',
    signalProvenance: { kind: 'cat-declared', sourceThreadId: 'thread_1', sourceMessageId: 'msg_1' },
    ...over,
  });

  it('writeProfilePrimer writes afterContent when hash matches (returns writtenPath only)', () => {
    const { rel, hash } = seedPrimer('OLD primer');
    const r = mod.writeProfilePrimer(baseProposal({ baseContentHash: hash }), profileDir);
    assert.equal(readFileSync(join(profileDir, rel), 'utf8'), 'NEW primer content');
    assert.equal(r.writtenPath, join(profileDir, rel));
    assert.deepEqual(Object.keys(r), ['writtenPath']); // step 1 does NOT write provenance
  });

  it('P1: preserves the existing primer when the atomic temp write fails', () => {
    const { rel, hash } = seedPrimer('OLD primer');
    const tempWrites = [];
    const failingFileOps = {
      writeFileSync(path, content) {
        tempWrites.push({ path, content });
        throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      },
      renameSync() {
        throw new Error('rename should not be reached after write failure');
      },
      rmSync() {},
    };

    assert.throws(
      () => mod.writeProfilePrimer(baseProposal({ baseContentHash: hash }), profileDir, { fileOps: failingFileOps }),
      /ENOSPC/,
    );
    assert.equal(readFileSync(join(profileDir, rel), 'utf8'), 'OLD primer');
    assert.equal(tempWrites.length, 1);
    assert.notEqual(tempWrites[0].path, join(profileDir, rel));
  });

  it('P1-1: split lets route checkpoint primer BEFORE provenance (primer succeeds independently)', () => {
    const { hash } = seedPrimer('OLD primer');
    const proposal = baseProposal({ baseContentHash: hash });
    // step 1: primer written — route would recordCheckpoint(writtenPath) here, recoverable.
    const { writtenPath } = mod.writeProfilePrimer(proposal, profileDir);
    assert.ok(existsSync(writtenPath));
    assert.equal(readFileSync(writtenPath, 'utf8'), 'NEW primer content');
    // step 2: provenance uses PINNED beforeContent, not current primer (crash-recovery safe).
    const { provenancePath } = mod.writeProfileProvenance(proposal, profileDir);
    const prov = readFileSync(provenancePath, 'utf8');
    assert.match(prov, /OLD primer/); // before = pinned, even though primer is now NEW
    assert.match(prov, /NEW primer content/);
    assert.match(prov, /prop_1/);
  });

  it('INV-8 / P1-2: throws StaleProfileUpdateError when primer changed (no overwrite)', () => {
    seedPrimer('OLD primer');
    const stale = baseProposal({ baseContentHash: mod.hashContent('STALE base') });
    assert.throws(() => mod.writeProfilePrimer(stale, profileDir), mod.StaleProfileUpdateError);
    assert.equal(readFileSync(join(profileDir, 'relationship/codex-primer.md'), 'utf8'), 'OLD primer');
  });

  it('P1-2: rejects path escape / wrong-shape targetPath (no write outside profileDir)', () => {
    assert.throws(
      () => mod.writeProfilePrimer(baseProposal({ targetPath: '../escaped.md' }), profileDir),
      mod.InvalidPrimerPathError,
    );
    assert.throws(
      () => mod.writeProfilePrimer(baseProposal({ targetPath: 'relationship/../../escaped.md' }), profileDir),
      mod.InvalidPrimerPathError,
    );
    assert.throws(
      () => mod.writeProfilePrimer(baseProposal({ targetPath: 'relationship/wrong.md' }), profileDir),
      mod.InvalidPrimerPathError,
    );
    assert.ok(!existsSync(join(profileDir, 'escaped.md')));
  });

  it('INV-7 / P1-1: provenance path deterministic (same proposalId → same file)', () => {
    const proposal = baseProposal({ baseContentHash: mod.hashContent('') });
    const a = mod.writeProfileProvenance(proposal, profileDir).provenancePath;
    const b = mod.writeProfileProvenance(proposal, profileDir).provenancePath;
    assert.equal(a, b);
    assert.equal(a, mod.provenancePathFor(profileDir, proposal));
  });

  it('P2: provenance records the signal audit fields', () => {
    const proposal = baseProposal({
      signalProvenance: { kind: 'cvo-instructed', sourceThreadId: 'thread_signal', sourceMessageId: 'msg_signal' },
    });
    const { provenancePath } = mod.writeProfileProvenance(proposal, profileDir);
    const prov = readFileSync(provenancePath, 'utf8');
    assert.match(prov, /signalKind: cvo-instructed/);
    assert.match(prov, /signalSourceThread: thread_signal/);
    assert.match(prov, /signalSourceMessage: msg_signal/);
  });

  it('absent primer hashes to empty content (first-ever write when baseContentHash = hash(""))', () => {
    const p = baseProposal({
      sourceCatId: 'gemini',
      targetPath: join('relationship', 'gemini-primer.md'),
      baseContentHash: mod.hashContent(''),
    });
    const { writtenPath } = mod.writeProfilePrimer(p, profileDir);
    assert.equal(readFileSync(writtenPath, 'utf8'), 'NEW primer content');
  });
});
