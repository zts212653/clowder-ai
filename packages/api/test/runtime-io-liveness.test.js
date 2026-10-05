import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { CanonicalTasteMemoryCueSource } from '../dist/domains/memory/cue/sources/TasteMemoryCueSource.js';
import { clearEnvironmentCache, getEnvironmentProfile } from '../dist/domains/services/environment-detector.js';
import { FileTasteRepository } from '../dist/domains/taste/services/TasteRepository.js';
import { uninstallPlugin } from '../dist/infrastructure/connectors/plugins/plugin-installer.js';
import { invalidateCliCommand, resolveCliCommand } from '../dist/utils/cli-resolve.js';

async function fixture() {
  return mkdtemp(join(tmpdir(), 'runtime-io-liveness-'));
}
async function executable(path, text) {
  await writeFile(path, text);
  await chmod(path, 0o755);
}
test(
  'R06: Taste snapshot resolves repository once and yields while Git is slow',
  { skip: process.platform === 'win32' },
  async () => {
    const root = await fixture();
    const previousPath = process.env.PATH;
    try {
      await mkdir(join(root, 'bin'));
      await mkdir(join(root, 'docs/taste/vignettes'), { recursive: true });
      await executable(
        join(root, 'bin/git'),
        `#!/bin/sh\nprintf x >> '${join(root, 'git-calls')}'\n/bin/sleep 0.04\ncase "$1" in\nrev-parse) printf '%s\\n' '${root}' ;;\nworktree) printf 'worktree ${root}\\000branch refs/heads/main\\000' ;;\nesac\n`,
      );
      process.env.PATH = `${join(root, 'bin')}:${previousPath}`;
      for (let i = 0; i < 12; i++) {
        await writeFile(
          join(root, `docs/taste/vignettes/${i}.md`),
          `---\nwhen: today\nquotes: []\nscene: exact source ${i}\ntags: [design]\ndimension: cognitive-honesty\n---\n`,
        );
      }
      await symlink(join(root, 'docs/taste/vignettes/0.md'), join(root, 'docs/taste/vignettes/link.md'));
      const source = new CanonicalTasteMemoryCueSource(new FileTasteRepository(root), 'owner');
      let ticks = 0;
      const timer = setInterval(() => ticks++, 5);
      const result = await source.resolve({
        ownerUserId: 'owner',
        stage: 'review',
        selectedSkill: 'request-review',
        featureId: 'F1',
      });
      clearInterval(timer);
      assert.ok(result);
      assert.ok(ticks >= 3, `health timer starved (${ticks} ticks)`);
      assert.equal(
        (await readFile(join(root, 'git-calls'), 'utf8')).length,
        2,
        'repository identity must be resolved once per snapshot',
      );
      const payload = await source.read({
        ownerUserId: 'owner',
        anchor: 'taste-dimensions:cognitive-honesty',
        expectedRevision: result.revision,
      });
      assert.equal(payload.status, 'ok');
      if (payload.status === 'ok') assert.equal(payload.payload.totalCount, 12, 'symlink must remain excluded');
    } finally {
      process.env.PATH = previousPath;
      await rm(root, { recursive: true, force: true });
    }
  },
);
test('R09: cold concurrent environment requests share a probe while the event loop responds', async () => {
  clearEnvironmentCache();
  let yielded = false;
  const marker = yieldTurn().then(() => {
    yielded = true;
  });
  const [first, second] = await Promise.all([getEnvironmentProfile(true), getEnvironmentProfile(true)]);
  assert.ok(yielded, 'environment detection blocked the API event loop');
  assert.equal(first, second, 'cold callers should share one result');
  await marker;
});
test(
  'R10: PATH lookup does not launch which on a cold resolution',
  { skip: process.platform === 'win32' },
  async () => {
    const root = await fixture();
    const previousPath = process.env.PATH;
    const command = `io-liveness-cli-${process.pid}`;
    try {
      await executable(join(root, command), '#!/bin/sh\nexit 0\n');
      await executable(join(root, 'which'), `#!/bin/sh\n/bin/sleep 0.3\nprintf '%s\\n' '${join(root, command)}'\n`);
      process.env.PATH = root;
      invalidateCliCommand(command);
      const started = performance.now();
      assert.equal(resolveCliCommand(command), join(root, command));
      assert.ok(performance.now() - started < 150, 'synchronous PATH subprocess blocked the API');
    } finally {
      process.env.PATH = previousPath;
      invalidateCliCommand(command);
      await rm(root, { recursive: true, force: true });
    }
  },
);
test('R12: uninstall yields while recursively removing a plugin and preserves config', async () => {
  const root = await fixture();
  try {
    await mkdir(join(root, '.cat-cafe/plugins/my-plugin/nested'), { recursive: true });
    await mkdir(join(root, '.cat-cafe/im-connector-config'), { recursive: true });
    await writeFile(join(root, '.cat-cafe/im-connector-config/my-plugin.json'), '{}');
    await writeFile(join(root, '.cat-cafe/plugins/my-plugin/nested/index.js'), '');
    let yielded = false;
    const marker = yieldTurn().then(() => {
      yielded = true;
    });
    const result = await uninstallPlugin(root, 'my-plugin');
    assert.ok(yielded, 'recursive deletion ran synchronously');
    assert.deepEqual(result, { id: 'my-plugin', action: 'uninstalled', configPreserved: true });
    await marker;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('R12: expanded entry/byte budgets reject before publishing and clean staging', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { installPlugin } = await import('../dist/infrastructure/connectors/plugins/plugin-installer.js');
  const { readdir } = await import('node:fs/promises');
  const root = await fixture();
  try {
    const source = join(root, 'archive/my-plugin');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'connector.yaml'), 'id: my-plugin\nname: fixture\n');
    await writeFile(join(source, 'index.js'), 'export default {}');
    await promisify(execFile)('tar', ['czf', join(root, 'plugin.tar.gz'), '-C', join(root, 'archive'), 'my-plugin']);
    const result = await installPlugin(root, join(root, 'plugin.tar.gz'), new Set(), { maxExtractedEntries: 1 });
    assert.ok('code' in result && result.code === 'INVALID_ARCHIVE', 'expanded archive exceeded its entry budget');
    assert.deepEqual(
      await readdir(join(root, '.cat-cafe/plugins')),
      [],
      'failed install must leave no published/staging tree',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('R12: publication failure restores the installed tree and mutations of one plugin serialize', async () => {
  const { replacePluginTree, withPluginMutation } = await import(
    '../dist/infrastructure/connectors/plugins/plugin-filesystem.js'
  );
  const { setTimeout: delay } = await import('node:timers/promises');
  const root = await fixture();
  try {
    const target = join(root, 'installed');
    await mkdir(target);
    await writeFile(join(target, 'index.js'), 'old');
    await assert.rejects(replacePluginTree(join(root, 'missing-staging'), target));
    assert.equal(await readFile(join(target, 'index.js'), 'utf8'), 'old');
    let active = 0;
    let maximum = 0;
    const action = () =>
      withPluginMutation(target, async () => {
        maximum = Math.max(maximum, ++active);
        await delay(20);
        active--;
      });
    await Promise.all([action(), action(), action()]);
    assert.equal(maximum, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
