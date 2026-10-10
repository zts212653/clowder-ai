import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { catsRoutes } from '../dist/routes/cats.js';

const cwd = process.cwd();
const root = mkdtempSync(join(tmpdir(), 'native-roles-'));
const savedTemplate = process.env.CAT_TEMPLATE_PATH;
const savedGlobal = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
const template = JSON.parse(readFileSync(new URL('../../../cat-template.json', import.meta.url), 'utf8'));
mkdirSync(join(root, '.cat-cafe'));
writeFileSync(join(root, 'cat-template.json'), JSON.stringify(template));
writeFileSync(join(root, '.cat-cafe/cat-catalog.json'), JSON.stringify(template));
process.env.CAT_TEMPLATE_PATH = join(root, 'cat-template.json');
process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
process.chdir(root);
const headers = { 'content-type': 'application/json', 'x-cat-cafe-user': 'default-user' };
test('native role create, independent override and reset round-trip without account bindings', async () => {
  const app = Fastify();
  await app.register(catsRoutes);
  try {
    for (const [id, clientId] of [
      ['native-codex', 'openai'],
      ['native-claude', 'anthropic'],
      ['native-dsh', 'acp'],
    ]) {
      const create = await app.inject({
        method: 'POST',
        url: '/api/cats',
        headers,
        payload: {
          catId: id,
          name: id,
          displayName: id,
          color: { primary: '#123456', secondary: '#abcdef' },
          mentionPatterns: [`@${id}`],
          roleDescription: 'native role',
          configurationSource: 'native_tool',
          clientId,
          defaultModel: '',
          ...(clientId === 'acp' ? { acp: { command: 'node', startupArgs: ['entry.js', '--profile', 'acp'] } } : {}),
        },
      });
      assert.equal(create.statusCode, 201, create.body);
      const created = create.json().cat;
      assert.equal(created.configurationSource, 'native_tool');
      assert.equal(typeof created.configurationRevision, 'string');
      assert.equal(created.defaultModel, '');
      assert.equal(created.accountRef, undefined);
      assert.equal(created.cli.effort, undefined);
      const patch = await app.inject({
        method: 'PATCH',
        url: `/api/cats/${id}`,
        headers,
        payload: { cli: { effort: 'low' } },
      });
      assert.equal(patch.statusCode, 200, patch.body);
      assert.equal(patch.json().cat.defaultModel, '');
      assert.equal(patch.json().cat.cli.effort, 'low');
      const nativeLevel = clientId === 'acp' ? 'off' : clientId === 'openai' ? 'ultra' : 'xhigh';
      const advertised = await app.inject({
        method: 'PATCH',
        url: `/api/cats/${id}`,
        headers,
        payload: {
          cli: { effort: nativeLevel },
          defaultModel: clientId === 'acp' ? '["deepseek-official","deepseek-v4-pro"]' : 'native-advertised-model',
        },
      });
      assert.equal(advertised.statusCode, 200, advertised.body);
      assert.equal(advertised.json().cat.cli.effort, nativeLevel);
      const reset = await app.inject({
        method: 'PATCH',
        url: `/api/cats/${id}`,
        headers,
        payload: { defaultModel: '', cli: { effort: null } },
      });
      assert.equal(reset.statusCode, 200, reset.body);
      assert.equal(reset.json().cat.cli.effort, undefined);
      if (clientId === 'acp') assert.deepEqual(reset.json().cat.acp.startupArgs, ['entry.js', '--profile', 'acp']);
      const stale = await app.inject({
        method: 'PATCH',
        url: `/api/cats/${id}`,
        headers,
        payload: { expectedRevision: patch.json().cat.configurationRevision, nickname: 'stale write' },
      });
      assert.equal(stale.statusCode, 409, stale.body);
    }
    const catalog = JSON.parse(readFileSync(join(root, '.cat-cafe/cat-catalog.json'), 'utf8'));
    assert.equal(catalog.breeds.find((b) => b.catId === 'native-codex').variants[0].configurationSource, 'native_tool');
    const discovery = await app.inject('/api/cats/native-runtimes');
    assert.equal(discovery.statusCode, 200, discovery.body);
    assert.equal(discovery.json().authenticationStatus, 'not_checked');
    assert.doesNotMatch(discovery.body, /apiKey|access_token|refresh_token/);
    const missingAccount = await app.inject({
      method: 'POST',
      url: '/api/cats/runtime-models',
      headers,
      payload: { runtimeId: 'codex', accountRef: 'missing-connection' },
    });
    assert.equal(missingAccount.statusCode, 200, missingAccount.body);
    assert.deepEqual(missingAccount.json(), { status: 'unavailable', models: [], message: 'account_unavailable' });
  } finally {
    await app.close();
    process.chdir(cwd);
    process.env.CAT_TEMPLATE_PATH = savedTemplate;
    if (savedGlobal === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = savedGlobal;
  }
});
