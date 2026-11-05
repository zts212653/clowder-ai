import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { writeCatalogAccount } from '../dist/config/catalog-accounts.js';
import { catsRoutes } from '../dist/routes/cats.js';
import { isolateAccountAuthEnvironment } from './helpers/account-auth-environment.js';

const provider = `
[model_providers.fixture]
name="Fixture"
wire_api="responses"
base_url="https://native-provider.invalid/v1"
requires_openai_auth=false
experimental_bearer_token="fixture-private-token"
`;

test('native Codex creation follows its third-party config without weakening explicit account admission', async () => {
  const template = JSON.parse(readFileSync(process.env.CAT_TEMPLATE_PATH, 'utf8'));
  const root = mkdtempSync(join(tmpdir(), 'native-codex-admission-'));
  const home = join(root, 'native-home');
  mkdirSync(home);
  mkdirSync(join(root, '.cat-cafe'));
  const saved = { ...process.env };
  const restoreAuth = isolateAccountAuthEnvironment();
  const cwd = process.cwd();
  const app = Fastify();
  try {
    Object.assign(process.env, {
      HOME: root,
      USERPROFILE: root,
      CODEX_HOME: home,
      CAT_TEMPLATE_PATH: join(root, 'cat-template.json'),
      CAT_CAFE_GLOBAL_CONFIG_ROOT: root,
      CAT_CAFE_CONFIG_ROOT: root,
      CAT_CAFE_DATA_DIR: join(root, 'data'),
    });
    delete process.env.CODEX_SQLITE_HOME;
    writeFileSync(process.env.CAT_TEMPLATE_PATH, JSON.stringify(template));
    writeFileSync(join(root, '.cat-cafe/cat-catalog.json'), JSON.stringify({ ...template, breeds: [] }));
    writeFileSync(join(home, 'auth.json'), 'fixture-native-auth-owned-by-cli');
    writeFileSync(join(home, 'history.jsonl'), 'fixture-native-history');
    process.chdir(root);
    await app.register(catsRoutes);
    const headers = { 'x-cat-cafe-user': 'fixture' };
    let sequence = 0;
    const create = (extra = {}) => {
      const id = `native-provider-${++sequence}`;
      return app.inject({
        method: 'POST',
        url: '/api/cats',
        headers,
        payload: {
          catId: id,
          name: id,
          displayName: id,
          avatar: '/avatars/runtime.png',
          color: { primary: '#0f172a', secondary: '#e2e8f0' },
          mentionPatterns: [`@${id}`],
          roleDescription: 'Fixture role',
          clientId: 'openai',
          configurationSource: 'native_tool',
          defaultModel: '',
          ...extra,
        },
      });
    };
    const config = (value) => writeFileSync(join(home, 'config.toml'), value);
    config(`model_provider="fixture"\n${provider}`);
    const created = await create();
    assert.equal(created.statusCode, 201, created.body);
    const id = created.json().cat.id;
    const readback = await app.inject({ url: '/api/cats', headers });
    const cat = readback.json().cats.find((entry) => entry.id === id);
    assert.equal(cat.configurationSource, 'native_tool');
    assert.equal(cat.accountRef, undefined);
    assert.equal(cat.defaultModel, '');
    assert.doesNotMatch(readback.body, /fixture-private-token/);
    for (const [text, extra] of [
      [`profile="fixture-profile"\n[profiles.fixture-profile]\nmodel_provider="fixture"\n${provider}`, {}],
      [provider, { cliConfigArgs: ['--config model_provider="fixture"'] }],
      [provider, { cliConfigArgs: ['--profile selected'] }],
    ]) {
      writeFileSync(join(home, 'selected.config.toml'), 'model_provider="fixture"');
      config(text);
      const response = await create(extra);
      assert.equal(response.statusCode, 201, response.body);
    }
    for (const [text, extra] of [
      ['', {}],
      ['model_provider="openai"\n[model_providers.openai]\nrequires_openai_auth=false', {}],
      ['model_provider="fixture"\n[model_providers.fixture]\nrequires_openai_auth=false', {}],
      [`model_provider="fixture"\n${provider.replace('requires_openai_auth=false', 'requires_openai_auth=true')}`, {}],
      [`model_provider="fixture"\nforced_login_method="chatgpt"\n${provider}`, {}],
      [`model_provider="fixture"\n${provider}`, { cliConfigArgs: ['--config model_provider="openai"'] }],
      [`model_provider="fixture"\n${provider}`, { accountRef: 'codex' }],
      [`model_provider="fixture"\n${provider}`, { configurationSource: 'managed_account', accountRef: 'codex' }],
      ['invalid = [', {}],
    ]) {
      config(text);
      const before = readFileSync(join(root, '.cat-cafe/cat-catalog.json'), 'utf8');
      const response = await create(extra);
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(readFileSync(join(root, '.cat-cafe/cat-catalog.json'), 'utf8'), before);
      assert.doesNotMatch(response.body, /fixture-private-token/);
    }
    config(`model_provider="fixture"\n${provider}`);
    writeCatalogAccount(root, 'codex', { authType: 'oauth', clientId: 'openai' });
    const nativeWithAppDefault = await create();
    assert.equal(nativeWithAppDefault.statusCode, 201, 'an unrelated app default cannot control native admission');
    const explicit = await create({ accountRef: 'codex' });
    assert.equal(explicit.statusCode, 400, explicit.body);
    assert.equal(readFileSync(join(home, 'auth.json'), 'utf8'), 'fixture-native-auth-owned-by-cli');
    assert.equal(readFileSync(join(home, 'history.jsonl'), 'utf8'), 'fixture-native-history');
    assert.equal(readFileSync(join(home, 'config.toml'), 'utf8'), `model_provider="fixture"\n${provider}`);
  } finally {
    await app.close();
    process.chdir(cwd);
    restoreAuth();
    process.env = saved;
    rmSync(root, { recursive: true, force: true });
  }
});
