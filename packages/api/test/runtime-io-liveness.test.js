import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { CanonicalTasteMemoryCueSource } from '../dist/domains/memory/cue/sources/TasteMemoryCueSource.js';
import { clearEnvironmentCache, getEnvironmentProfile } from '../dist/domains/services/environment-detector.js';
import { FileTasteRepository } from '../dist/domains/taste/services/TasteRepository.js';
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
