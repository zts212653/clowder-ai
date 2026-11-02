import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { publishTasteProjection } from '../dist/domains/taste/services/GitTastePublisher.js';
import { createVignetteWriter } from '../dist/domains/taste/services/writeVignette.js';
import { git, makeProposal, remoteFile, remoteHead } from './taste-publication-fixtures.js';
import {
  assertFailedForget,
  assertPublicationCleanup,
  attachFixtureBiome,
  captureSourceState,
  createRealHookFixture,
  createRealHookLifecycle,
  forgetCommand,
  ownerUserId,
  sourcePath,
  tombstonePath,
} from './taste-real-hook-fixture.js';

test('hard_forget commits deletion/index/tombstone atomically through real hooks, and replay adds no commit', async () => {
  const fixture = createRealHookFixture();
  attachFixtureBiome(fixture);
  writeFileSync(join(fixture.runtime, 'pnpm-lock.yaml'), '# uncommitted operator lockfile WIP\n');
  const before = remoteHead(fixture);
  const sourceBefore = captureSourceState(fixture);
  let lifecycle;
  let commits = 0;
  lifecycle = createRealHookLifecycle(fixture, {
    publicationOptions: {
      beforePush: ({ checkoutRoot }) => {
        commits++;
        assert.equal(remoteHead(fixture), before, 'no remote deletion before the complete commit');
        assert.equal(lifecycle.db.prepare('SELECT status FROM taste_memory_lifecycle').get().status, 'mutating');
        assert.equal(
          lifecycle.store.getOwnerActionEvidence(ownerUserId, sourcePath, forgetCommand.requestId).applied,
          false,
        );
        assert.deepEqual(
          git(checkoutRoot, ['diff', '--name-only', before, 'HEAD']).split('\n').sort(),
          ['docs/taste/index.md', tombstonePath, sourcePath].sort(),
        );
        assert.equal(lstatSync(join(checkoutRoot, 'node_modules/@biomejs/biome')).isSymbolicLink(), true);
        assert.equal(
          realpathSync(join(checkoutRoot, 'node_modules/@biomejs/biome')),
          realpathSync(join(fixture.runtime, 'node_modules/@biomejs/biome')),
        );
        assert.deepEqual(readdirSync(join(checkoutRoot, 'node_modules')).sort(), ['.bin', '@biomejs']);
        assert.deepEqual(readdirSync(join(checkoutRoot, 'node_modules/.bin')), ['biome']);
      },
    },
  });
  try {
    await assertPublicationCleanup(fixture, async () => {
      assert.equal((await lifecycle.apply()).outcome, 'applied');
      const published = remoteHead(fixture);
      assert.equal(
        Number(git(fixture.root, ['--git-dir', fixture.origin, 'rev-list', '--count', `${before}..main`])),
        1,
      );
      assert.equal(git(fixture.root, ['--git-dir', fixture.origin, 'ls-tree', 'main', '--', sourcePath]), '');
      assert.equal(remoteFile(fixture, 'docs/taste/index.md').includes('isolated-hook-forget.md'), false);
      assert.equal(JSON.parse(remoteFile(fixture, tombstonePath)).requestId, forgetCommand.requestId);
      assert.equal(await lifecycle.writer.readCurrent(sourcePath), null, 'canonical snapshot confirms deletion');
      assert.equal((await lifecycle.apply()).outcome, 'replayed');
      // A fresh projection retry must also consume the existing remote tombstone.
      assert.equal(
        (await lifecycle.writer.apply({ ownerUserId, sourcePath, command: forgetCommand, recordTargetRevision() {} }))
          .status,
        'forgotten',
      );
      assert.equal(remoteHead(fixture), published);
      assert.equal(commits, 1);
      assert.deepEqual(captureSourceState(fixture), sourceBefore, 'source WIP/index/tools remain untouched');
    });
  } finally {
    lifecycle.db.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

for (const failure of ['missing', 'wrong-package', 'wrong-binary', 'push-rejected']) {
  test(`real hard_forget rejects ${failure} without a forgotten receipt or source/remote changes`, async () => {
    const fixture = createRealHookFixture();
    if (failure === 'push-rejected') {
      attachFixtureBiome(fixture);
      const hook = join(fixture.origin, 'hooks/pre-receive');
      writeFileSync(hook, '#!/bin/sh\nprintf "called\\n" > ./f221-pre-receive.log\nexit 1\n');
      chmodSync(hook, 0o755);
    }
    if (failure === 'wrong-package') attachFixtureBiome(fixture, { version: '0.0.0' });
    if (failure === 'wrong-binary') {
      const binary = join(fixture.root, 'wrong-biome');
      writeFileSync(binary, '#!/bin/sh\nprintf "Version: 0.0.0\\n"\n');
      chmodSync(binary, 0o755);
      attachFixtureBiome(fixture, { binary });
    }
    const lifecycle = createRealHookLifecycle(fixture);
    const before = remoteHead(fixture);
    const sourceBefore = captureSourceState(fixture);
    try {
      const expected =
        failure === 'missing'
          ? /no local Biome install/
          : failure === 'wrong-package'
            ? /Biome version mismatch/
            : failure === 'wrong-binary'
              ? /Biome binary version mismatch/
              : /failed to push some refs/;
      await assertPublicationCleanup(fixture, () => assert.rejects(lifecycle.apply(), expected));
      if (failure === 'push-rejected') {
        assert.equal(readFileSync(join(fixture.origin, 'f221-pre-receive.log'), 'utf8'), 'called\n');
      }
      assertFailedForget(fixture, lifecycle, before, sourceBefore);
    } finally {
      lifecycle.db.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

test('verified tooling still runs the actual Biome guard and rejects an invalid tombstone', async () => {
  const fixture = createRealHookFixture();
  attachFixtureBiome(fixture);
  const lifecycle = createRealHookLifecycle(fixture, {
    publishProjection: (input, options) =>
      publishTasteProjection(
        {
          ...input,
          materialize: (root) => {
            const state = input.materialize(root);
            writeFileSync(join(root, tombstonePath), '{"invalid":true}\n');
            return state;
          },
        },
        options,
      ),
  });
  const before = remoteHead(fixture);
  const sourceBefore = captureSourceState(fixture);
  try {
    await assertPublicationCleanup(fixture, () => assert.rejects(lifecycle.apply(), /Formatter would have printed/i));
    assertFailedForget(fixture, lifecycle, before, sourceBefore);
  } finally {
    lifecycle.db.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('Markdown-only approval retains its no-Biome contract and the real inbound guard rejects illegal content', async () => {
  const fixture = createRealHookFixture();
  try {
    assert.equal(existsSync(join(fixture.runtime, 'node_modules')), false);
    const writer = createVignetteWriter(fixture.runtime);
    const added = await writer(makeProposal({ id: 'proposal_hooks_md_abc456', tags: ['ordinary'] }));
    assert.match(remoteFile(fixture, added.path), /proposal_hooks_md_abc456/);
    const before = remoteHead(fixture);
    await assertPublicationCleanup(fixture, () =>
      assert.rejects(
        writer(makeProposal({ id: 'proposal_hooks_bad_abc457', tags: ['ordinary'], scene: 'Clowder AI' })),
        /contains public brand term 'Clowder AI'.*Inbound Guard failed/s,
      ),
    );
    assert.equal(remoteHead(fixture), before);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
