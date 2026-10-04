import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { type CatConfig, catRegistry } from '@cat-cafe/shared';
import { ModificationTargetService } from '../src/domains/collaborative-content/modification/target-service.js';

const OWNER = 'user-1';
const thread = { id: 'thread-1', title: 'F309 主路径', createdBy: OWNER, ownerUserId: OWNER, participants: [] };

function cat(id: string, variantLabel?: string): CatConfig {
  return {
    id,
    name: id,
    displayName: '缅因猫',
    ...(variantLabel ? { variantLabel } : {}),
    avatar: '',
    color: { primary: '#000', secondary: '#fff' },
    mentionPatterns: [`@${id}`],
    clientId: 'openai',
    defaultModel: 'model',
    mcpSupport: true,
    roleDescription: 'test',
    personality: 'test',
  } as unknown as CatConfig;
}

describe('modification target labels keep same-breed cats distinguishable', () => {
  let saved: Record<string, CatConfig>;
  before(() => {
    saved = { ...catRegistry.getAllConfigs() };
    catRegistry.reset();
    catRegistry.register('codex', cat('codex'));
    catRegistry.register('gpt52', cat('gpt52', 'GPT-5.4'));
  });
  after(() => {
    catRegistry.reset();
    for (const [id, config] of Object.entries(saved)) catRegistry.register(id, config);
  });

  const service = new ModificationTargetService({
    threads: {
      get: async (id: string) => (id === thread.id ? thread : null),
      list: async () => [thread],
    } as never,
  });

  test('choices carry the variant label next to the shared breed name', async () => {
    const { cats } = await service.choices(OWNER);
    const byId = Object.fromEntries(cats.map((item) => [item.catId, item]));
    assert.equal(byId.gpt52?.variantLabel, 'GPT-5.4');
    assert.equal(byId.codex?.variantLabel, undefined);
  });

  test('the named target shown to the human includes the variant label', async () => {
    const { targetName } = await service.authorize({ targetCatId: 'gpt52', threadId: thread.id }, OWNER);
    assert.equal(targetName, '缅因猫（GPT-5.4）');
  });
});
