import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

const { clearBudgetCache, getAllCatCapacities, getCatCapacity } = await import('../dist/config/cat-budgets.js');
const { getMemberOutputReserve, resolveContextCapacity, resolvePromptInputCeilingTokens } = await import(
  '../dist/config/context-capacity.js'
);

describe('cat capacity projections (#1208)', () => {
  before(() => clearBudgetCache());

  it('exposes capacity provenance without prompt-policy knobs', () => {
    const capacity = getCatCapacity('opus');
    assert.equal(typeof capacity.windowTokens, 'number');
    assert.equal(typeof capacity.inputCeilingTokens, 'number');
    assert.equal(typeof capacity.source, 'string');
    assert.equal(typeof capacity.actionable, 'boolean');
    assert.equal('budget' in capacity, false);
    assert.equal('maxPromptTokens' in capacity, false);
    assert.equal('maxMessages' in capacity, false);
  });

  it('projects every registered member', () => {
    const capacities = getAllCatCapacities();
    assert.ok(Object.keys(capacities).length > 0);
    for (const capacity of Object.values(capacities)) {
      assert.equal(typeof capacity.provenance, 'string');
      assert.equal('bindingKey' in capacity, false);
      assert.equal('fingerprint' in capacity, false);
      assert.equal('observedAt' in capacity, false);
    }
  });

  it('empty-UI helper cats resolve to origin 400k-class defaults', () => {
    for (const catId of ['glm', 'deepseek', 'minimax']) {
      const capacity = getCatCapacity(catId);
      assert.ok(
        capacity.windowTokens >= 400_000,
        `${catId} windowTokens=${capacity.windowTokens} should be origin 400k-class, not GLOBAL_FALLBACK`,
      );
      assert.notEqual(capacity.source, 'unresolved', `${catId} empty-UI must not stay unresolved`);
      assert.equal('maxPromptTokens' in capacity, false);
    }
  });

  it('resolveContextCapacity owns the helper-cat union: unknown deepseek model is 400k catalog, not unresolved/100k', () => {
    const capacity = resolveContextCapacity({ catId: 'deepseek', model: 'deepseek/deepseek-v4-pro' });
    assert.equal(capacity.windowTokens, 400_000);
    assert.equal(capacity.source, 'catalog');
    assert.equal(capacity.actionable, false);
    assert.equal(capacity.inputCeilingTokens, 400_000 - getMemberOutputReserve('deepseek'));
    assert.equal(resolvePromptInputCeilingTokens(capacity), capacity.inputCeilingTokens);
    assert.notEqual(resolvePromptInputCeilingTokens(capacity), 100_000);
  });

  it('resolveContextCapacity Auto catalog still wins for glm-5.2 and MiniMax-M3', () => {
    const glm = resolveContextCapacity({ catId: 'glm', model: 'zai-coding-plan/glm-5.2' });
    assert.equal(glm.windowTokens, 1_000_000);
    assert.equal(glm.source, 'catalog');

    const minimax = resolveContextCapacity({ catId: 'minimax', model: 'minimax-cn-coding-plan/MiniMax-M3' });
    assert.equal(minimax.windowTokens, 1_000_000);
    assert.equal(minimax.source, 'catalog');
  });
});
