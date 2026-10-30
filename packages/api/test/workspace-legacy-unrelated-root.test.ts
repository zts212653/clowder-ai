import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { listWorktrees } from '../src/domains/workspace/workspace-security.js';
import {
  durableIdForCanonicalRoot,
  resolveAuthorizedWorkspaceContentWorktree,
} from '../src/domains/workspace/workspace-worktree-identity.js';

test('a pinned unrelated unavailable connection does not hide a readable legacy video directory', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'f322-video-file-root-'));
  try {
    const root = join(await realpath(temp), 'cat-planet');
    const missing = join(await realpath(temp), 'retired-project');
    await mkdir(root);
    await promisify(execFile)('git', ['init', '-q', root]);
    const prefix = createHash('sha256').update(root).digest('hex').slice(0, 6);
    assert.notEqual(createHash('sha256').update(missing).digest('hex').slice(0, 6), prefix);
    const currentEntries = await listWorktrees(root);
    const request = {
      worktreeId: `${prefix}_${basename(root)}`,
      currentEntries: [],
      configuredEntries: [],
      legacyRoots: [root, missing],
      listWorktrees,
    };
    const target = { id: durableIdForCanonicalRoot(root), rootIdentity: durableIdForCanonicalRoot(root), root };
    const stale = {
      id: durableIdForCanonicalRoot(missing),
      rootIdentity: durableIdForCanonicalRoot(missing),
      root: missing,
    };
    assert.equal(currentEntries[0]?.root, root);
    const canonical = await resolveAuthorizedWorkspaceContentWorktree({
      ...request,
      worktreeId: target.id,
      linkedEntries: [target, stale],
    });
    assert.equal(canonical?.root, root, 'the existing strong root grant is readable');
    const legacy = await resolveAuthorizedWorkspaceContentWorktree({ ...request, linkedEntries: [target, stale] });
    assert.deepEqual(legacy, canonical, 'the same video locator must not depend on unrelated directory availability');
    assert.equal(
      await resolveAuthorizedWorkspaceContentWorktree({
        ...request,
        linkedEntries: [target, { id: 'unknown-legacy', root: missing }],
      }),
      null,
      'an unavailable unpinned legacy root is still unknown, not proof of an unrelated scope',
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('a retargeted pinned directory cannot become a verified legacy candidate through a separate grant', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'f322-retargeted-scope-'));
  try {
    const base = await realpath(temp);
    const root = join(base, 'repository');
    const selected = join(base, 'shared');
    const other = join(base, 'other-authorized-root');
    await Promise.all([root, other].map((path) => mkdir(path)));
    const run = promisify(execFile);
    await run('git', ['init', '-q', root]);
    await run(
      'git',
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'fixture'],
      { cwd: root },
    );
    await run('git', ['worktree', 'add', '--detach', selected, 'HEAD'], { cwd: root });
    const pinned = {
      id: durableIdForCanonicalRoot(selected),
      rootIdentity: durableIdForCanonicalRoot(selected),
      root: selected,
    };
    await rm(selected, { recursive: true });
    await symlink(other, selected);
    const prefix = createHash('sha256').update(root).digest('hex').slice(0, 6);
    const result = await resolveAuthorizedWorkspaceContentWorktree({
      worktreeId: `${prefix}_shared`,
      currentEntries: [],
      linkedEntries: [pinned, { id: 'other', root: other }],
      legacyRoots: [root, selected, other],
      listWorktrees,
    }).catch(() => null);
    assert.equal(result, null, 'a known changed candidate stays blocked, even if its replacement has another grant');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
