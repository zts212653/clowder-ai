import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyPatch } from '../../dist/domains/world/json-patch.js';

describe('applyPatch — json-patch.ts', () => {
  it('throws when parent path does not exist (cloud P1)', () => {
    const target = { growthState: {} };
    assert.throws(
      () => applyPatch(target, [{ op: 'add', path: '/growthState/milestones/-', value: 'first' }]),
      /parent.*not.*exist|cannot.*traverse/i,
      'should throw when intermediate path is missing',
    );
  });

  it('add to existing array via - works', () => {
    const target = { growthState: { milestones: ['a'] } };
    const result = applyPatch(target, [{ op: 'add', path: '/growthState/milestones/-', value: 'b' }]);
    assert.deepEqual(result.growthState.milestones, ['a', 'b']);
  });

  it('replace on existing key works', () => {
    const target = { name: 'old' };
    const result = applyPatch(target, [{ op: 'replace', path: '/name', value: 'new' }]);
    assert.equal(result.name, 'new');
  });

  it('remove existing key works', () => {
    const target = { a: 1, b: 2 };
    const result = applyPatch(target, [{ op: 'remove', path: '/b' }]);
    assert.equal(result.b, undefined);
    assert.equal(result.a, 1);
  });

  it('rejects remove with - index on array (cloud P1)', () => {
    const target = { items: ['a', 'b', 'c'] };
    assert.throws(
      () => applyPatch(target, [{ op: 'remove', path: '/items/-' }]),
      /invalid|not valid|cannot.*remove/i,
      'remove with - should throw, not silently delete first element',
    );
  });

  it('rejects __proto__ path (cloud P0 — prototype pollution)', () => {
    const target = { data: {} };
    assert.throws(
      () => applyPatch(target, [{ op: 'add', path: '/__proto__/isAdmin', value: true }]),
      /prohibited|prototype|__proto__/i,
    );
    assert.equal({}.isAdmin, undefined, 'Object prototype must not be polluted');
  });

  it('rejects constructor/prototype path (cloud P0)', () => {
    const target = { data: {} };
    assert.throws(
      () => applyPatch(target, [{ op: 'add', path: '/constructor/prototype/x', value: 1 }]),
      /prohibited|prototype|constructor/i,
    );
  });
});
