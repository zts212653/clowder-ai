import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { catRegistry } from '@cat-cafe/shared';
import { getAcpConfig, loadResolvedCatConfig, toAllCatConfigs } from '../dist/config/cat-config-loader.js';
import { registerCatalogSnapshot } from '../dist/config/cat-registry-reconciliation.js';
import { createAcpServiceForConfig } from '../dist/domains/cats/services/agents/providers/acp/AcpServiceFactory.js';
import { catsRoutes } from '../dist/routes/cats.js';

test('PR1762: persisted ACP member creation, real subprocess, two turns and member isolation', { timeout: 60000 }, async (t) => {
  const evidence = resolve('artifacts/pr1762-windows-creation');
  mkdirSync(evidence, { recursive: true });
  const root = mkdtempSync(join(evidence, 'case-'));
  const template = join(root, 'cat-template.json');
  copyFileSync(fileURLToPath(new URL('../../../cat-template.json', import.meta.url)), template);
  mkdirSync(join(root, '.cat-cafe'));
  writeFileSync(join(root, '.cat-cafe/cat-catalog.json'), readFileSync(template));
  process.env.CAT_TEMPLATE_PATH = template;
  process.env.CAT_CAFE_CONFIG_ROOT = root;
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
  const app = Fastify();
  t.after(() => app.close());
  await app.register(catsRoutes, { projectRoot: root });
  const pools = new Map();
  const services = [];
  t.after(async () => {
    await Promise.all(services.map((service) => service.disposeHostService()));
    await Promise.all([...pools.values()].map((pool) => pool.closeAll()));
  });
  const fixture = fileURLToPath(new URL('./fixtures/bundled-acp-agent.mjs', import.meta.url));
  const results = [];
  for (const [index, model] of ['', '', 'fixture-model'].entries()) {
    const id = `audit-acp-${index}`;
    const response = await app.inject({
      method: 'POST', url: '/api/cats', headers: { 'x-cat-cafe-user': 'audit-owner' },
      payload: {
        catId: id, name: 'Audit ACP', displayName: `Audit ${index}`,
        color: { primary: '#123456', secondary: '#abcdef' }, mentionPatterns: [`@${id}`],
        roleDescription: 'Isolated protocol audit', clientId: 'acp', configurationSource: 'native_tool',
        defaultModel: model, mcpSupport: false, acp: { command: process.execPath, startupArgs: [fixture] },
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    const load = () => loadResolvedCatConfig(template, { persistMigrations: false });
    catRegistry.reset();
    registerCatalogSnapshot(toAllCatConfigs(load()), load, template);
    const config = catRegistry.getOrThrow(id).config;
    assert.equal(config.carrier, 'acp');
    assert.equal(config.defaultModel, model);
    const service = await createAcpServiceForConfig({
      projectRoot: root, profileId: id, config, effectiveModel: model,
      acpConfig: getAcpConfig(id, root),
      poolRegistry: pools, log: { info() {}, warn() {} },
    });
    assert.ok(service);
    services.push(service);
    const captured = await service.captureInvocationOptions({ workingDirectory: root });
    let sessionId;
    const turns = [];
    for (const prompt of ['first-turn', 'second-turn']) {
      const messages = await Array.fromAsync(service.invoke(prompt, {
        ...captured, workingDirectory: root, sessionId, invocationId: `${id}-${prompt}`, hostSessionId: `host-${id}`,
      }));
      if (model) {
        assert.match(messages.find((message) => message.type === 'error')?.error ?? '', /ACP 未提供 model 配置选项/);
        turns.push({ prompt, expectedUnsupportedModelOverride: true });
        break;
      }
      assert.deepEqual(messages.filter((message) => message.type === 'error'), [], JSON.stringify(messages));
      const text = messages.filter((message) => message.type === 'text').map((message) => message.content).join('');
      assert.match(text, /permission=allow/);
      const nextSession = text.split(':')[1];
      assert.ok(nextSession);
      if (sessionId) assert.equal(nextSession, sessionId);
      sessionId = nextSession;
      turns.push({ prompt, text, types: messages.map((message) => message.type) });
    }
    results.push({ id, model, createStatus: response.statusCode, sessionId, turns });
  }
  assert.notEqual(results[0].sessionId, results[1].sessionId);
  writeFileSync(join(root, 'result.json'), JSON.stringify({ platform: process.platform, node: process.version, mockProvider: true, results }, null, 2));
  t.diagnostic(`Evidence retained: ${root}`);
});
