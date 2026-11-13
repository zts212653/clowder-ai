import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { ENV_VARS } from '../../dist/config/env-registry.js';
import {
  embeddingRecipeFingerprint,
  readEmbeddingDeployment,
} from '../../dist/domains/memory/embedding-generation-config.js';
import { openVectorGeneration } from '../../dist/domains/memory/open-vector-generation.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { getServiceManifest } from '../../dist/domains/services/service-manifest.js';
import { configRoutes } from '../../dist/routes/config.js';
import { buildLifecycleEnv } from '../../dist/routes/services-lifecycle-helpers.js';

test('retained G0 has a discoverable persistent Settings entry and survives the existing start environment without becoming the primary endpoint', async (t) => {
  const definition = ENV_VARS.find((x) => x.name === 'EMBED_G0_URL');
  assert.ok(definition);
  assert.equal(definition.runtimeEditable, true);
  assert.equal(definition.restartRequired, true);
  const manifest = getServiceManifest('embedding-model');
  assert.ok(manifest.envVars.includes('EMBED_G0_URL'));
  assert.ok(!manifest.endpointEnvVars.includes('EMBED_G0_URL'));
  const root = mkdtempSync(join(tmpdir(), 'retained-settings-')),
    file = join(root, '.env');
  writeFileSync(file, '');
  const before = process.env.EMBED_G0_URL;
  const ownerBefore = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = 'fixture-owner';
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = request.headers['x-test-operator'] ?? 'fixture-owner';
  });
  t.after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
    if (before === undefined) delete process.env.EMBED_G0_URL;
    else process.env.EMBED_G0_URL = before;
    if (ownerBefore === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = ownerBefore;
  });
  await app.register(configRoutes, { projectRoot: root, envFilePath: file, auditLog: { append: async () => {} } });
  const summary = await app.inject({ method: 'GET', url: '/api/config/env-summary' });
  assert.equal(summary.statusCode, 200);
  assert.match(summary.body, /EMBED_G0_URL/);
  const denied = await app.inject({
    method: 'PATCH',
    url: '/api/config/env',
    headers: { 'x-test-operator': 'other-member' },
    payload: { updates: [{ name: 'EMBED_G0_URL', value: 'http://127.0.0.1:49090' }] },
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(readFileSync(file, 'utf8'), '');
  const result = await app.inject({
    method: 'PATCH',
    url: '/api/config/env',
    payload: {
      updates: [{ name: 'EMBED_G0_URL', value: 'http://127.0.0.1:49091' }],
    },
  });
  assert.equal(result.statusCode, 200, result.body);
  assert.match(readFileSync(file, 'utf8'), /EMBED_G0_URL=.*49091/);
  const launch = buildLifecycleEnv(
    { EMBED_URL: 'http://127.0.0.1:49092', EMBED_G0_URL: 'http://127.0.0.1:49091' },
    'embedding-model',
    'fixture/model',
  );
  assert.equal(launch.ok, true);
  assert.equal(launch.env.EMBED_G0_URL, 'http://127.0.0.1:49091');
  assert.equal(launch.env.EMBED_URL, 'http://127.0.0.1:49092');
  assert.equal(
    buildLifecycleEnv({ EMBED_G0_URL: 'https://outside.example' }, 'embedding-model', 'fixture/model').ok,
    false,
  );
});

async function coldProcess(dbPath, configPath, primary) {
  const loadUrl = new URL('../../dist/domains/memory/MemoryEmbeddingLifecycle.js', import.meta.url).href;
  const storeUrl = new URL('../../dist/domains/memory/SqliteEvidenceStore.js', import.meta.url).href;
  const builderUrl = new URL('../../dist/domains/memory/IndexBuilder.js', import.meta.url).href;
  const code = `import { readFileSync } from 'node:fs';
    import { MemoryEmbeddingLifecycle } from ${JSON.stringify(loadUrl)};
    import { SqliteEvidenceStore } from ${JSON.stringify(storeUrl)};
    import { IndexBuilder } from ${JSON.stringify(builderUrl)};
    const [dbPath, configPath, primary] = process.argv.slice(1);
    const deployment = JSON.parse(readFileSync(configPath, 'utf8'));
    const store = new SqliteEvidenceStore(dbPath); await store.initialize();
    const lifecycle = new MemoryEmbeddingLifecycle(store, new IndexBuilder(store, '/unused'),
      { embedMode:'on', embedModel:'fixture-old', embedDim:4, embedUrl:primary, embedTimeoutMs:1000, maxModelMemMb:32 },
      { getDeployment:()=>deployment, requireLegacyConsumer:true });
    const result = await lifecycle.activate('on');
    console.log(JSON.stringify({ ...result, desired:deployment.activeId, effective:lifecycle.getGenerationStatus().effective,
      legacy:lifecycle.getLegacyConsumerService()?.getModelInfo(), primary:lifecycle.getService()?.getModelInfo() }));
    lifecycle.deactivate();store.close();`;
  const env = { ...process.env };
  delete env.EMBED_G0_URL;
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, dbPath, configPath, primary], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    const timeout = setTimeout(() => child.kill(), 12000);
    child.stdout.on('data', (x) => {
      stdout += x;
    });
    child.stderr.on('data', (x) => {
      stderr += x;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`cold fixture failed: ${stderr}`));
      else resolve(JSON.parse(stdout.trim().split('\n').at(-1)));
    });
  });
}

