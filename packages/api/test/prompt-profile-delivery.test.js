/**
 * The session prompt must still deliver the owner's F231 profile.
 *
 * Before the prompt-hook runtime replaced it, the L0 compiler rendered
 * `{{USER_CAPSULE}}`: the owner capsule from `operator-capsule.md` plus a
 * relationship-primer pointer when that persona had one. `1fa1999d4` retired the
 * L0 compiler and rewired the providers onto HookPipeline, but no session segment
 * took the profile over, and no test covered it -- session-hook-colocation only
 * compares the L1-L7 static templates, so a full public suite stayed green while
 * the capability was gone.
 *
 * These are the pipeline-level delivery contracts, asserted at the builder the routes
 * call (`buildStaticIdentity`). Carrier parity lives in f257-route-seam.test.js, where
 * the serial and parallel routes really run.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { before, describe, it } from 'node:test';
import { renderUserCapsuleSection } from '@cat-cafe/shared/profile-contract';

// The heading comes from the canonical F231 renderer, not from this test: asserting a
// hand-written '## ...' would pass while the real contract drifted.
const CAPSULE_BODY = 'lang：co-creator，偏好直接、证据优先的沟通。';
const CAPSULE_SECTION = renderUserCapsuleSection(CAPSULE_BODY);
const RELATIONSHIP_POINTER = '关系轨迹: cat-cafe-profile://relationship/current（cat_cafe_read_profile 按需读）';
// Exact upstream Phase E line (scripts/compile-system-prompt-l0.mjs), not a paraphrase.
const CORPUS_POINTER = '共享事实: cat-cafe-profile://corpus/current（cat_cafe_read_profile layer=corpus 按需读）';

describe('session prompt delivers the owner profile', () => {
  /** @type {typeof import('../dist/domains/cats/services/context/SystemPromptBuilder.js')} */
  let promptBuilder;

  before(async () => {
    const shared = await import('@cat-cafe/shared');
    shared.catRegistry.reset();
    shared.catRegistry.register('opus', {
      displayName: '布偶猫',
      nickname: '宪宪',
      name: 'Ragdoll',
      roleDescription: '主架构师和核心开发者',
      personality: '温柔但有主见',
      defaultModel: 'claude-opus-4-6',
      mentionPatterns: ['@opus', '@布偶猫'],
      restrictions: [],
      clientId: 'anthropic',
      breedId: 'ragdoll',
      relationshipKey: 'ragdoll',
    });
    promptBuilder = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
  });

  const OWNER_ID = 'owner-42-id-token';
  const profile = (pointerLines = [RELATIONSHIP_POINTER]) => ({
    userId: OWNER_ID,
    capsuleSection: CAPSULE_SECTION,
    pointerLines,
  });

  it('carries the owner capsule and the relationship pointer into static identity', () => {
    const prompt = promptBuilder.buildStaticIdentity('opus', { mcpAvailable: true, profile: profile() });

    assert.ok(prompt.includes(CAPSULE_SECTION), 'the owner capsule must reach the session prompt');
    assert.ok(prompt.includes(RELATIONSHIP_POINTER), 'the relationship pointer must reach the session prompt');
  });

  // Carrier parity is NOT asserted here on purpose: calling this builder twice with a
  // different mcpAvailable flag would stay green even if the routes never passed profile
  // truth. It is asserted at the real serial/parallel seam in f257-route-seam.test.js.
  it('delivers the bytes it was given without rewriting them', () => {
    // The bridge used to .trim() each part, so "exact bytes" was not true for any
    // capsule with edge whitespace — and an includes() assertion never noticed.
    const capsuleSection = `${renderUserCapsuleSection('边界空白 内容')}\n`;
    const prompt = promptBuilder.buildStaticIdentity('opus', {
      mcpAvailable: true,
      profile: { userId: OWNER_ID, capsuleSection, pointerLines: [] },
    });

    assert.ok(prompt.includes(capsuleSection), 'the section must appear byte-for-byte, trailing newline included');
  });

  it('never writes the owner id or a filesystem path into the prompt', () => {
    const prompt = promptBuilder.buildStaticIdentity('opus', {
      mcpAvailable: true,
      profile: profile([RELATIONSHIP_POINTER, CORPUS_POINTER]),
    });

    // The section is the owner's content plus logical URIs. An owner id or an absolute
    // path here would also reach the persisted trace, which is a different disclosure
    // than the profile bytes themselves.
    // The capsule body may well name the person; what must never appear is the owner
    // *id* the route resolved, which is why the fixture id is a distinct token.
    assert.equal(prompt.includes(OWNER_ID), false, 'the owner id must not be rendered');
    assert.equal(/\/(?:Users|home|var|tmp)\//.test(prompt), false, 'no absolute path may be rendered');
    assert.equal(prompt.includes('.cat-cafe/'), false, 'no data-root path may be rendered');
    assert.equal(prompt.includes('operator-capsule.md'), false, 'no profile file name may be rendered');
  });

  it('refuses to resolve an owner profile for a cat with no relationship key', async () => {
    const { resolveOwnerProfileSnapshot } = await import(
      '../dist/domains/cats/services/profile/owner-profile-snapshot.js'
    );
    const { catRegistry } = await import('@cat-cafe/shared');
    catRegistry.register('nokeycat', {
      displayName: '无键猫',
      name: 'NoKey',
      roleDescription: 'x',
      personality: 'y',
      defaultModel: 'claude-opus-4-6',
      mentionPatterns: ['@nokeycat'],
      restrictions: [],
      clientId: 'anthropic',
      breedId: 'ragdoll',
    });

    // Identity is fail-closed. `cat-config-loader` fills relationshipKey from the breed
    // id for every production cat, so a cat without one is a broken catalog invariant,
    // not a cat that merely has no primer. Silently dropping the pointer would hide it.
    assert.throws(
      () => resolveOwnerProfileSnapshot({ catId: 'nokeycat' }),
      /No relationship key configured for catId "nokeycat"/,
      'a missing relationship key must fail closed, not degrade to a missing pointer',
    );
  });

  it('injects nothing when the owner has no profile', () => {
    const prompt = promptBuilder.buildStaticIdentity('opus', { mcpAvailable: true });

    assert.equal(prompt.includes(CAPSULE_SECTION), false);
    assert.equal(prompt.includes('cat-cafe-profile://'), false, 'no pointer may appear without profile truth');
  });
});

