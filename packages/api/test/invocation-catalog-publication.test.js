import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { loadResolvedCatConfig, toAllCatConfigs } from '../dist/config/cat-config-loader.js';
import { reconcileCatRegistry, registerCatalogSnapshot } from '../dist/config/cat-registry-reconciliation.js';
import { updateRuntimeCat, withRuntimeCatMutationLock } from '../dist/config/runtime-cat-catalog.js';
import { prepareInvocationExecutionBinding } from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { ExecutionAdmissionConflict } from '../dist/domains/cats/services/agents/registry/AgentServiceUnavailableError.js';
import { isolateAccountAuthEnvironment } from './helpers/account-auth-environment.js';

for (const change of [
  'before-start',
  'startup-before-start',
  'during-capture',
  'teammate',
  'unchanged',
  'after-freeze',
  'programmatic',
  'invalid-duplicate',
]) {
  test(`catalog publication proof handles ${change} without admitting a stale registry`, async (t) => {
    t.after(isolateAccountAuthEnvironment());
    const parent = resolve('artifacts/role-agent-refactor/catalog-publication');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'fixture-'));
    mkdirSync(join(root, '.cat-cafe'));
    const catalog = {
      version: 1,
      breeds: ['publication-cat', 'teammate'].map((catId) => ({
        id: catId,
        catId,
        name: catId,
        displayName: catId,
        avatar: '/fixture.png',
        color: { primary: '#111111', secondary: '#eeeeee' },
        mentionPatterns: [`@${catId}`],
        roleDescription: 'before',
        defaultVariantId: 'default',
        variants: [
          {
            id: 'default',
            clientId: 'openai',
            defaultModel: '',
            configurationSource: 'native_tool',
            mcpSupport: false,
            cli: { command: 'codex', outputFormat: 'json' },
          },
        ],
      })),
    };
    const templatePath = join(root, 'cat-template.json'),
      catalogPath = join(root, '.cat-cafe/cat-catalog.json');
    writeFileSync(templatePath, JSON.stringify(catalog));
    writeFileSync(catalogPath, JSON.stringify(catalog));
    const keys = ['CAT_CAFE_CONFIG_ROOT', 'CAT_TEMPLATE_PATH'];
    const old = new Map(keys.map((key) => [key, process.env[key]]));
    process.env.CAT_CAFE_CONFIG_ROOT = root;
    process.env.CAT_TEMPLATE_PATH = templatePath;
    const all = catRegistry.getAllConfigs();
    t.after(() => {
      old.forEach((value, key) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
      catRegistry.reset();
      Object.entries(all).forEach(([id, member]) => {
        catRegistry.register(id, member);
      });
    });
    if (change === 'startup-before-start') {
      catRegistry.reset();
      registerCatalogSnapshot(toAllCatConfigs(loadResolvedCatConfig()), () =>
        loadResolvedCatConfig(undefined, { persistMigrations: false }),
      );
    } else reconcileCatRegistry(root, new Set());
    if (change === 'invalid-duplicate') {
      const broken = structuredClone(catalog);
      broken.breeds[0].variants.push({ ...broken.breeds[0].variants[0], id: 'duplicate' });
      writeFileSync(catalogPath, JSON.stringify(broken));
      assert.throws(() => reconcileCatRegistry(root, new Set()), /Duplicate catId/);
      assert.equal(catRegistry.tryGet('publication-cat')?.config.roleDescription, 'before');
      return;
    }
    if (change === 'programmatic')
      catRegistry.register('external-cat', { ...catRegistry.tryGet('publication-cat').config, id: 'external-cat' });
    const catId = change === 'programmatic' ? 'external-cat' : 'publication-cat';
    const registryRevision = catRegistry.getRevision();
    const mutate = () =>
      withRuntimeCatMutationLock(root, () =>
        updateRuntimeCat(root, change === 'teammate' ? 'teammate' : 'publication-cat', { roleDescription: 'after' }),
      );
    let captures = 0;
    const service = {
      async captureInvocationOptions() {
        if (++captures === 1 && change === 'during-capture') await mutate();
        return {};
      },
    };
    const prepare = () =>
      prepareInvocationExecutionBinding(
        { threadStore: null, apiUrl: 'http://127.0.0.1:13004' },
        { catId, service, threadId: 'thread', userId: 'owner' },
      );
    if (['before-start', 'startup-before-start', 'teammate', 'programmatic'].includes(change)) await mutate();
    if (change === 'unchanged') writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
    if (['unchanged', 'programmatic', 'after-freeze'].includes(change)) {
      const binding = await prepare();
      assert.equal(binding.catConfig.roleDescription, 'before');
      if (change === 'after-freeze') {
        await mutate();
        assert.equal(binding.catConfig.roleDescription, 'before');
        await assert.rejects(prepare(), ExecutionAdmissionConflict);
      } else return;
    } else await assert.rejects(prepare(), ExecutionAdmissionConflict);
    assert.equal(
      catRegistry.getRevision(),
      registryRevision,
      'disk commit must not pretend the subscriber has published',
    );
    reconcileCatRegistry(root, new Set(catRegistry.getAllIds()));
    const next = await prepare();
    assert.equal(next.catConfig.roleDescription, change === 'teammate' ? 'before' : 'after');
    assert.equal(catRegistry.tryGet('teammate').config.roleDescription, change === 'teammate' ? 'after' : 'before');
  });
}
