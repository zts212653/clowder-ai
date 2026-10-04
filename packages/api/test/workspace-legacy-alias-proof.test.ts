import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import Fastify from 'fastify';
import { EventAuditLog } from '../src/domains/cats/services/orchestration/EventAuditLog.js';
import { listWorktrees, registerWorktrees } from '../src/domains/workspace/workspace-security.js';
import { resolveAuthorizedWorkspaceContentWorktree } from '../src/domains/workspace/workspace-worktree-identity.js';
import { workspaceRoutes } from '../src/routes/workspace.js';

const run = promisify(execFile);

test('a directory alias named like a complete root identity cannot override that identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'f309-reserved-root-id-'));
  try {
    const a = await realpath(root);
    const id = `f063_root_v1_${createHash('sha256').update(a).digest('hex')}`;
    const b = join(root, id);
    await mkdir(b);
    const result = await resolveAuthorizedWorkspaceContentWorktree({
      worktreeId: id,
      currentEntries: [{ id, root: b }],
      linkedEntries: [],
      legacyRoots: [],
      listWorktrees: async () => [],
    });
    assert.equal(result, null, 'the authorized alias points to B; it does not authorize the full identity of A');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
function collision(root: string): [string, string, string] {
  const seen = new Map<string, string>();
  for (let index = 0; index < 100_000; index++) {
    const candidate = join(root, `scope-${index}`);
    const prefix = createHash('sha256').update(candidate).digest('hex').slice(0, 6);
    const prior = seen.get(prefix);
    if (prior) return [prior, candidate, prefix];
    seen.set(prefix, candidate);
  }
  throw new Error('No collision found within fixture bound');
}

test('a real 24-bit scope collision cannot become a unique legacy grant when the other worktree fails realpath', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'f309-scope-collision-'));
  try {
    const [a, b, prefix] = collision(await realpath(temp));
    for (const path of [a, b]) {
      await mkdir(path);
      await run('git', ['init', '-q', path]);
      await run(
        'git',
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.test',
          'commit',
          '--allow-empty',
          '-qm',
          'fixture',
        ],
        { cwd: path },
      );
      await run('git', ['worktree', 'add', '--detach', join(path, 'shared'), 'HEAD'], { cwd: path });
    }
    const currentEntries = await listWorktrees(a);
    const linkedEntries = (await listWorktrees(b)).map((entry) => ({ ...entry, id: `linked_${basename(entry.root)}` }));
    const lookup = (worktreeId: string) =>
      resolveAuthorizedWorkspaceContentWorktree({
        worktreeId,
        currentEntries,
        linkedEntries,
        legacyRoots: [a, b],
        listWorktrees,
      });
    const legacyId = `${prefix}_shared`;
    assert.equal(await lookup(legacyId), null, 'two fully readable candidates are ambiguous');
    await assert.rejects(
      resolveAuthorizedWorkspaceContentWorktree({
        worktreeId: legacyId,
        currentEntries,
        linkedEntries,
        legacyRoots: [a, b],
        listWorktrees: async (root) => {
          if (root === b) throw new Error('fixture Git enumeration unavailable');
          return listWorktrees(root);
        },
      }),
      /enumeration unavailable/,
      'a failed matching scope probe must not be treated as no candidate',
    );
    await rm(join(b, 'shared'), { recursive: true });
    await symlink('shared', join(b, 'shared'));
    await assert.rejects(realpath(join(b, 'shared')), (error: NodeJS.ErrnoException) => error.code === 'ELOOP');
    assert.equal(await lookup(legacyId), null, 'an unreadable colliding candidate is not evidence of absence');
    const strong = `f063_root_v1_${createHash('sha256').update(join(a, 'shared')).digest('hex')}`;
    assert.equal(
      (await lookup(strong))?.root,
      join(a, 'shared'),
      'the full root identity does not inherit weak-alias ambiguity',
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('a warmed mutable registry entry cannot supply the missing source proof for canonical file navigation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'f309-registry-source-'));
  const prior = process.env.WORKSPACE_LINKED_ROOTS;
  const app = Fastify();
  try {
    await writeFile(join(root, 'notes.txt'), 'registered bytes are not proof of an opaque entrance alias');
    process.env.WORKSPACE_LINKED_ROOTS = `f309_proved:${root}`;
    const alias = `unproven_${basename(root)}`;
    registerWorktrees([{ id: alias, root, branch: 'main', head: 'fixture' }]);
    await app.register(workspaceRoutes, { auditLog: new EventAuditLog({ auditDir: join(root, 'audit') }) });
    const response = await app.inject({
      method: 'POST',
      url: '/api/workspace/resolve-file-source',
      headers: { 'x-cat-cafe-user': 'operator' },
      payload: { worktreeId: alias, path: 'notes.txt' },
    });
    assert.equal(response.statusCode, 404, response.body);
  } finally {
    if (prior === undefined) delete process.env.WORKSPACE_LINKED_ROOTS;
    else process.env.WORKSPACE_LINKED_ROOTS = prior;
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
