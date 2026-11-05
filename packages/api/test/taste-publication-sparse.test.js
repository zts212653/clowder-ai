// @ts-check
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TasteMemoryProjectionWriter } from '../dist/domains/memory/taste/TasteMemoryProjectionWriter.js';
import { FileTasteRepository } from '../dist/domains/taste/services/TasteRepository.js';
import { createVignetteWriter } from '../dist/domains/taste/services/writeVignette.js';
import { createRemoteFixture, git, makeProposal, remoteFile, remoteHead } from './taste-publication-fixtures.js';

// A tiny unrelated blob detects the same unnecessary checkout as the real multi-GiB
// evidence tree, without making every regression run copy that history to disk.
test('Taste add/correct/retire/forget only materialize the Taste tree and replay without another commit', async () => {
  const fixture = createRemoteFixture();
  const unrelatedPath = 'docs/evidence/unrelated/large-media.bin';
  const oldTombstone = 'docs/taste/tombstones/existing.json';
  const preparedRoots = [];
  let publications = 0;
  const publicationOptions = {
    beforePush: ({ checkoutRoot }) => {
      preparedRoots.push(checkoutRoot);
      publications++;
      assert.equal(
        existsSync(join(checkoutRoot, 'docs/evidence')),
        false,
        'unrelated evidence must stay unmaterialized',
      );
      assert.equal(existsSync(join(checkoutRoot, 'packages')), false, 'application sources are not publication inputs');
      assert.equal(readFileSync(join(checkoutRoot, oldTombstone), 'utf8'), '{"existing":true}\n');
      assert.equal(git(checkoutRoot, ['show', `HEAD:${unrelatedPath}`]), 'unrelated media');
      assert.equal(
        git(checkoutRoot, [
          'for-each-ref',
          '--format=%(refname)',
          'refs/remotes/origin/unrelated-local-feature',
          'refs/tags/unrelated-local-tag',
        ]),
        '',
        'unrelated local branches and tags must not be mirrored into the publication clone',
      );
      assert.ok(
        git(checkoutRoot, ['config', '--list'])
          .split('\n')
          .includes('core.alternaterefsprefixes=refs/heads/main refs/remotes/origin/main'),
        'shared-object connectivity must use only publication ancestry as alternate tips',
      );
    },
  };

  try {
    for (const [path, content] of [
      [unrelatedPath, 'unrelated media\n'],
      ['packages/web/unrelated.ts', 'export {};\n'],
      [oldTombstone, '{"existing":true}\n'],
    ]) {
      mkdirSync(join(fixture.primary, path, '..'), { recursive: true });
      writeFileSync(join(fixture.primary, path), content);
    }
    git(fixture.primary, ['add', 'docs', 'packages']);
    git(fixture.primary, ['commit', '-m', 'seed unrelated history and a Taste tombstone']);
    git(fixture.primary, ['push', 'origin', 'main']);
    git(fixture.primary, ['branch', 'unrelated-local-feature']);
    git(fixture.primary, ['tag', 'unrelated-local-tag']);
    writeFileSync(join(fixture.primary, 'human-wip.md'), 'staged human work\n');
    git(fixture.primary, ['add', 'human-wip.md']);
    const statusBefore = git(fixture.primary, ['status', '--porcelain=v1']);
    const headBefore = git(fixture.primary, ['rev-parse', 'HEAD']);

    const proposal = makeProposal({ id: 'proposal_sparse_abc789' });
    const writer = createVignetteWriter(fixture.runtime, publicationOptions);
    const added = await writer(proposal);
    const lifecycle = new TasteMemoryProjectionWriter(new FileTasteRepository(fixture.runtime), { publicationOptions });
    const current = await lifecycle.readCurrent(added.path);
    assert.ok(current);
    const apply = (command) =>
      lifecycle.apply({
        ownerUserId: proposal.userId,
        sourcePath: added.path,
        command,
        recordTargetRevision: () => {},
      });
    const corrected = await apply({
      action: 'correct',
      requestId: 'sparse-correct',
      expectedRevision: current.revision,
      patch: { scene: 'Corrected in a sparse checkout' },
    });
    assert.match(remoteFile(fixture, added.path), /Corrected in a sparse checkout/);
    const retired = await apply({ action: 'retire', requestId: 'sparse-retire', expectedRevision: corrected.revision });
    const forget = {
      action: 'hard_forget',
      requestId: 'sparse-forget',
      expectedRevision: retired.revision,
      confirmed: true,
    };
    const forgotten = await apply(forget);
    const finalHead = remoteHead(fixture);
    assert.equal(forgotten.status, 'forgotten');
    assert.equal(git(fixture.root, ['--git-dir', fixture.origin, 'ls-tree', 'main', '--', added.path]), '');
    assert.equal(remoteFile(fixture, 'docs/taste/index.md').includes(added.path.replace('docs/taste/', '')), false);
    assert.equal(
      git(fixture.root, [
        '--git-dir',
        fixture.origin,
        'ls-tree',
        '-r',
        '--name-only',
        'main',
        '--',
        'docs/taste/tombstones',
      ]).split('\n').length,
      2,
    );
    assert.equal((await apply(forget)).status, 'forgotten');
    assert.equal(remoteHead(fixture), finalHead, 'forget replay must use the existing tombstone');
    assert.equal(publications, 4);
    assert.equal(remoteFile(fixture, unrelatedPath), 'unrelated media');
    assert.equal(remoteFile(fixture, 'packages/web/unrelated.ts'), 'export {};');
    assert.equal(git(fixture.primary, ['rev-parse', 'HEAD']), headBefore);
    assert.equal(git(fixture.primary, ['status', '--porcelain=v1']), statusBefore);
    assert.equal(
      preparedRoots.every((root) => !existsSync(root)),
      true,
      'disposable checkouts must be removed',
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('sparse Taste approval preserves tracked hook dependencies and runs the inbound guard for ordinary and trigger-word slugs', async () => {
  const fixture = createRemoteFixture();
  const inboundLog = join(fixture.root, 'inbound.log');
  try {
    // These are tracked inputs: merely pointing at the real hooks did not catch
    // their cwd-relative dependencies when the fixture itself lacked scripts/.
    for (const path of ['scripts/brand-dictionary-helper.mjs', 'assets/brand-dictionary.yaml']) {
      mkdirSync(join(fixture.primary, path, '..'), { recursive: true });
      writeFileSync(join(fixture.primary, path), readFileSync(new URL(`../../../${path}`, import.meta.url)));
    }
    writeFileSync(
      join(fixture.primary, 'scripts/intake-from-opensource.sh'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${inboundLog}'\n`,
    );
    writeFileSync(join(fixture.primary, 'docs/.gitattributes'), 'taste/vignettes/*.md text\n');
    git(fixture.primary, ['add', 'scripts', 'assets', 'docs/.gitattributes']);
    git(fixture.primary, ['commit', '-m', 'seed checkout-relative hook inputs']);
    git(fixture.primary, ['push', 'origin', 'main']);
    const hooks = fileURLToPath(new URL('../../../.githooks', import.meta.url));
    git(fixture.runtime, ['config', 'core.hooksPath', hooks]);
    const writer = createVignetteWriter(fixture.runtime, {
      beforePush: ({ checkoutRoot }) => {
        assert.equal(existsSync(join(checkoutRoot, 'docs/.gitattributes')), true);
        assert.equal(existsSync(join(checkoutRoot, 'assets/system-prompts')), false);
      },
    });
    for (const [suffix, tag] of [
      ['abc790', 'ordinary'],
      ['abc791', 'evaluation-first'],
    ]) {
      const proposal = makeProposal({ id: `proposal_sparse_hooks_${suffix}`, tags: [tag] });
      const result = await writer(proposal);
      assert.match(remoteFile(fixture, result.path), new RegExp(`proposalId: ${proposal.id}`));
    }
    assert.deepEqual(readFileSync(inboundLog, 'utf8').trim().split('\n'), [
      '--validate-inbound --from-index --state-migration-advisory',
      '--validate-inbound --from-index --state-migration-advisory',
    ]);
  } finally {
    // Linked worktree config is shared with this fixture's primary, never the
    // real checkout that owns the hooks.
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
