import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { EventAuditLog } from '../src/domains/cats/services/orchestration/EventAuditLog.js';
import { resolveCurrentWorkspaceContentRoot } from '../src/domains/workspace/roots/workspace-content-root-resolution.js';
import { getLinkedRootsAsync, listWorktrees } from '../src/domains/workspace/workspace-security.js';
import { workspaceRoutes } from '../src/routes/workspace.js';

test('two normalized env aliases remain ambiguous when one realpath fails with ELOOP', async () => {
  const root = await mkdtemp(join(tmpdir(), 'f309-root-ambiguity-'));
  const prior = process.env.WORKSPACE_LINKED_ROOTS;
  try {
    await symlink('loop', join(root, 'loop'));
    process.env.WORKSPACE_LINKED_ROOTS = `f309.same:${root},f309_same:${join(root, 'loop')}`;
    const entries = (await getLinkedRootsAsync()).filter((entry) => entry.id === 'linked_f309_same');
    assert.equal(entries.length, 2, 'env roots preserve normalized-id collisions in the actual owner inventory');
    await assert.rejects(realpath(entries[1]!.root), (error: NodeJS.ErrnoException) => error.code === 'ELOOP');
    const resolved = await resolveCurrentWorkspaceContentRoot('linked_f309_same', listWorktrees, getLinkedRootsAsync);
    assert.equal(resolved, null, 'an unreadable possible match cannot create uniqueness');
  } finally {
    if (prior === undefined) delete process.env.WORKSPACE_LINKED_ROOTS;
    else process.env.WORKSPACE_LINKED_ROOTS = prior;
    await rm(root, { recursive: true, force: true });
  }
});

test('the location catalogue canonicalizes aliases and retains failed entries as visibly unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'f309-root-catalogue-'));
  const prior = process.env.WORKSPACE_LINKED_ROOTS;
  const app = Fastify();
  try {
    await writeFile(join(root, 'notes.txt'), 'current file');
    await symlink(root, join(root, 'alias'));
    await symlink('loop', join(root, 'loop'));
    process.env.WORKSPACE_LINKED_ROOTS = `f309_a:${root},f309_b:${join(root, 'alias')},f309_failed:${join(root, 'loop')}`;
    await app.register(workspaceRoutes, { auditLog: new EventAuditLog({ auditDir: join(root, 'audit') }) });
    const headers = { 'x-cat-cafe-user': 'operator' };
    const result = await app.inject({ method: 'GET', url: '/api/workspace/file-locations', headers });
    assert.equal(result.statusCode, 200, result.body);
    const locations: Array<{ root: string; status: string }> = result.json().locations;
    const canonical = await realpath(root);
    assert.equal(locations.filter((entry) => entry.status === 'available' && entry.root === canonical).length, 1);
    assert.equal(locations.filter((entry) => entry.root === join(root, 'alias')).length, 0);
    assert.equal(locations.find((entry) => entry.root === join(root, 'loop'))?.status, 'unavailable');
    assert.equal(result.json().inventory, 'partial');
    const selected = await app.inject({
      method: 'POST',
      url: '/api/workspace/resolve-file-source',
      headers,
      payload: { root: canonical, path: 'notes.txt' },
    });
    assert.equal(selected.statusCode, 200, selected.body);
  } finally {
    if (prior === undefined) delete process.env.WORKSPACE_LINKED_ROOTS;
    else process.env.WORKSPACE_LINKED_ROOTS = prior;
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
