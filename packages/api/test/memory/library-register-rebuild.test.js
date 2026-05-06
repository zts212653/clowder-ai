import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

describe('library register + rebuild endpoints', () => {
  let Fastify, libraryRoutes, LibraryCatalog;
  let catalog, stores, dataDir, app;

  beforeEach(async () => {
    Fastify = (await import('fastify')).default;
    ({ libraryRoutes } = await import('../../dist/routes/library.js'));
    ({ LibraryCatalog } = await import('../../dist/domains/memory/LibraryCatalog.js'));
    catalog = new LibraryCatalog();
    stores = new Map();
    dataDir = mkdtempSync(join(tmpdir(), 'lib-api-'));
    app = Fastify();
    await app.register(libraryRoutes, { catalog, stores, dataDir });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('POST /register creates a new collection', async () => {
    const contentDir = mkdtempSync(join(tmpdir(), 'col-'));
    writeFileSync(join(contentDir, 'doc.md'), '# Test Doc\n\nSome content.');
    const res = await app.inject({
      method: 'POST',
      url: '/api/library/register',
      payload: {
        id: 'world:pilot',
        kind: 'world',
        name: 'pilot',
        displayName: 'Pilot World',
        root: contentDir,
        sensitivity: 'internal',
        scannerLevel: 0,
      },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.manifest.id, 'world:pilot');
    assert.ok(catalog.get('world:pilot'));
    assert.ok(stores.has('world:pilot'));
  });

  it('POST /register rejects duplicate id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dup-'));
    const payload = {
      id: 'world:dup',
      kind: 'world',
      name: 'dup',
      displayName: 'Dup',
      root: dir,
      sensitivity: 'internal',
      scannerLevel: 0,
    };
    await app.inject({ method: 'POST', url: '/api/library/register', payload });
    const res = await app.inject({ method: 'POST', url: '/api/library/register', payload });
    assert.equal(res.statusCode, 409);
  });

  it('POST /register rejects non-existent root', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/library/register',
      payload: {
        id: 'world:bad',
        kind: 'world',
        name: 'bad',
        displayName: 'Bad',
        root: '/no/such/path',
        sensitivity: 'internal',
        scannerLevel: 0,
      },
    });
    assert.equal(res.statusCode, 400);
  });

  it('POST /rebuild indexes collection content', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rebuild-'));
    writeFileSync(join(dir, 'a.md'), '# Alpha\n\nAlpha content.');
    writeFileSync(join(dir, 'b.md'), '---\ndoc_kind: decision\n---\n# Beta\n\nBeta content.');
    await app.inject({
      method: 'POST',
      url: '/api/library/register',
      payload: {
        id: 'domain:rebuild',
        kind: 'domain',
        name: 'rebuild',
        displayName: 'Rebuild',
        root: dir,
        sensitivity: 'internal',
        scannerLevel: 1,
      },
    });
    const res = await app.inject({ method: 'POST', url: '/api/library/domain:rebuild/rebuild' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.indexed, 2);
  });

  it('POST /rebuild returns 404 for unknown collection', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/library/world:unknown/rebuild' });
    assert.equal(res.statusCode, 404);
  });

  it('POST /register rejects invalid kind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kind-'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/library/register',
      payload: {
        id: 'banana:test',
        kind: 'banana',
        name: 'test',
        displayName: 'Test',
        root: dir,
        sensitivity: 'internal',
        scannerLevel: 0,
      },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(JSON.parse(res.body).error.includes('kind'));
  });

  it('POST /register rejects invalid sensitivity', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sens-'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/library/register',
      payload: {
        id: 'world:test',
        kind: 'world',
        name: 'test',
        displayName: 'Test',
        root: dir,
        sensitivity: 'banana',
        scannerLevel: 0,
      },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(JSON.parse(res.body).error.includes('sensitivity'));
  });

  it('POST /register rejects invalid scannerLevel', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scan-'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/library/register',
      payload: {
        id: 'world:test',
        kind: 'world',
        name: 'test',
        displayName: 'Test',
        root: dir,
        sensitivity: 'internal',
        scannerLevel: 99,
      },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(JSON.parse(res.body).error.includes('scannerLevel'));
  });

  it('POST /register rejects root that is a file, not directory', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'file-')), 'not-a-dir.txt');
    writeFileSync(file, 'hello');
    const res = await app.inject({
      method: 'POST',
      url: '/api/library/register',
      payload: {
        id: 'world:test',
        kind: 'world',
        name: 'test',
        displayName: 'Test',
        root: file,
        sensitivity: 'internal',
        scannerLevel: 0,
      },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(JSON.parse(res.body).error.includes('directory'));
  });

  it('POST /register rejects id-kind mismatch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mismatch-'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/library/register',
      payload: {
        id: 'world:test',
        kind: 'domain',
        name: 'test',
        displayName: 'Test',
        root: dir,
        sensitivity: 'internal',
        scannerLevel: 0,
      },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(JSON.parse(res.body).error.includes('kind'));
  });

  it('POST /register rejects malformed id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'malformed-'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/library/register',
      payload: {
        id: 'INVALID',
        kind: 'world',
        name: 'test',
        displayName: 'Test',
        root: dir,
        sensitivity: 'internal',
        scannerLevel: 0,
      },
    });
    assert.equal(res.statusCode, 400);
  });

  it('POST /register rejects non-localhost request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'remote-'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/library/register',
      remoteAddress: '192.168.1.100',
      payload: {
        id: 'world:remote',
        kind: 'world',
        name: 'remote',
        displayName: 'Remote',
        root: dir,
        sensitivity: 'internal',
        scannerLevel: 0,
      },
    });
    assert.equal(res.statusCode, 403);
  });

  it('POST /rebuild rejects non-localhost request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rbguard-'));
    writeFileSync(join(dir, 'a.md'), '# A');
    await app.inject({
      method: 'POST',
      url: '/api/library/register',
      payload: {
        id: 'world:rbguard',
        kind: 'world',
        name: 'rbguard',
        displayName: 'RbGuard',
        root: dir,
        sensitivity: 'internal',
        scannerLevel: 1,
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/library/world:rbguard/rebuild',
      remoteAddress: '192.168.1.100',
    });
    assert.equal(res.statusCode, 403);
  });

  it('POST /register persists to collections.json with dataDir', async () => {
    const contentDir = mkdtempSync(join(tmpdir(), 'persist-'));
    writeFileSync(join(contentDir, 'doc.md'), '# Test');
    await app.inject({
      method: 'POST',
      url: '/api/library/register',
      payload: {
        id: 'world:persist',
        kind: 'world',
        name: 'persist',
        displayName: 'Persist Test',
        root: contentDir,
        sensitivity: 'internal',
        scannerLevel: 0,
      },
    });
    const saved = JSON.parse(readFileSync(join(dataDir, 'library', 'collections.json'), 'utf-8'));
    assert.equal(saved.length, 1);
    assert.equal(saved[0].id, 'world:persist');
  });

  it('GET /documents returns documents grouped by kind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'docs-'));
    writeFileSync(join(dir, 'alpha.md'), '# Alpha\n\nAlpha content.');
    writeFileSync(join(dir, 'beta.md'), '---\ndoc_kind: decision\n---\n# Beta\n\nBeta decision.');
    writeFileSync(join(dir, 'gamma.md'), '---\ndoc_kind: decision\n---\n# Gamma\n\nGamma decision.');
    writeFileSync(join(dir, 'delta.md'), '# Delta\n\nDelta content.');
    await app.inject({
      method: 'POST',
      url: '/api/library/register',
      payload: {
        id: 'domain:docs',
        kind: 'domain',
        name: 'docs',
        displayName: 'Docs Test',
        root: dir,
        sensitivity: 'internal',
        scannerLevel: 1,
      },
    });
    await app.inject({ method: 'POST', url: '/api/library/domain:docs/rebuild' });

    const res = await app.inject({ method: 'GET', url: '/api/library/domain:docs/documents' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.collectionId, 'domain:docs');
    assert.ok(Array.isArray(body.groups));
    assert.ok(body.groups.length >= 2, 'should have at least 2 kind groups');

    const decisionGroup = body.groups.find((g) => g.kind === 'decision');
    assert.ok(decisionGroup, 'should have a decision group');
    assert.equal(decisionGroup.count, 2);
    assert.equal(decisionGroup.documents.length, 2);
    assert.equal(decisionGroup.hasMore, false);
    for (const doc of decisionGroup.documents) {
      assert.ok(doc.anchor);
      assert.ok(doc.title);
    }

    const totalDocs = body.groups.reduce((sum, g) => sum + g.count, 0);
    assert.equal(totalDocs, 4);
  });

  it('GET /documents truncates groups to default limit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trunc-'));
    for (let i = 0; i < 25; i++) {
      writeFileSync(join(dir, `doc-${String(i).padStart(2, '0')}.md`), `# Doc ${i}\n\nContent ${i}.`);
    }
    await app.inject({
      method: 'POST',
      url: '/api/library/register',
      payload: {
        id: 'domain:trunc',
        kind: 'domain',
        name: 'trunc',
        displayName: 'Truncation Test',
        root: dir,
        sensitivity: 'internal',
        scannerLevel: 1,
      },
    });
    await app.inject({ method: 'POST', url: '/api/library/domain:trunc/rebuild' });

    const res = await app.inject({ method: 'GET', url: '/api/library/domain:trunc/documents' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const group = body.groups[0];
    assert.equal(group.count, 25, 'total count should be 25');
    assert.equal(group.documents.length, 20, 'documents should be truncated to 20');
    assert.equal(group.hasMore, true);
  });

  it('GET /documents returns 404 for unknown collection', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/library/world:nope/documents' });
    assert.equal(res.statusCode, 404);
  });

  it('GET /documents returns 200 for private collection (owner view)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'priv-'));
    writeFileSync(join(dir, 'a.md'), '# A');
    await app.inject({
      method: 'POST',
      url: '/api/library/register',
      payload: {
        id: 'domain:priv',
        kind: 'domain',
        name: 'priv',
        displayName: 'Private',
        root: dir,
        sensitivity: 'private',
        scannerLevel: 0,
      },
    });
    const res = await app.inject({ method: 'GET', url: '/api/library/domain:priv/documents' });
    assert.equal(res.statusCode, 200);
  });
});
