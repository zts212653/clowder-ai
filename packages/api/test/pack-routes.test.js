/**
 * F129 Pack Routes Tests — POST/GET/DELETE /api/packs
 * Tests the Fastify route layer with real PackLoader/PackStore/PackSecurityGuard.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import Fastify from 'fastify';

const FIXTURES = join(import.meta.dirname, '__fixtures__');
const VALID_PACK = join(FIXTURES, 'valid-packs', 'quant-cats');
const MALICIOUS_INJECTION = join(FIXTURES, 'malicious-packs', 'prompt-injection');

// ─── Helpers ─────────────────────────────────────────────────────────

const tmpDirs = [];

async function createTmpDir() {
  const dir = await mkdtemp(join(tmpdir(), 'pack-route-'));
  tmpDirs.push(dir);
  return dir;
}

async function buildApp() {
  const { PackStore } = await import('../dist/domains/packs/PackStore.js');
  const { PackSecurityGuard } = await import('../dist/domains/packs/PackSecurityGuard.js');
  const { PackLoader } = await import('../dist/domains/packs/PackLoader.js');
  const { packsRoutes } = await import('../dist/routes/packs.js');

  const storeDir = await createTmpDir();
  const store = new PackStore(storeDir);
  const guard = new PackSecurityGuard();
  const loader = new PackLoader(store, guard);

  const app = Fastify();
  await app.register(packsRoutes, { packLoader: loader });
  await app.ready();
  return app;
}

afterEach(async () => {
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

// ═══════════════════════════════════════════════════════════════════════

describe('Pack Routes', () => {
  test('POST /api/packs/add with local path installs pack', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/packs/add',
      payload: { source: VALID_PACK },
    });

    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body);
    assert.ok(body.ok);
    assert.equal(body.manifest.name, 'quant-cats');
  });

  test('GET /api/packs returns installed packs', async () => {
    const app = await buildApp();

    // Install first
    await app.inject({
      method: 'POST',
      url: '/api/packs/add',
      payload: { source: VALID_PACK },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/packs',
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.packs.length, 1);
    assert.equal(body.packs[0].name, 'quant-cats');
  });

  test('DELETE /api/packs/:name removes pack', async () => {
    const app = await buildApp();

    // Install first
    await app.inject({
      method: 'POST',
      url: '/api/packs/add',
      payload: { source: VALID_PACK },
    });

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/packs/quant-cats',
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.removed);

    // Verify gone
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/packs',
    });
    const listBody = JSON.parse(listRes.body);
    assert.equal(listBody.packs.length, 0);
  });

  test('POST /api/packs/add rejects malicious pack', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/packs/add',
      payload: { source: MALICIOUS_INJECTION },
    });

    assert.ok(res.statusCode >= 400, `Expected 4xx, got ${res.statusCode}`);
    const body = JSON.parse(res.body);
    assert.ok(!body.ok);
  });

  test('POST /api/packs/add rejects missing source', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/packs/add',
      payload: {},
    });

    assert.equal(res.statusCode, 400);
  });

  test('GET /api/packs returns empty array when no packs installed', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: '/api/packs',
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(body.packs, []);
  });

  test('DELETE /api/packs/:name returns removed=false for non-existent', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/packs/ghost',
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.removed, false);
  });
});
