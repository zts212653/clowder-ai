import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { NATIVE_TOOL_IDENTITIES } from '@cat-cafe/shared';
import { resolveCatCatalogPath, writeCatCatalog } from '../dist/config/cat-catalog-store.js';
import { bootstrapDefaultCatCatalog, toAllCatConfigs } from '../dist/config/cat-config-loader.js';

const identity = NATIVE_TOOL_IDENTITIES.dsh;
const legacy = { ...identity.legacy, displayName: identity.legacy.name };
const template = JSON.parse(fs.readFileSync(new URL('../../../cat-template.json', import.meta.url), 'utf8'));

function variant(catId, acp, overrides = {}) {
  return {
    id: catId,
    catId,
    clientId: 'acp',
    carrier: 'acp',
    configurationSource: 'native_tool',
    defaultModel: 'fixture/model',
    mcpSupport: true,
    strengths: [],
    ...legacy,
    acp,
    ...overrides,
  };
}

function fixture(variants, fields = legacy) {
  const root = fs.mkdtempSync(join(tmpdir(), 'native-identity-bootstrap-'));
  const templatePath = join(root, 'cat-template.json');
  const base = {
    ...template,
    breeds: [],
    roster: { owner: { family: 'owner', roles: ['owner'], lead: false, available: true, evaluation: 'co-creator' } },
  };
  fs.writeFileSync(templatePath, JSON.stringify(base));
  writeCatCatalog(root, {
    ...base,
    memberInitialization: 'user_selected_v1',
    breeds: [
      {
        id: variants[0].catId,
        catId: variants[0].catId,
        ...fields,
        color: { primary: '#123456', secondary: '#abcdef' },
        mentionPatterns: ['@identity-fixture'],
        defaultVariantId: variants[0].id,
        variants,
      },
    ],
  });
  return { templatePath, path: resolveCatCatalogPath(root) };
}

for (const [description, adapter] of [
  ['provider flag', variant('custom-acp', { command: 'custom-acp', startupArgs: ['--provider', 'deepseek'] })],
  ['coincidental directory', variant('custom-acp', { command: 'C:/deepseek/dsh-tools/agent.exe', startupArgs: [] })],
  ['coincidental description', variant('custom-acp', { command: 'agent', startupArgs: [], description: 'dsh' })],
  ['unknown launcher', variant('custom-acp', { command: 'agent', startupArgs: [] })],
  ['user-chosen dsh slug', variant('dsh', { command: 'custom-acp', startupArgs: [] })],
  [
    'explicit plugin over native startup',
    variant(
      'dsh',
      { command: 'dsh', startupArgs: ['--profile', 'acp'] },
      {
        agentProvider: 'plugin:official.codeagent/codeagent',
      },
    ),
  ],
]) {
  test(`bootstrap preserves historical fields and binding for ${description}`, () => {
    const { templatePath, path } = fixture([adapter]);
    const before = fs.readFileSync(path);
    bootstrapDefaultCatCatalog(templatePath);
    assert.deepEqual(fs.readFileSync(path), before);
  });
}

for (const [key, command, clientId] of [
  ['dsh', 'dsh', 'acp'],
  ['kimi', 'kimi', 'kimi'],
]) {
  test(`bootstrap preserves inherited identity in a mixed ${key} breed`, () => {
    const identity = NATIVE_TOOL_IDENTITIES[key];
    const fields = { ...identity.legacy, displayName: identity.legacy.name };
    const native = variant(`fixture-${key}`, { command, startupArgs: [] }, { ...fields, clientId });
    const other = variant(
      'other-acp',
      { command: 'custom-acp', startupArgs: ['--provider', 'deepseek'] },
      {
        mentionPatterns: ['@other-acp'],
        ...Object.fromEntries(Object.keys(fields).map((field) => [field, undefined])),
      },
    );
    const { templatePath, path } = fixture([native, other], fields);
    const before = fs.readFileSync(path);
    const loaded = toAllCatConfigs(bootstrapDefaultCatCatalog(templatePath));
    assert.equal(loaded['other-acp'].personality, fields.personality);
    assert.equal(loaded['other-acp'].displayName, fields.displayName);
    assert.deepEqual(fs.readFileSync(path), before);
  });
}

test('bootstrap repairs proven DSH defaults, preserves inherited names and retries failed atomic writes', (t) => {
  const dsh = variant(
    'custom-dsh',
    {
      command: 'C:/tools/DSH.CMD',
      startupArgs: ['--profile', 'acp'],
      agentProvider: 'plugin:official.codeagent/codeagent',
    },
    {
      agentProvider: null,
      displayName: undefined,
      nickname: '自定义昵称',
      roleDescription: '用户职责',
    },
  );
  const { templatePath, path } = fixture([dsh], { ...legacy, displayName: '用户显示名' });
  const before = fs.readFileSync(path);
  const write = fs.writeFileSync;
  const rename = fs.renameSync;
  let writeBlocked = true;
  let attempts = 0;
  t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (writeBlocked && typeof file === 'string' && file.startsWith(`${path}.tmp-`)) {
      writeBlocked = false;
      throw Object.assign(new Error('fixture denied temporary file write'), { code: 'EACCES' });
    }
    return write(file, ...args);
  });
  t.mock.method(fs, 'renameSync', (source, target) => {
    if (target === path && ++attempts === 1) {
      throw Object.assign(new Error('fixture denied atomic rename'), { code: 'EACCES' });
    }
    return rename(source, target);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  assert.throws(() => bootstrapDefaultCatCatalog(templatePath), /fixture denied temporary file write/);
  assert.equal(attempts, 0);
  assert.deepEqual(fs.readFileSync(path), before);

  assert.throws(() => bootstrapDefaultCatCatalog(templatePath), /fixture denied atomic rename/);
  assert.deepEqual(fs.readFileSync(path), before);
  assert.deepEqual(fs.readdirSync(dirname(path)), ['cat-catalog.json']);

  const loaded = toAllCatConfigs(bootstrapDefaultCatCatalog(templatePath));
  const written = fs.readFileSync(path);
  const [breed] = JSON.parse(written).breeds;
  assert.equal(breed.name, legacy.name);
  assert.equal(breed.displayName, '用户显示名');
  assert.equal(breed.nickname, identity.nickname);
  assert.equal(breed.avatar, identity.avatar);
  assert.equal(loaded['custom-dsh'].displayName, '用户显示名');
  assert.deepEqual(breed.variants[0], {
    ...JSON.parse(JSON.stringify(dsh)),
    avatar: identity.avatar,
  });
  assert.equal(attempts, 2);
  bootstrapDefaultCatCatalog(templatePath);
  assert.equal(attempts, 2);
  assert.deepEqual(fs.readFileSync(path), written);
});
