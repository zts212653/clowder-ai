import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createChatGitHubReader } from '../src/domains/workspace/chat-github-references.js';
import { readChatReference } from '../src/domains/workspace/chat-reference-reader.js';
import { registerWorktrees } from '../src/domains/workspace/workspace-security.js';

test('normalizes parent paths within the bound project root without borrowing another registered root', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'chat-relative-lifecycle-'));
  const root = join(parent, 'repo'),
    other = join(parent, 'other');
  try {
    await mkdir(join(root, 'packages/web'), { recursive: true });
    await mkdir(join(root, 'packages/shared'));
    await mkdir(other);
    await writeFile(join(root, 'packages/shared/index.md'), 'Same registered root');
    await writeFile(join(root, '..notes.md'), 'A filename, not a parent path segment');
    await writeFile(join(other, 'index.md'), 'A different registered root');
    const entry = { id: 'relative-lifecycle', root: await realpath(root), branch: '', head: '' };
    const foreign = { id: 'relative-lifecycle-other', root: await realpath(other), branch: '', head: '' };
    const entries = [entry, foreign],
      reader = createChatGitHubReader(),
      project = join(root, 'packages/web');
    registerWorktrees(entries);
    const found = await readChatReference('../shared/index.md:2', project, entries, reader);
    assert.equal(found?.kind, 'file');
    assert.equal(found?.kind === 'file' && found.worktreeId, entry.id);
    assert.equal(found?.kind === 'file' && found.path, 'packages/shared/index.md');
    assert.equal(found?.kind === 'file' && found.line, 2);
    const dotName = await readChatReference('../../..notes.md', project, entries, reader);
    assert.equal(dotName?.kind === 'file' && dotName.path, '..notes.md');
    assert.deepEqual(await readChatReference('../shared/new/gone.md', project, entries, reader), { kind: 'missing' });
    for (const reference of ['../../../other/index.md', '../../../other/gone.md', '../../../../escape.md'])
      assert.equal(await readChatReference(reference, project, entries, reader), null, reference);
    await symlink(other, join(root, 'packages/shared/escape'), 'dir');
    for (const reference of ['../shared/escape/index.md', '../shared/escape/gone.md'])
      assert.equal(await readChatReference(reference, project, entries, reader), null, reference);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('keeps canonical alias paths missing after deletion and through missing parent directories', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'chat-alias-lifecycle-'));
  const root = join(parent, 'repo'),
    alias = join(parent, 'alias');
  try {
    await mkdir(join(root, 'docs'), { recursive: true });
    await symlink(root, alias, 'dir');
    const file = join(root, 'docs/exists.md');
    await writeFile(file, 'Initially exists');
    const entry = { id: 'alias-lifecycle', root: await realpath(root), branch: '', head: '' };
    registerWorktrees([entry]);
    const reader = createChatGitHubReader();
    // The explicit alias works everywhere; root also covers macOS /var or /tmp aliases when present.
    for (const reference of [join(alias, 'docs/exists.md'), file])
      assert.equal((await readChatReference(reference, root, [entry], reader))?.kind, 'file');
    await rm(file);
    for (const reference of [join(alias, 'docs/exists.md'), file, join(alias, 'docs/new/deeper/gone.md:4')])
      assert.deepEqual(await readChatReference(reference, root, [entry], reader), { kind: 'missing' }, reference);
    assert.equal(await readChatReference(join(alias, '.env.missing'), root, [entry], reader), null);
    await mkdir(join(root, 'secrets'));
    await symlink(join(root, 'secrets'), join(root, 'docs/public'), 'dir');
    assert.equal(await readChatReference('docs/public/gone.md', root, [entry], reader), null);
    await symlink(join(parent, 'unregistered'), join(root, 'docs/dangling'), 'dir');
    assert.equal(await readChatReference('docs/dangling/gone.md', root, [entry], reader), null);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('retains missing truth for named numeric-extension files without promoting numeric prose', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-extension-lifecycle-'));
  try {
    await mkdir(join(root, 'docs'));
    const entry = { id: 'extension-lifecycle', root, branch: '', head: '' };
    registerWorktrees([entry]);
    const reader = createChatGitHubReader();
    for (const name of ['archive.7z', 'part.001', 'model.3mf']) {
      const reference = 'docs/' + name;
      await writeFile(join(root, reference), 'Present');
      assert.equal((await readChatReference(reference, root, [entry], reader))?.kind, 'file');
      await rm(join(root, reference));
      assert.deepEqual(await readChatReference(reference, root, [entry], reader), { kind: 'missing' }, reference);
    }
    for (const prose of ['16/9.5', 'versions/1.2', '2026/10/23', 'v1.2', '127.0.0.1'])
      assert.equal(await readChatReference(prose, root, [entry], reader), null, prose);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('does not assert missing files behind denied, escaped or dangling symlink ancestors', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'chat-missing-ancestor-'));
  const root = join(parent, 'repo'),
    other = join(parent, 'other');
  try {
    await mkdir(join(root, 'docs'), { recursive: true });
    await mkdir(join(root, 'secrets'));
    await mkdir(other);
    await symlink(join(root, 'secrets'), join(root, 'docs/public'), 'dir');
    await symlink(other, join(root, 'docs/escape'), 'dir');
    await symlink(join(parent, 'unregistered'), join(root, 'docs/dangling'), 'dir');
    const entries = [
      { id: 'missing-ancestor', root, branch: '', head: '' },
      { id: 'missing-ancestor-other', root: other, branch: '', head: '' },
    ];
    registerWorktrees(entries);
    for (const reference of ['docs/public/gone.md', 'docs/escape/gone.md', 'docs/dangling/gone.md'])
      assert.equal(await readChatReference(reference, root, entries, createChatGitHubReader()), null, reference);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