/**
 * P2 (砚砚): the builder-level r1/r2 check only proved `buildStaticIdentity` has no
 * cache of its own. The cache that was removed with the L0 compiler sat between the
 * file and the snapshot, so only a route-level walk over real files can prove a later
 * session cannot serve an earlier revision. These drive
 * repository -> resolveOwnerProfileSnapshot -> buildStaticIdentity on disk.
 */
describe('owner profile is resolved from disk on every session', () => {
  /** @type {typeof import('../dist/domains/cats/services/profile/owner-profile-snapshot.js')} */
  let snapshotModule;
  /** @type {typeof import('../dist/domains/cats/services/profile/ProfileRepository.js')} */
  let repositoryModule;
  /** @type {typeof import('../dist/domains/cats/services/context/SystemPromptBuilder.js')} */
  let builder;

  const OWNER = 'disk-owner-id-token';
  const ENV = { CAT_CAFE_USER_ID: OWNER };

  before(async () => {
    snapshotModule = await import('../dist/domains/cats/services/profile/owner-profile-snapshot.js');
    repositoryModule = await import('../dist/domains/cats/services/profile/ProfileRepository.js');
    builder = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
  });

  const freshRepository = (t) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cat-cafe-owner-profile-'));
    t.after(() => rmSync(dataDir, { recursive: true, force: true }));
    const repository = new repositoryModule.FileProfileRepository({ dataDir });
    mkdirSync(repository.profileDir(OWNER), { recursive: true });
    return repository;
  };

  const promptFor = (repository) => {
    const profile = snapshotModule.resolveOwnerProfileSnapshot({ catId: 'opus', repository, env: ENV });
    return builder.buildStaticIdentity('opus', { mcpAvailable: true, ...(profile ? { profile } : {}) });
  };

  it('serves an edited capsule on the next session, never the previous revision', (t) => {
    const repository = freshRepository(t);
    const capsulePath = join(repository.profileDir(OWNER), 'operator-capsule.md');

    writeFileSync(capsulePath, 'r1 磁盘内容');
    const r1 = promptFor(repository);
    assert.ok(r1.includes('r1 磁盘内容'), 'the first session must deliver revision 1 from disk');

    writeFileSync(capsulePath, 'r2 磁盘内容');
    const r2 = promptFor(repository);

    assert.ok(r2.includes('r2 磁盘内容'), 'the next session must deliver the edited file');
    assert.equal(r2.includes('r1 磁盘内容'), false, 'no cache may serve the superseded revision');
  });

  it('emits the Phase E corpus pointer only once the owner actually has a corpus', (t) => {
    const repository = freshRepository(t);
    writeFileSync(join(repository.profileDir(OWNER), 'operator-capsule.md'), '有主人画像');

    assert.equal(promptFor(repository).includes(CORPUS_POINTER), false, 'no corpus file means no corpus pointer');

    const corpusPath = repository.corpusPath(OWNER);
    mkdirSync(dirname(corpusPath), { recursive: true });
    writeFileSync(corpusPath, '共享语料内容');

    const withCorpus = promptFor(repository);
    assert.ok(withCorpus.includes(CORPUS_POINTER), 'a written corpus must produce the Phase E pointer');
    assert.equal(withCorpus.includes('共享语料内容'), false, 'INV-6: the pointer must not carry corpus content');
  });

  it('emits the relationship pointer only once the primer exists, without its content', (t) => {
    const repository = freshRepository(t);
    writeFileSync(join(repository.profileDir(OWNER), 'operator-capsule.md'), '有主人画像');

    assert.equal(promptFor(repository).includes(RELATIONSHIP_POINTER), false, 'no primer means no pointer');

    const primerPath = repository.primerPath(repository.scope(OWNER, 'opus'));
    mkdirSync(dirname(primerPath), { recursive: true });
    writeFileSync(primerPath, '关系正文不应进入 prompt');

    const withPrimer = promptFor(repository);
    assert.ok(withPrimer.includes(RELATIONSHIP_POINTER), 'a written primer must produce the pointer');
    assert.equal(
      withPrimer.includes('关系正文不应进入 prompt'),
      false,
      'INV-6: primer content stays out of the prompt',
    );
  });
});
