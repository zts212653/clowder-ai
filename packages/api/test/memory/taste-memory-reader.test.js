import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const PUBLIC_PATH = 'docs/taste/vignettes/complete-decision.md';
const PRIVATE_PATH = 'private/taste/private-decision.md';

function vignette(overrides = '') {
  return `---
when: 2026-08-01
quotes:
  - "Give the cat the evidence, not a preselected conclusion."
scene: >
  A real design decision needed the complete source scene.
  The unique tail is taste-decision-full-context.
tags: [evidence, autonomy, complete-context]
dimension: system-philosophy
privacy: public
catId: codex-sol
proposalId: proposal_test_approved
${overrides}---
`;
}

describe('TasteMemoryReader', () => {
  let root;
  let externalRoot;
  let repository;

  beforeEach(() => {
    root = join(tmpdir(), `taste-reader-${randomUUID().slice(0, 8)}`);
    externalRoot = join(tmpdir(), `taste-reader-external-${randomUUID().slice(0, 8)}`);
    mkdirSync(join(root, 'docs/taste/vignettes'), { recursive: true });
    mkdirSync(join(root, 'private/taste'), { recursive: true });
    mkdirSync(externalRoot, { recursive: true });
    repository = {
      canonicalRoot: () => root,
      approvalLockKey: () => join(root, 'docs/taste/index.md'),
    };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(externalRoot, { recursive: true, force: true });
  });

  it('reads a complete approved public decision payload with a stable revision coordinate', async () => {
    const raw = vignette();
    writeFileSync(join(root, PUBLIC_PATH), raw, 'utf8');
    const { TasteMemoryReader } = await import('../../dist/domains/memory/taste/TasteMemoryReader.js');
    const reader = new TasteMemoryReader(repository, 'owner-1');

    const result = reader.read({ ownerUserId: 'owner-1', sourcePath: PUBLIC_PATH });

    assert.ok(result);
    assert.equal(result.ownerUserId, 'owner-1');
    assert.equal(result.visibility, 'public');
    assert.equal(result.sourcePath, PUBLIC_PATH);
    assert.equal(result.revision, `sha256:${createHash('sha256').update(raw).digest('hex')}`);
    assert.deepEqual(result.payload, {
      when: '2026-08-01',
      quotes: ['Give the cat the evidence, not a preselected conclusion.'],
      scene: 'A real design decision needed the complete source scene. The unique tail is taste-decision-full-context.',
      tags: ['evidence', 'autonomy', 'complete-context'],
      dimension: 'system-philosophy',
      catId: 'codex-sol',
      proposalId: 'proposal_test_approved',
    });
    assert.equal(
      reader.read({ ownerUserId: 'owner-1', sourcePath: PUBLIC_PATH, revision: 'sha256:stale' }),
      null,
      'stale drill coordinates must fail closed',
    );
  });

  it('uses the same payload contract for private owner reads and rejects cross-owner reads', async () => {
    writeFileSync(join(root, PRIVATE_PATH), vignette().replace('privacy: public', 'privacy: sensitive'), 'utf8');
    const { TasteMemoryReader } = await import('../../dist/domains/memory/taste/TasteMemoryReader.js');
    const reader = new TasteMemoryReader(repository, 'owner-1');

    const ownerResult = reader.read({ ownerUserId: 'owner-1', sourcePath: PRIVATE_PATH });
    assert.ok(ownerResult);
    assert.equal(ownerResult.visibility, 'private');
    assert.deepEqual(Object.keys(ownerResult.payload), [
      'when',
      'quotes',
      'scene',
      'tags',
      'dimension',
      'catId',
      'proposalId',
    ]);

    assert.equal(reader.read({ ownerUserId: 'owner-2', sourcePath: PRIVATE_PATH }), null);
  });

  it('returns zero for paths outside the exact allowlist and for non-approved or invalid vignettes', async () => {
    const rejectedPath = 'docs/taste/vignettes/rejected.md';
    const invalidPath = 'docs/taste/vignettes/invalid.md';
    writeFileSync(join(root, rejectedPath), vignette('status: rejected\n'), 'utf8');
    writeFileSync(
      join(root, invalidPath),
      `---
when: 2026-08-01
quotes: []
tags: [missing-scene]
privacy: public
---
`,
      'utf8',
    );

    const { TasteMemoryReader } = await import('../../dist/domains/memory/taste/TasteMemoryReader.js');
    const reader = new TasteMemoryReader(repository, 'owner-1');

    assert.equal(reader.read({ ownerUserId: 'owner-1', sourcePath: rejectedPath }), null);
    assert.equal(reader.read({ ownerUserId: 'owner-1', sourcePath: invalidPath }), null);
    assert.equal(reader.read({ ownerUserId: 'owner-1', sourcePath: 'docs/taste/index.md' }), null);
    assert.equal(reader.read({ ownerUserId: 'owner-1', sourcePath: '../private/taste/private-decision.md' }), null);
    assert.equal(reader.read({ ownerUserId: 'owner-1', sourcePath: '/tmp/complete-decision.md' }), null);
  });

  it('rejects allowed-path symlinks that escape the repository or leave the Taste source lane', async () => {
    const externalTarget = join(externalRoot, 'outside.md');
    const externalLink = 'docs/taste/vignettes/external-link.md';
    writeFileSync(externalTarget, vignette(), 'utf8');
    symlinkSync(externalTarget, join(root, externalLink));

    const internalTarget = 'docs/reference/taste-shaped.md';
    const internalLink = 'docs/taste/vignettes/internal-link.md';
    mkdirSync(join(root, 'docs/reference'), { recursive: true });
    writeFileSync(join(root, internalTarget), vignette(), 'utf8');
    symlinkSync(join(root, internalTarget), join(root, internalLink));

    const { TasteMemoryReader } = await import('../../dist/domains/memory/taste/TasteMemoryReader.js');
    const reader = new TasteMemoryReader(repository, 'owner-1');

    assert.equal(reader.read({ ownerUserId: 'owner-1', sourcePath: externalLink }), null);
    assert.equal(
      reader.read({ ownerUserId: 'owner-1', sourcePath: internalLink }),
      null,
      'a symlink must not smuggle Taste-shaped content from outside the declared source lane',
    );
  });
});
