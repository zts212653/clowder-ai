import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createChatGitHubReader } from '../src/domains/workspace/chat-github-references.js';
import { readChatReference } from '../src/domains/workspace/chat-reference-reader.js';
import { registerWorktrees } from '../src/domains/workspace/workspace-security.js';

test('GitHub blob mapping resolves the requested ref in repositories with a large unrelated ref inventory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-blob-many-refs-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  try {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src/index.ts'), 'export {};\n');
    await mkdir(join(root, 'nested/src'), { recursive: true });
    await writeFile(join(root, 'nested/src/index.ts'), 'A shorter overlapping ref must not win.\n');
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Controlled reference sample');
    git('config', 'user.email', 'sample@invalid.test');
    git('remote', 'add', 'origin', 'https://github.com/fixture/many-refs.git');
    git('add', '.');
    git('commit', '-qm', 'A real reference target');
    const sha = git('rev-parse', 'HEAD');
    const unrelated = Array.from(
      { length: 1400 },
      (_, index) => `${sha} refs/heads/unrelated-${String(index).padStart(4, '0')}-${'x'.repeat(64)}`,
    );
    await writeFile(join(root, '.git/packed-refs'), '# pack-refs with: sorted\n' + unrelated.join('\n') + '\n');
    git('branch', 'feat/chat-path-links');
    git('branch', 'feat/路径+flow');
    git('check-ref-format', 'refs/heads/feat]safe');
    git('branch', 'feat]safe');
    git('branch', 'overlap');
    git('tag', '-a', 'release/slash-tag', '-m', 'An annotated tag');
    git('tag', 'overlap/nested');
    git('update-ref', 'refs/remotes/origin/remote/slash-branch', sha);
    assert.ok(Buffer.byteLength(git('for-each-ref', '--format=%(refname)')) > 65536);
    const entry = { id: 'many-ref-fixture', root, branch: 'main', head: sha };
    registerWorktrees([entry]);
    const reader = createChatGitHubReader();
    for (const ref of [
      'main',
      'feat/chat-path-links',
      'feat/路径+flow',
      'feat]safe',
      'overlap/nested',
      'release/slash-tag',
      'remote/slash-branch',
      sha.slice(0, 10),
    ]) {
      const target = await readChatReference(
        `https://github.com/fixture/many-refs/blob/${ref}/src/index.ts#L2`,
        root,
        [entry],
        reader,
      );
      assert.equal(target?.kind, 'file', ref);
      assert.equal(target?.kind === 'file' && target.path, 'src/index.ts');
      assert.equal(target?.kind === 'file' && target.line, 2);
    }
    for (const ref of ['missing/branch', 'main%5Bbad', 'main@%7B0%7D', 'main%5E%7Bcommit%7D', 'main%0Asrc']) {
      assert.equal(
        await readChatReference(`https://github.com/fixture/many-refs/blob/${ref}/src/index.ts`, root, [entry], reader),
        null,
        'Unknown refs and Git revision expressions never become repository mappings',
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
