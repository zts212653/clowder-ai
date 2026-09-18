// F257: the Console segment list must follow the prompt pipeline's hook registry.
// A governance `add` approval writes a new hook directory and resets the pipeline
// singleton; the manifest route used to keep its own scan cache, so the new unit
// stayed invisible in the Console until a restart (D22, 2026-09-11).

import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const REAL_HOOKS = join(repoRoot, 'assets', 'prompt-hooks');
const REAL_TEMPLATES = join(repoRoot, 'assets', 'prompt-templates');
const SESSION_HEADERS = { 'x-test-session-user': 'test-user' };

async function buildApp(opts = {}) {
  const { promptInjectionManifestRoutes } = await import('../dist/routes/prompt-injection-manifest.js');
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (request) => {
    const sessionUser = request.headers['x-test-session-user'];
    if (typeof sessionUser === 'string' && sessionUser.trim()) request.sessionUserId = sessionUser.trim();
  });
  await app.register(promptInjectionManifestRoutes, opts);
  await app.ready();
  return app;
}

async function segmentIds(app) {
  const res = await app.inject({ method: 'GET', url: '/api/prompt-injection/manifest', headers: SESSION_HEADERS });
  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
  return JSON.parse(res.body).segments.map((segment) => segment.id);
}

describe('prompt-injection manifest route: registry freshness', () => {
  const tempRoots = [];
  after(async () => {
    for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
    const { resetPipelineSingleton } = await import('../dist/domains/prompt-hooks/PipelinePromptBuilder.js');
    resetPipelineSingleton();
  });

  test('renders the registry it is handed on every request instead of a private scan cache', async () => {
    const { HookRegistry } = await import('../dist/domains/prompt-hooks/HookRegistry.js');
    const root = mkdtempSync(join(tmpdir(), 'f257-manifest-'));
    tempRoots.push(root);
    const hooksDir = join(root, 'prompt-hooks');
    cpSync(join(REAL_HOOKS, 'd1-身份锚定'), join(hooksDir, 'd1-身份锚定'), { recursive: true });

    let current = new HookRegistry(hooksDir, REAL_TEMPLATES);
    current.scan();
    const app = await buildApp({ getRegistry: () => current });

    const before = await segmentIds(app);
    assert.ok(before.includes('D1'), 'the seeded hook is listed');
    assert.ok(!before.includes('D10'), 'a unit that does not exist yet is not listed');

    // A governance `add` lands a new hook directory and the pipeline rebuilds its registry.
    cpSync(join(REAL_HOOKS, 'd10-批评标签'), join(hooksDir, 'd10-批评标签'), { recursive: true });
    current = new HookRegistry(hooksDir, REAL_TEMPLATES);
    current.scan();

    const after = await segmentIds(app);
    assert.ok(after.includes('D10'), 'the newly added unit is listed without a restart');
    assert.equal(after.length, before.length + 1, 'exactly the new unit was added');
    await app.close();
  });

  test('defaults to the prompt pipeline singleton, so a pipeline reload is a Console reload', async () => {
    const { getCachedRegistry, resetPipelineSingleton } = await import(
      '../dist/domains/prompt-hooks/PipelinePromptBuilder.js'
    );
    resetPipelineSingleton();
    assert.equal(getCachedRegistry(), null, 'precondition: no pipeline registry yet');

    const app = await buildApp();
    const ids = await segmentIds(app);
    assert.ok(ids.includes('S13'), 'real repository hooks are listed');
    const first = getCachedRegistry();
    assert.ok(first, 'the route materialised the shared pipeline registry, not a private one');

    resetPipelineSingleton();
    await segmentIds(app);
    const second = getCachedRegistry();
    assert.ok(second, 'the route re-materialised the registry after a reload');
    assert.notEqual(second, first, 'a reload is observed: the route serves from the rebuilt registry');
    await app.close();
  });
});