test('a fresh API lifecycle consumes the persisted G0 deployment endpoint and fails closed for missing, remote or mismatched G0', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'retained-cold-config-')),
    dbPath = join(root, 'evidence.sqlite'),
    path = join(root, 'deployment.json');
  const deployment = readEmbeddingDeployment();
  deployment.activeId = 'g1';
  deployment.generations.g1.runtime.maxModelMemMb = 32;
  deployment.generations.g1.recipe = { ...deployment.generations.g1.recipe, modelId: 'fixture-new', dim: 6 };
  const fingerprint = embeddingRecipeFingerprint(deployment.generations.g1.recipe);
  let oldModel = 'fixture-old',
    oldRequests = 0;
  const servers = [];
  async function listen(generation) {
    const server = createServer((request, response) => {
      assert.equal(request.url, '/health');
      if (generation === 'g0') oldRequests++;
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          status: 'ok',
          model: generation === 'g0' ? oldModel : 'fixture-new',
          dim: generation === 'g0' ? 4 : 6,
          generation_id: generation,
          ...(generation === 'g1' ? { representation_fingerprint: fingerprint } : {}),
        }),
      );
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    return `http://127.0.0.1:${server.address().port}`;
  }
  const oldUrl = await listen('g0'),
    primary = await listen('g1');
  t.after(async () => {
    await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
    rmSync(root, { recursive: true, force: true });
  });
  const store = new SqliteEvidenceStore(dbPath);
  await store.initialize();
  const g0 = { modelId: 'fixture-old', modelRev: '1', dim: 4, generationId: 'g0' };
  openVectorGeneration(store.getDb(), g0, { create: true }).vectorStore.initMeta(g0);
  const g1 = {
    modelId: 'fixture-new',
    modelRev: deployment.generations.g1.recipe.modelRevision,
    dim: 6,
    generationId: 'g1',
    representationFingerprint: fingerprint,
  };
  openVectorGeneration(store.getDb(), g1, { create: true }).vectorStore.initMeta(g1);
  store.getDb().prepare("INSERT INTO vector_generations VALUES('g1',?,'ready')").run(fingerprint);
  store.close();
  deployment.generations.g0.runtime.retainedEndpoint = oldUrl;
  writeFileSync(path, JSON.stringify(deployment));
  const success = await coldProcess(dbPath, path, primary);
  assert.equal(success.ok, true);
  assert.equal(success.effective, 'g1');
  assert.equal(success.legacy.modelId, 'fixture-old');
  assert.equal(success.legacy.generationId, 'g0');
  deployment.generations.g0.runtime.retainedEndpoint = null;
  writeFileSync(path, JSON.stringify(deployment));
  assert.equal((await coldProcess(dbPath, path, primary)).reason, 'legacy_provider_not_ready');
  deployment.generations.g0.runtime.retainedEndpoint = oldUrl;
  oldModel = 'wrong-package';
  writeFileSync(path, JSON.stringify(deployment));
  assert.equal((await coldProcess(dbPath, path, primary)).reason, 'legacy_provider_not_ready');
  deployment.generations.g0.runtime.retainedEndpoint = 'https://outside.example';
  writeFileSync(path, JSON.stringify(deployment));
  const requestsBefore = oldRequests;
  assert.equal((await coldProcess(dbPath, path, primary)).ok, false);
  assert.equal(oldRequests, requestsBefore);
});
