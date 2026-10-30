import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { getCoCreatorConfig } from '../dist/config/cat-config-loader.js';
import { AgentRegistry } from '../dist/domains/cats/services/agents/registry/AgentRegistry.js';
import { AgentRouter } from '../dist/domains/cats/services/agents/routing/AgentRouter.js';
import { parseA2AMentions } from '../dist/domains/cats/services/agents/routing/a2a-mentions.js';

let saved;
let router;
const fixture = (id, displayName, nickname, mentionPatterns = [`@${id}`]) => ({
  ...saved.codex,
  id,
  displayName,
  nickname,
  variantLabel: undefined,
  mentionPatterns,
});
function reload(configs) {
  catRegistry.reset();
  for (const config of configs) catRegistry.register(config.id, config);
}
before(() => {
  saved = catRegistry.getAllConfigs();
  const agents = new AgentRegistry();
  for (const id of ['dsh', 'other']) agents.register(id, { invoke: async function* () {} });
  router = new AgentRouter({
    agentRegistry: agents,
    registry: { create: () => ({ invocationId: 'fixture', callbackToken: 'fixture' }) },
    messageStore: { getByThread: () => [], getByThreadAfter: () => [], getByThreadBefore: () => [] },
  });
});
after(() => reload(Object.values(saved)));

test('user mention accepts the complete human identity and preserves stable handles and A2A grammar', async () => {
  reload([fixture('dsh', '小鲸鱼', '鲸鲸')]);
  for (const content of ['@小鲸鱼 · 鲸鲸 请看一下', '请找 @小鲸鱼 · 鲸鲸，确认。', '@dsh 请继续']) {
    assert.deepEqual((await router.parseAllMentions(content, 'fixture')).mentions, ['dsh']);
  }
  assert.deepEqual(parseA2AMentions('@小鲸鱼 · 鲸鲸 请处理'), []);
  assert.deepEqual(parseA2AMentions('@dsh 请处理'), ['dsh']);
});

test('display identity never replaces an existing registered alias and refreshes from the registry', async () => {
  reload([fixture('dsh', '小鲸鱼', '鲸鲸'), fixture('other', '另一位', '', ['@other', '@小鲸鱼 · 鲸鲸'])]);
  assert.deepEqual((await router.parseAllMentions('@小鲸鱼 · 鲸鲸 请看', 'fixture')).mentions, ['other']);
  reload([fixture('dsh', '新鲸鱼', '鲸鲸')]);
  assert.deepEqual((await router.parseAllMentions('@新鲸鱼 · 鲸鲸 请看', 'fixture')).mentions, ['dsh']);
  assert.deepEqual((await router.parseAllMentions('@小鲸鱼 · 鲸鲸 请看', 'fixture')).mentions, []);
});

test('display identity cannot steal the boundary-valid prefix of another registered alias', async () => {
  reload([fixture('dsh', '小鲸鱼', '鲸鲸'), fixture('other', '另一位', '', ['@other', '@小鲸鱼'])]);
  assert.deepEqual((await router.parseAllMentions('@小鲸鱼 · 鲸鲸 请看', 'fixture')).mentions, ['other']);
  assert.deepEqual(parseA2AMentions('@小鲸鱼 · 鲸鲸 请处理'), ['other']);
});

test('configured co-creator aliases remain human-only and refresh without rebuilding the router', async () => {
  const coCreator = getCoCreatorConfig();
  try {
    getCoCreatorConfig({ version: 2, coCreator: { name: 'Felix', aliases: [], mentionPatterns: ['@Felix'] } });
    reload([fixture('dsh', 'Felix', '')]);
    assert.deepEqual((await router.parseAllMentions('@Felix 请看', 'fixture')).mentions, []);
    assert.deepEqual((await router.parseAllMentions('@dsh 请看', 'fixture')).mentions, ['dsh']);
    getCoCreatorConfig({ version: 2, coCreator: { name: '另一个用户', aliases: [], mentionPatterns: ['@human'] } });
    assert.deepEqual((await router.parseAllMentions('@Felix 请看', 'fixture')).mentions, ['dsh']);
  } finally {
    getCoCreatorConfig({ version: 2, coCreator });
  }
});

test('duplicate identities are not a route; longest labels and punctuation resolve without prose false positives', async () => {
  reload([fixture('dsh', '小鲸鱼', '鲸鲸'), fixture('other', '小鲸鱼', '鲸鲸')]);
  assert.deepEqual((await router.parseAllMentions('@小鲸鱼 · 鲸鲸 请看', 'fixture')).mentions, []);
  reload([fixture('dsh', '小鲸鱼', '鲸鲸'), fixture('other', '小鲸鱼', '鲸鲸二')]);
  assert.deepEqual((await router.parseAllMentions('@小鲸鱼 · 鲸鲸二：请看', 'fixture')).mentions, ['other']);
  for (const content of [
    '小鲸鱼 · 鲸鲸 请看',
    'email@小鲸鱼 · 鲸鲸',
    '`@小鲸鱼 · 鲸鲸`',
    'https://example.test/@小鲸鱼 · 鲸鲸',
    '@小鲸鱼 · 鲸鲸suffix',
    '@小鲸鱼 · 鲸鲸二号',
    '@小鲸鱼 · 鲸鲸𝒂',
  ]) {
    assert.deepEqual((await router.parseAllMentions(content, 'fixture')).mentions, [], content);
  }
});
