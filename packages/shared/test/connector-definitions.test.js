import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getAllConnectorDefinitions, getConnectorDefinition } from '../dist/types/connector.js';

describe('F140 ConnectorDefinitions', () => {
  it('github-conflict is registered with amber theme', () => {
    const def = getConnectorDefinition('github-conflict');
    assert.ok(def, 'github-conflict should be registered');
    assert.equal(def.displayName, 'PR Conflict');
    assert.equal(def.icon, 'github');
    assert.equal(def.color.primary, '#D97706');
    assert.ok(def.tailwindTheme?.bubble.includes('amber'), 'should use amber theme');
  });

  it('github-review-feedback is registered with slate theme', () => {
    const def = getConnectorDefinition('github-review-feedback');
    assert.ok(def, 'github-review-feedback should be registered');
    assert.equal(def.displayName, 'Review Feedback');
    assert.equal(def.icon, 'github');
    assert.equal(def.color.primary, '#475569');
    assert.ok(def.tailwindTheme?.bubble.includes('slate'), 'should use slate theme');
  });

  it('all definitions have unique ids', () => {
    const all = getAllConnectorDefinitions();
    const ids = all.map((d) => d.id);
    assert.equal(ids.length, new Set(ids).size, 'IDs must be unique');
  });
});
