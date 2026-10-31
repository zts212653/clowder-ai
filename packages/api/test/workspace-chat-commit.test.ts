import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { createChatGitHubReader } from '../src/domains/workspace/chat-github-references.js';
import { readChatReference } from '../src/domains/workspace/chat-reference-reader.js';
import { registerWorktrees } from '../src/domains/workspace/workspace-security.js';
import { workspaceRoutes } from '../src/routes/workspace.js';

test('real commit links converge to the same bounded diff without reading denied files or borrowing a parent repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-commit-'));
  const app = Fastify();
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  try {
    git('init', '-q', '-b', 'main');
    git('remote', 'add', 'origin', 'https://github.com/fixture/registered.git');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@invalid.test');
    await writeFile(join(root, 'visible.md'), '# Known commit\n');
    await writeFile(join(root, '.env.local'), 'HIDDEN_FIXTURE_ONLY=must-not-leak\n');
    await mkdir(join(root, 'linked-folder'));
    git('add', '.');
    git('commit', '-qm', 'Known fixture change');
    const sha = git('rev-parse', 'HEAD');
    const entry = { id: 'commit-root-fixture', root, branch: 'fixture', head: sha };
    const linked = { id: 'commit-linked-fixture', root: join(root, 'linked-folder'), branch: '', head: '' };
    registerWorktrees([entry, linked]);
    await app.register(workspaceRoutes, {
      threadStore: { get: () => ({ createdBy: 'owner', projectPath: root }) as never, list: () => [] },
    });
    const target = await readChatReference(sha.slice(0, 10), root, [entry], createChatGitHubReader());
    assert.deepEqual(target, { kind: 'commit', worktreeId: entry.id, sha, title: 'Known fixture change' });
    const blob = await readChatReference(
      'https://github.com/fixture/registered/blob/main/visible.md#L2',
      root,
      [entry],
      createChatGitHubReader(),
    );
    assert.equal(blob?.kind, 'file');
    if (blob?.kind === 'file') {
      assert.equal(blob.path, 'visible.md');
      assert.equal(blob.line, 2);
    }
    assert.equal(
      await readChatReference(
        'https://github.com/other/repo/blob/main/visible.md',
        root,
        [entry],
        createChatGitHubReader(),
      ),
      null,
    );
    const query = new URLSearchParams({ threadId: 'owned', worktreeId: entry.id, sha });
    const result = await app.inject({
      method: 'GET',
      url: `/api/workspace/chat-commit-changes?${query}`,
      headers: { 'x-cat-cafe-user': 'owner' },
    });
    assert.equal(result.statusCode, 200, result.body);
    assert.match(result.json().diff, /Known commit/);
    assert.deepEqual(result.json().changedFiles, [{ path: 'visible.md', status: 'A' }]);
    assert.doesNotMatch(result.body, /must-not-leak|\.env/);
    assert.equal(await readChatReference('f'.repeat(40), root, [entry], createChatGitHubReader()), null);
    assert.equal(
      await readChatReference(sha, linked.root, [linked], createChatGitHubReader()),
      null,
      'metadata must not borrow the parent repo either',
    );
    query.set('worktreeId', linked.id);
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: `/api/workspace/chat-commit-changes?${query}`,
          headers: { 'x-cat-cafe-user': 'owner' },
        })
      ).statusCode,
      403,
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
