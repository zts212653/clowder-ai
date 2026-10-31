import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { LibraryCatalog } from '../dist/domains/memory/LibraryCatalog.js';
import { libraryRoutes } from '../dist/routes/library.js';

test('real MCP lifecycle writers reach owner-configured library routes without browser cookies', async () => {
  const root = mkdtempSync(join(tmpdir(), 'f321-mcp-library-'));
  const content = join(root, 'content');
  mkdirSync(content);
  writeFileSync(join(content, 'doc.md'), '# Library integration\n\nSafe document.');
  const catalog = new LibraryCatalog();
  const stores = new Map();
  const app = Fastify();
  const previous = { api: process.env.CAT_CAFE_API_URL, user: process.env.CAT_CAFE_USER_ID };
  try {
    await app.register(libraryRoutes, { catalog, stores, dataDir: root, privateOwnerUserId: 'owner' });
    await app.listen({ host: '127.0.0.1', port: 0 });
    process.env.CAT_CAFE_API_URL = app.listeningOrigin;
    process.env.CAT_CAFE_USER_ID = 'owner';
    const tools = await import('../../mcp-server/dist/tools/library-lifecycle-tools.js');
    const dry = await tools.handleLibraryDryRun({ root: content });
    assert.notEqual(dry.isError, true, JSON.stringify(dry));
    const created = await tools.handleLibraryCreate({
      kind: 'domain',
      name: 'mcp-test',
      displayName: 'MCP test',
      root: content,
      sensitivity: 'private',
    });
    assert.notEqual(created.isError, true, JSON.stringify(created));
    assert.doesNotMatch(created.content[0].text, /rebuild failed/);
    assert.equal(catalog.get('domain:mcp-test').ownerUserId, 'owner');
    assert.equal(catalog.get('domain:mcp-test').status, 'active');
    const listed = await tools.handleLibraryList({});
    assert.match(listed.content[0].text, /domain:mcp-test/);
    const rebuilt = await tools.handleLibraryRebuild({ collectionId: 'domain:mcp-test' });
    assert.notEqual(rebuilt.isError, true, JSON.stringify(rebuilt));
    const archived = await tools.handleLibraryArchive({ collectionId: 'domain:mcp-test' });
    assert.notEqual(archived.isError, true, JSON.stringify(archived));
    assert.equal(catalog.get('domain:mcp-test').status, 'archived');
  } finally {
    for (const [key, value] of [
      ['CAT_CAFE_API_URL', previous.api],
      ['CAT_CAFE_USER_ID', previous.user],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await app.close();
    for (const store of stores.values()) store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('library local writer accepts only direct owner principals; browser headers and proxies cannot impersonate them', async () => {
  const app = Fastify();
  app.addHook('onRequest', async (req) => {
    req.sessionUserId = req.headers['x-test-session'];
  });
  await app.register(libraryRoutes, { catalog: new LibraryCatalog(), stores: new Map(), privateOwnerUserId: 'owner' });
  try {
    for (const action of ['rebuild', 'archive', 'unarchive']) {
      const url = `/api/library/domain:missing/${action}`;
      const inject = (headers = {}, remoteAddress = '127.0.0.1') =>
        app.inject({ method: 'POST', url, headers, remoteAddress });
      assert.equal((await inject()).statusCode, 401);
      assert.equal((await inject({ 'x-cat-cafe-user': 'owner' })).statusCode, 404, action);
      assert.equal((await inject({ 'x-cat-cafe-user': 'other' })).statusCode, 403);
      assert.equal((await inject({ 'x-cat-cafe-user': 'owner', origin: 'http://localhost:3003' })).statusCode, 401);
      assert.equal((await inject({ 'x-test-session': 'owner', origin: 'http://localhost:3003' })).statusCode, 404);
      for (const headers of [
        { 'x-cat-cafe-user': 'owner', 'x-forwarded-for': '10.0.0.2' },
        { 'x-test-session': 'owner', forwarded: 'for=10.0.0.2' },
      ])
        assert.equal((await inject(headers)).statusCode, 403);
      assert.equal((await inject({ 'x-test-session': 'owner' }, '192.168.1.10')).statusCode, 403);
    }
  } finally {
    await app.close();
  }
});
