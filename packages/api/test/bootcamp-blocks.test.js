import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('F087: Bootcamp Interactive Rich Block definitions', () => {
  it('catSelectionBlock has valid structure', async () => {
    const { catSelectionBlock } = await import('../dist/domains/cats/services/bootcamp/bootcamp-blocks.js');
    assert.strictEqual(catSelectionBlock.kind, 'interactive');
    assert.strictEqual(catSelectionBlock.v, 1);
    assert.strictEqual(catSelectionBlock.interactiveType, 'card-grid');
    assert.strictEqual(catSelectionBlock.options.length, 3);
    assert.ok(catSelectionBlock.allowRandom);

    // All three cats present
    const ids = catSelectionBlock.options.map((o) => o.id);
    assert.ok(ids.includes('opus'));
    assert.ok(ids.includes('codex'));
    assert.ok(ids.includes('gemini'));
  });

  it('taskSelectionBlock has valid structure', async () => {
    const { taskSelectionBlock } = await import('../dist/domains/cats/services/bootcamp/bootcamp-blocks.js');
    assert.strictEqual(taskSelectionBlock.kind, 'interactive');
    assert.strictEqual(taskSelectionBlock.interactiveType, 'card-grid');
    assert.strictEqual(taskSelectionBlock.options.length, 16);
    assert.ok(taskSelectionBlock.allowRandom);

    // Level distribution: 10 Lv.1, 4 Lv.2, 2 Lv.3
    const lv1 = taskSelectionBlock.options.filter((o) => o.level === 1);
    const lv2 = taskSelectionBlock.options.filter((o) => o.level === 2);
    const lv3 = taskSelectionBlock.options.filter((o) => o.level === 3);
    assert.strictEqual(lv1.length, 10);
    assert.strictEqual(lv2.length, 4);
    assert.strictEqual(lv3.length, 2);
  });

  it('uses icon keys instead of emoji for all bootcamp options', async () => {
    const { taskSelectionBlock, catSelectionBlock } = await import(
      '../dist/domains/cats/services/bootcamp/bootcamp-blocks.js'
    );
    const allOptions = [...catSelectionBlock.options, ...taskSelectionBlock.options];

    for (const option of allOptions) {
      assert.ok(typeof option.icon === 'string' && option.icon.length > 0, `${option.id} should define icon`);
      assert.ok(!option.emoji, `${option.id} should not use emoji`);
      if (option.group) {
        assert.ok(!option.group.includes('⭐'), `${option.id} group label should be emoji-free`);
      }
    }
  });

  it('all block IDs are unique', async () => {
    const { taskSelectionBlock, catSelectionBlock } = await import(
      '../dist/domains/cats/services/bootcamp/bootcamp-blocks.js'
    );
    const allOptions = [...catSelectionBlock.options, ...taskSelectionBlock.options];
    const ids = allOptions.map((o) => o.id);
    const uniqueIds = new Set(ids);
    assert.strictEqual(uniqueIds.size, ids.length, 'Option IDs should be unique');
  });

  it('BOOTCAMP_BLOCKS registry contains all blocks', async () => {
    const { BOOTCAMP_BLOCKS } = await import('../dist/domains/cats/services/bootcamp/bootcamp-blocks.js');
    assert.ok(BOOTCAMP_BLOCKS['bootcamp-cat-select']);
    assert.ok(BOOTCAMP_BLOCKS['bootcamp-task-select']);
    assert.strictEqual(Object.keys(BOOTCAMP_BLOCKS).length, 2);
  });

  it('messageTemplate contains {selection} placeholder', async () => {
    const { catSelectionBlock, taskSelectionBlock } = await import(
      '../dist/domains/cats/services/bootcamp/bootcamp-blocks.js'
    );
    assert.ok(catSelectionBlock.messageTemplate?.includes('{selection}'));
    assert.ok(taskSelectionBlock.messageTemplate?.includes('{selection}'));
  });
});
