import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import Fastify from 'fastify';
import { _resetCachedConfig, getCoCreatorConfig, loadResolvedCatConfig } from '../src/config/cat-config-loader.js';
import { updateRuntimeCoCreator } from '../src/config/runtime-cat-catalog.js';
import { getSenderName } from '../src/domains/cats/services/context/ContextAssembler.js';
import { configRoutes } from '../src/routes/config.js';

const roots: string[] = [];
afterEach(() => {
  _resetCachedConfig();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(owner: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'co-creator-nickname-'));
  roots.push(root);
  const template = join(root, 'cat-template.json');
  copyFileSync(new URL('../../../cat-template.json', import.meta.url), template);
  mkdirSync(join(root, '.cat-cafe'));
  const catalog = join(root, '.cat-cafe/cat-catalog.json');
  writeFileSync(
    catalog,
    JSON.stringify({
      ...JSON.parse(readFileSync(template, 'utf8')),
      version: 2,
      breeds: [],
      roster: {},
      coCreator: {
        name: 'co-creator',
        aliases: [],
        mentionPatterns: ['@co-creator'],
        ...owner,
      },
    }),
  );
  const display = () => {
    _resetCachedConfig();
    getCoCreatorConfig(loadResolvedCatConfig(template));
    return getSenderName(null);
  };
  const raw = () => JSON.parse(readFileSync(catalog, 'utf8')).coCreator;
  return { root, template, display, raw };
}

test('new installations do not prefill a familiar address', () => {
  const template = JSON.parse(readFileSync(new URL('../../../cat-template.json', import.meta.url), 'utf8'));
  assert.equal(template.coCreator.nickname, undefined);
});

test('legacy template-shaped nickname is retained without silently changing history labels', () => {
  const f = fixture({ nickname: '大当家' });
  assert.equal(f.display(), 'co-creator');
  assert.equal(f.raw().nickname, '大当家');
  updateRuntimeCoCreator(f.root, { name: 'Mina' });
  assert.equal(f.display(), 'co-creator');
  assert.equal(f.raw().nickname, '大当家');
  assert.equal(f.raw().nicknameSource, undefined);
});

test('no nickname, existing custom nickname and explicit same-as-template choice stay distinct', () => {
  for (const [owner, expected] of [
    [{}, 'co-creator'],
    [{ nickname: '小明' }, '小明'],
    [{ nickname: '大当家', nicknameSource: 'user' }, '大当家'],
  ] as const)
    assert.equal(fixture(owner).display(), expected);
});

test('manual nickname save, clear and reselect survive reload without changing routing', () => {
  const f = fixture({ nickname: '大当家' });
  for (const nickname of ['小明', null, '大当家']) {
    updateRuntimeCoCreator(f.root, { nickname });
    assert.equal(f.display(), nickname ?? 'co-creator');
    assert.equal(f.raw().nickname, nickname ?? undefined);
    assert.equal(f.raw().nicknameSource, 'user');
    assert.deepEqual(f.raw().mentionPatterns, ['@co-creator']);
  }
});

test('the existing settings route saves and clears the explicit nickname', async () => {
  const f = fixture({ nickname: '大当家' });
  const savedTemplate = process.env.CAT_TEMPLATE_PATH;
  process.env.CAT_TEMPLATE_PATH = f.template;
  const app = Fastify();
  try {
    await app.register(configRoutes, { projectRoot: f.root });
    for (const nickname of ['小明', null, '大当家']) {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/config/co-creator',
        headers: { 'x-cat-cafe-user': 'test-owner' },
        payload: { name: 'co-creator', mentionPatterns: ['@co-creator'], nickname },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().config.coCreator.nickname, nickname ?? undefined);
      assert.equal(f.display(), nickname ?? 'co-creator');
    }
  } finally {
    await app.close();
    if (savedTemplate === undefined) delete process.env.CAT_TEMPLATE_PATH;
    else process.env.CAT_TEMPLATE_PATH = savedTemplate;
  }
});
