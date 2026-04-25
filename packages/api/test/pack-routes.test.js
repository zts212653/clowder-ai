/**
 * F129 Pack Routes Tests — POST/GET/DELETE /api/packs
 * Tests the Fastify route layer with real PackLoader/PackStore/PackSecurityGuard.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

async function buildApp(opts = {}) {
  const { PackStore } = await import('../dist/domains/packs/PackStore.js');
  const { PackSecurityGuard } = await import('../dist/domains/packs/PackSecurityGuard.js');
  const { PackLoader } = await import('../dist/domains/packs/PackLoader.js');
  const { packsRoutes } = await import('../dist/routes/packs.js');

  const storeDir = await createTmpDir();
  const store = new PackStore(storeDir);
  const guard = new PackSecurityGuard();
  const loader = new PackLoader(store, guard);

  const app = Fastify();
  await app.register(packsRoutes, { packLoader: loader, ...opts });
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

  // ─── Export Endpoint (Phase B-α) ──────────────────────────────────

  test('POST /api/packs/export creates pack from body data', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/packs/export',
      payload: {
        name: 'test-export',
        catConfig: {
          roster: {
            opus: { family: 'ragdoll', roles: ['architect'], available: true },
          },
          breeds: [
            {
              id: 'ragdoll',
              catId: 'opus',
              displayName: 'Ragdoll',
              defaultVariantId: 'v1',
              variants: [{ id: 'v1', roleDescription: 'Architect', strengths: ['design'] }],
            },
          ],
        },
        sharedRulesContent: '## 铁律\n\n### 铁律 1: Test Rule\nDo not break things.',
        skillsManifestContent:
          'skills:\n  test-skill:\n    description: Test\n    triggers: ["test"]\n    sop_step: 1\n',
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.ok);
    assert.equal(body.manifest.name, 'test-export');
    assert.equal(body.manifest.packType, 'domain');
    assert.ok(Array.isArray(body.warnings));
  });

  test('POST /api/packs/export returns 400 for catConfig missing roster/breeds (R2 P1)', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/packs/export',
      payload: {
        catConfig: {},
        sharedRulesContent: '## 铁律\n### 铁律 1: test\nrule',
        skillsManifestContent: 'skills:\n  s:\n    sop_step: 1\n',
      },
    });
    assert.ok(res.statusCode >= 400 && res.statusCode < 500, `Expected 4xx, got ${res.statusCode}`);
  });

  test('POST /api/packs/export handles breeds with missing variants gracefully (R3 P1)', async () => {
    const app = await buildApp();
    // breeds[{id:'x'}] without catId/variants: roster lookup returns undefined → breed skipped
    // Exporter returns empty masks but valid pack → 200 with warnings
    const res = await app.inject({
      method: 'POST',
      url: '/api/packs/export',
      payload: {
        catConfig: { roster: { x: { available: true } }, breeds: [{ id: 'x' }] },
        sharedRulesContent: '## 铁律\n### 铁律 1: test\nrule',
        skillsManifestContent: 'skills:\n  s:\n    sop_step: 1\n',
      },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.ok);
    // Should warn about empty masks (no breeds matched)
    assert.ok(body.warnings.some((w) => w.includes('No masks')));
  });

  test('POST /api/packs/export returns 400 when no data provided and no file paths', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/packs/export',
      payload: {},
    });

    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.error);
  });

  test('POST /api/packs/export falls back to cat-template.json when body omits catConfig', async () => {
    const catTemplatePath = join(await createTmpDir(), 'cat-template.json');
    const sharedRulesPath = join(await createTmpDir(), 'shared-rules.md');
    const skillsManifestPath = join(await createTmpDir(), 'manifest.yaml');

    await writeFile(
      catTemplatePath,
      JSON.stringify({
        roster: {
          opus: { family: 'ragdoll', roles: ['architect'], available: true },
        },
        breeds: [
          {
            id: 'ragdoll',
            catId: 'opus',
            displayName: 'Ragdoll',
            defaultVariantId: 'v1',
            variants: [{ id: 'v1', roleDescription: 'Architect', strengths: ['design'] }],
          },
        ],
      }),
      'utf-8',
    );
    await writeFile(sharedRulesPath, '## 铁律\n\n### 铁律 1: Test Rule\nDo not break things.\n', 'utf-8');
    await writeFile(
      skillsManifestPath,
      'skills:\n  test-skill:\n    description: Test\n    triggers: ["test"]\n    sop_step: 1\n',
      'utf-8',
    );

    const app = await buildApp({ catTemplatePath, sharedRulesPath, skillsManifestPath });
    const res = await app.inject({
      method: 'POST',
      url: '/api/packs/export',
      payload: { name: 'template-fallback-export' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.ok);

    assert.equal(body.manifest.name, 'template-fallback-export');
  });
});
