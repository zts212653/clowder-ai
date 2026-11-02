import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { resolveConfiguredMemberMcpFamilies } from '../src/config/capabilities/member-mcp-families.js';
import {
  getAcpConfig,
  getRegisteredAcpConfig,
  loadResolvedCatConfig,
  resolveRuntimeCatTemplatePath,
  toAllCatConfigs,
} from '../src/config/cat-config-loader.js';
import { reconcileCatRegistry } from '../src/config/cat-registry-reconciliation.js';

test('an empty configured runtime template fails before bootstrap can select a directory', () => {
  const saved = process.env.CAT_TEMPLATE_PATH;
  try {
    process.env.CAT_TEMPLATE_PATH = '';
    assert.throws(() => resolveRuntimeCatTemplatePath(), /runtime_cat_template_unavailable/);
  } finally {
    if (saved === undefined) delete process.env.CAT_TEMPLATE_PATH;
    else process.env.CAT_TEMPLATE_PATH = saved;
  }
});

test('an ACP member keeps its loaded catalog authority across a separate capability/data root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'member-acp-source-'));
  const home = join(root, 'member-owner');
  const alpha = join(root, 'isolated-runtime');
  const saved = { root: process.env.CAT_CAFE_CONFIG_ROOT, template: process.env.CAT_TEMPLATE_PATH };
  const before = catRegistry.getAllIds().map((id) => [id, catRegistry.getOrThrow(id)] as const);
  try {
    for (const directory of [home, alpha]) mkdirSync(join(directory, '.cat-cafe'), { recursive: true });
    const template = join(home, 'cat-template.json');
    copyFileSync(resolve('../../cat-template.json'), template);
    copyFileSync(template, join(alpha, 'cat-template.json'));
    const catalog = JSON.parse(readFileSync(template, 'utf8'));
    const variant = catalog.breeds.find((breed: { catId?: string }) => breed.catId === 'codex').variants[0];
    variant.clientId = 'acp';
    variant.carrier = 'acp';
    variant.acp = { command: 'fixture-native-acp', mcpWhitelist: ['cat-cafe-memory'] };
    writeFileSync(join(home, '.cat-cafe/cat-catalog.json'), JSON.stringify(catalog));
    writeFileSync(join(alpha, '.cat-cafe/cat-catalog.json'), JSON.stringify({ ...catalog, breeds: [], roster: {} }));
    writeFileSync(
      join(alpha, '.cat-cafe/capabilities.json'),
      JSON.stringify({
        version: 1,
        capabilities: [
          {
            id: 'cat-cafe-memory',
            type: 'mcp',
            source: 'cat-cafe',
            enabled: true,
            mcpServer: { command: process.execPath, args: [resolve('../mcp-server/dist/memory.js')] },
          },
          {
            id: 'cat-cafe-collab',
            type: 'mcp',
            source: 'cat-cafe',
            enabled: false,
            mcpServer: { command: process.execPath, args: [resolve('../mcp-server/dist/collab.js')] },
          },
        ],
      }),
    );
    process.env.CAT_CAFE_CONFIG_ROOT = alpha;
    process.env.CAT_TEMPLATE_PATH = template;
    const member = toAllCatConfigs(loadResolvedCatConfig(template, { persistMigrations: false })).codex;
    assert.ok(member);
    catRegistry.reset();
    catRegistry.register('codex', member, { configurationTemplatePath: template });
    const sourceBytes = readFileSync(join(home, '.cat-cafe/cat-catalog.json'), 'utf8');
    assert.equal(getAcpConfig('codex', alpha), undefined, 'project reads must still reject the outside template');
    assert.equal(getRegisteredAcpConfig('codex', alpha)?.command, 'fixture-native-acp');
    assert.deepEqual(await resolveConfiguredMemberMcpFamilies(alpha, 'codex'), ['memory']);
    const publicMember = catRegistry.getAllConfigs().codex;
    assert.ok(publicMember);
    assert.equal(Object.hasOwn(publicMember, 'configurationTemplatePath'), false);

    reconcileCatRegistry(alpha, new Set());
    assert.equal(catRegistry.getOrThrow('codex').configurationTemplatePath, template);
    assert.deepEqual(await resolveConfiguredMemberMcpFamilies(alpha, 'codex'), ['memory']);
    assert.equal(readFileSync(join(home, '.cat-cafe/cat-catalog.json'), 'utf8'), sourceBytes);

    variant.acp.mcpWhitelist = ['cat-cafe-collab'];
    writeFileSync(join(home, '.cat-cafe/cat-catalog.json'), JSON.stringify(catalog));
    assert.deepEqual(await resolveConfiguredMemberMcpFamilies(alpha, 'codex'), [], 'current source revocation is live');

    variant.acp.mcpWhitelist = ['cat-cafe-memory'];
    variant.acp.command = 'wrong-source-acp';
    writeFileSync(join(alpha, '.cat-cafe/cat-catalog.json'), JSON.stringify(catalog));
    rmSync(template);
    assert.equal(getRegisteredAcpConfig('codex', alpha), undefined, 'a lost bound source cannot adopt another profile');
    assert.deepEqual(await resolveConfiguredMemberMcpFamilies(alpha, 'codex'), []);
  } finally {
    catRegistry.reset();
    for (const [id, entry] of before)
      catRegistry.register(
        id,
        entry.config,
        entry.configurationTemplatePath ? { configurationTemplatePath: entry.configurationTemplatePath } : undefined,
      );
    for (const [key, value] of Object.entries({
      CAT_CAFE_CONFIG_ROOT: saved.root,
      CAT_TEMPLATE_PATH: saved.template,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
