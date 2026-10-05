import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fetchAndCreateMainReader } from '../dist/infrastructure/harness-eval/publish-verdict/publication/replay-detection.js';

test(
  'R08: slow fresh-main fetch yields and a captured reader pins the fetched revision',
  { skip: process.platform === 'win32' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'replay-git-liveness-'));
    const previousPath = process.env.PATH;
    try {
      await mkdir(join(root, 'bin'));
      const script = join(root, 'bin/git');
      await writeFile(
        script,
        `#!${process.execPath}\nconst args = process.argv.slice(2);\nif (args.includes('fetch')) setTimeout(() => {}, 300);\nelse if (args.includes('rev-parse')) console.log('${'a'.repeat(40)}');\nelse if (args.includes('ls-tree')) console.log('bundle-1');\nelse if (args.includes('show')) console.log(args.at(-1));\n`,
      );
      await chmod(script, 0o755);
      process.env.PATH = `${join(root, 'bin')}:${previousPath}`;
      let ticks = 0;
      const timer = setInterval(() => ticks++, 5);
      const reader = await fetchAndCreateMainReader(root);
      clearInterval(timer);
      assert.ok(ticks >= 3, `slow git blocked health (${ticks} ticks)`);
      assert.ok(reader);
      assert.deepEqual(await reader.listBundleEntries(), ['bundle-1']);
      assert.equal(
        (await reader.readFile('verdicts/packet.md'))?.trim(),
        `${'a'.repeat(40)}:docs/harness-feedback/verdicts/packet.md`,
      );
      const controller = new AbortController();
      const cancelled = fetchAndCreateMainReader(root, { signal: controller.signal });
      setTimeout(() => controller.abort(), 20);
      await assert.rejects(Promise.resolve(cancelled), { name: 'AbortError' });
    } finally {
      process.env.PATH = previousPath;
      await rm(root, { recursive: true, force: true });
    }
  },
);
