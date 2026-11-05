import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createChatGitHubReader } from '../src/domains/workspace/chat-github-references.js';
import { readChatReference } from '../src/domains/workspace/chat-reference-reader.js';
import { registerWorktrees } from '../src/domains/workspace/workspace-security.js';

const prose = [
  'zh/en',
  'F225/F231',
  'PPT/Word/Excel',
  '@cat-cafe/shared',
  'owner/repo',
  '16/9.5',
  '2026/10/23',
  'v1.2',
  '127.0.0.1',
  'e.g',
  'object.property',
];
test('file discovery does not promote ambiguous prose to a missing-file claim', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-reference-meaning-'));
  const entry = { id: 'reference-meaning-fixture', root, branch: '', head: '' };
  registerWorktrees([entry]);
  try {
    const reader = createChatGitHubReader();
    for (const reference of prose)
      assert.equal(await readChatReference(reference, root, [entry], reader), null, reference);
    assert.deepEqual(await readChatReference('docs/gone.md', root, [entry], reader), { kind: 'missing' });
    assert.deepEqual(await readChatReference('./gone.md', root, [entry], reader), { kind: 'missing' });
    await mkdir(join(root, 'zh'));
    await writeFile(join(root, 'zh/en'), 'A real extensionless path');
    assert.equal(
      (await readChatReference('zh/en', root, [entry], reader))?.kind,
      'file',
      'Existence still verifies an ambiguous candidate',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('project aliases, subprojects and GitHub branches use the same registered canonical repository', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'chat-reference-coordinate-'));
  const root = join(parent, 'repo'),
    alias = join(parent, 'alias');
  const github = createChatGitHubReader();
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  try {
    await mkdir(join(root, 'packages/shared'), { recursive: true });
    await writeFile(join(root, 'README.md'), 'Repository README');
    await writeFile(join(root, 'packages/README.md'), 'Subproject README');
    await writeFile(join(root, 'packages/shared/index.ts'), 'export {};');
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@invalid.test');
    git('remote', 'add', 'origin', 'https://github.com/fixture/canonical.git');
    git('add', '.');
    git('commit', '-qm', 'Registered reference fixture');
    git('branch', 'feat/chat-path-links');
    await symlink(root, alias, 'dir');
    const canonical = await realpath(root);
    const entry = {
      id: 'reference-coordinate-fixture',
      root: canonical,
      branch: 'main',
      head: git('rev-parse', 'HEAD'),
    };
    registerWorktrees([entry]);
    const found = await readChatReference('README.md', alias, [entry], github);
    assert.equal(found?.kind, 'file', 'A realpath alias must resolve like the original Workspace reader');
    assert.equal(found?.kind === 'file' && found.path, 'README.md');
    for (const ref of ['main', 'feat/chat-path-links']) {
      const target = await readChatReference(
        `https://github.com/fixture/canonical/blob/${ref}/packages/shared/index.ts#L2`,
        join(root, 'packages'),
        [entry],
        github,
      );
      assert.equal(target?.kind, 'file', ref);
      assert.equal(target?.kind === 'file' && target.path, 'packages/shared/index.ts');
      assert.equal(target?.kind === 'file' && target.line, 2);
    }
    const rootFile = await readChatReference(
      'https://github.com/fixture/canonical/blob/main/README.md',
      join(root, 'packages'),
      [entry],
      github,
    );
    assert.equal(
      rootFile?.kind === 'file' && rootFile.path,
      'README.md',
      'Blob paths are repository-relative, not subproject-relative',
    );
    const nested = { id: 'reference-nested-fixture', root: join(canonical, 'packages'), branch: '', head: '' };
    registerWorktrees([nested]);
    assert.equal(
      await readChatReference(
        'https://github.com/fixture/canonical/blob/main/shared/index.ts',
        nested.root,
        [nested],
        github,
      ),
      null,
      'A linked subdirectory cannot borrow the parent remote',
    );
    assert.equal(
      await readChatReference('https://github.com/other/repo/blob/main/README.md', root, [entry], github),
      null,
    );
    assert.equal(
      await readChatReference('https://github.com/fixture/canonical/blob/not-a-ref/README.md', root, [entry], github),
      null,
    );
    const historical = await readChatReference(
      'README.md [wt:reference-coordinate-fixture]',
      join(root, 'packages'),
      [entry, nested],
      github,
    );
    assert.equal(historical?.kind === 'file' && historical.path, 'README.md');
    assert.equal(historical?.kind === 'file' && historical.worktreeId, entry.id);
    assert.equal(
      await readChatReference('README.md [wt:unregistered-old-root]', root, [entry], github),
      null,
      'An unknown historical hint never falls back to the active project',
    );
    git('remote', 'set-url', 'origin', 'https://notgithub.com/fixture/canonical.git');
    assert.equal(
      await readChatReference('https://github.com/fixture/canonical/blob/main/README.md', root, [entry], github),
      null,
      'Repository mapping validates the exact remote host, not a suffix of an unrelated host',
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
