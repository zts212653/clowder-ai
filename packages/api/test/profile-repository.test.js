import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { CURRENT_RELATIONSHIP_PROFILE_URI, relationshipPrimerRelativePath } from '@cat-cafe/shared/profile-contract';

import { FileProfileRepository } from '../dist/domains/cats/services/profile/ProfileRepository.js';

describe('FileProfileRepository', () => {
  const roots = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture(mapping = { codex: 'maine-coon', 'codex-sol': 'maine-coon', opus: 'ragdoll' }) {
    const dataDir = mkdtempSync(join(tmpdir(), 'f231-profile-data-'));
    roots.push(dataDir);
    const repository = new FileProfileRepository({
      dataDir,
      relationshipKeyForCat: (catId) => mapping[catId],
    });
    return { dataDir, repository };
  }

  it('uses one canonical user root independent of cwd or script paths', () => {
    const { dataDir, repository } = fixture();
    assert.equal(repository.profileDir('default-user'), resolve(dataDir, 'profiles', 'default-user'));
    assert.equal(repository.profileDir('alice'), resolve(dataDir, 'profiles', 'alice'));
  });

  it('projects codex variants to the same relationship key and logical URI', () => {
    const { repository } = fixture();
    const codex = repository.scope('default-user', 'codex');
    const sol = repository.scope('default-user', 'codex-sol');

    assert.equal(codex.relationshipKey, 'maine-coon');
    assert.deepEqual(sol, { ...codex, catId: 'codex-sol' });
    assert.equal(repository.currentRelationshipUri(), CURRENT_RELATIONSHIP_PROFILE_URI);
    assert.equal(relationshipPrimerRelativePath(sol.relationshipKey), 'relationship/maine-coon-primer.md');
  });

  it('preserves a server-pinned proposal relationship key across later catalog changes', () => {
    const { repository } = fixture({ codex: 'new-persona' });
    const pinned = repository.scopeForPinnedPrimerTarget('default-user', 'codex', 'relationship/maine-coon-primer.md');
    assert.equal(pinned.relationshipKey, 'maine-coon');
    assert.match(repository.primerPath(pinned), /maine-coon-primer\.md$/);
  });

  it('rejects a pre-KD-18 proposal whose pinned key is the legacy catId', () => {
    const { repository } = fixture({ codex: 'maine-coon' });
    assert.throws(
      () => repository.scopeForPinnedPrimerTarget('default-user', 'codex', 'relationship/codex-primer.md'),
      /legacy catId-keyed primer target/i,
    );
  });

  it('rejects a pinned proposal after its cat is removed from the catalog', () => {
    const { repository } = fixture({});
    assert.throws(
      () => repository.scopeForPinnedPrimerTarget('default-user', 'codex', 'relationship/codex-primer.md'),
      /no relationship key configured.*codex/i,
    );
  });

  it('keeps users in distinct physical roots', () => {
    const { repository } = fixture();
    const alice = repository.scope('alice', 'codex');
    const bob = repository.scope('bob', 'codex');
    assert.notEqual(repository.primerPath(alice), repository.primerPath(bob));
  });

  it('encodes external user identifiers without allowing path traversal', () => {
    const { dataDir, repository } = fixture();
    assert.equal(repository.profileDir('person@example.com'), resolve(dataDir, 'profiles', 'person%40example.com'));
    const escaped = repository.profileDir('../escape');
    assert.equal(escaped, resolve(dataDir, 'profiles', '..%2Fescape'));
    assert.equal(escaped.startsWith(resolve(dataDir, 'profiles')), true);
  });

  it('reads only the primer derived from the authenticated scope', () => {
    const { repository } = fixture();
    const scope = repository.scope('default-user', 'codex-sol');
    const primerPath = repository.primerPath(scope);
    mkdirSync(resolve(primerPath, '..'), { recursive: true });
    writeFileSync(primerPath, 'SOL FAMILY PRIMER', 'utf8');

    assert.deepEqual(repository.readPrimer(scope), { content: 'SOL FAMILY PRIMER', path: primerPath });
  });

  it('rejects missing persona mappings instead of falling back to catId', () => {
    const { repository } = fixture({});
    assert.throws(() => repository.scope('default-user', 'new-cat'), /relationship key.*new-cat/i);
  });

  it('rejects unsafe cat, relationship, and target path values', () => {
    const { repository } = fixture({ codex: '../escape' });
    assert.throws(() => repository.scope('default-user', '../codex'), /catId/i);
    assert.throws(() => repository.scope('default-user', 'codex'), /relationshipKey/i);

    const valid = fixture().repository.scope('default-user', 'codex');
    assert.throws(
      () => fixture().repository.resolvePrimerTarget(valid, 'relationship/codex-primer.md'),
      /expected relationship\/maine-coon-primer\.md/i,
    );
    assert.throws(() => fixture().repository.resolvePrimerTarget(valid, '../escape.md'), /expected/i);
  });
});
