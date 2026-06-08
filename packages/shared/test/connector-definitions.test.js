import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getAllConnectorDefinitions, getConnectorDefinition } from '../dist/types/connector.js';

describe('F140 ConnectorDefinitions', () => {
  it('github-conflict is registered with amber themeColor', () => {
    const def = getConnectorDefinition('github-conflict');
    assert.ok(def, 'github-conflict should be registered');
    assert.equal(def.displayName, 'PR Conflict');
    assert.equal(def.icon.type, 'svg');
    assert.equal(def.icon.iconId, 'github');
    assert.equal(def.themeColor, '#D97706');
  });

  it('github-review-feedback is registered with slate themeColor', () => {
    const def = getConnectorDefinition('github-review-feedback');
    assert.ok(def, 'github-review-feedback should be registered');
    assert.equal(def.displayName, 'Review Feedback');
    assert.equal(def.icon.type, 'svg');
    assert.equal(def.icon.iconId, 'github');
    assert.equal(def.themeColor, '#475569');
  });

  it('all definitions have unique ids', () => {
    const all = getAllConnectorDefinitions();
    const ids = all.map((d) => d.id);
    assert.equal(ids.length, new Set(ids).size, 'IDs must be unique');
  });

  it('all definitions have themeColor + structured icon', () => {
    for (const def of getAllConnectorDefinitions()) {
      assert.match(def.themeColor, /^#[0-9a-fA-F]{6}$/, `${def.id} themeColor must be hex`);
      assert.ok(def.icon, `${def.id} must have icon`);
      if (def.icon.type === 'svg') {
        assert.equal(typeof def.icon.iconId, 'string', `${def.id} svg must have iconId`);
      } else {
        assert.match(def.icon.src, /^\//, `${def.id} png must have absolute src`);
      }
    }
  });
});
