import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import Fastify from 'fastify';

const { workspaceRoutes } = await import('../dist/routes/workspace.js');

const LINKED_NAME = 'search-fixture';
const WORKTREE_ID = 'linked_search-fixture';

async function buildApp() {
  const app = Fastify();
  await app.register(workspaceRoutes);
  await app.ready();
  return app;
}

describe('POST /api/workspace/search', () => {
  let testDir;
  let app;
  let previousLinkedRoots;

  before(async () => {
    testDir = mkdtempSync('/tmp/cat-cafe-workspace-search-');
    mkdirSync(join(testDir, 'docs'), { recursive: true });
    writeFileSync(join(testDir, 'docs', 'exact-match.md'), '# README-A2A-SEARCH\n', 'utf8');
    writeFileSync(join(testDir, 'docs', 'notes.txt'), '猫在 txt 文档里\n', 'utf8');
    writeFileSync(join(testDir, 'docs', 'huge.md'), '猫 命中\n'.repeat(700000), 'utf8');

    previousLinkedRoots = process.env.WORKSPACE_LINKED_ROOTS;
    process.env.WORKSPACE_LINKED_ROOTS = `${LINKED_NAME}:${testDir}`;
    app = await buildApp();
  });

  after(async () => {
    if (previousLinkedRoots == null) delete process.env.WORKSPACE_LINKED_ROOTS;
    else process.env.WORKSPACE_LINKED_ROOTS = previousLinkedRoots;
    await app?.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns content results for high-volume matches instead of silently swallowing them', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/search',
      payload: { worktreeId: WORKTREE_ID, query: '猫', type: 'content', limit: 10 },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.totalMatches > 0);
    assert.ok(body.results.some((result) => result.path === 'docs/huge.md'));
  });

  it('searches plain-text docs such as .txt files', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/search',
      payload: { worktreeId: WORKTREE_ID, query: 'txt 文档', type: 'content', limit: 10 },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.results.some((result) => result.path === 'docs/notes.txt'));
  });
});
