import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getAllConnectorDefinitions, getConnectorDefinition } from '../dist/types/connector.js';

describe('F140 ConnectorDefinitions', () => {
  it('GitHub connectors use a unified slate-gray gradient', () => {
    // Semantic depth: lightest (ambient) → base (standard) → deeper (attention) → deepest (action needed)
    const expected = {
      'github-repo-event': '#94A3B8', // slate-400 — ambient inbox
      'github-review': '#778899', // light-slate — standard notification
      'github-ci': '#778899', // light-slate — standard notification
      'github-issue-comment': '#778899', // light-slate — standard notification
      'github-review-feedback': '#64748B', // slate-500 — needs attention
      'github-conflict': '#475569', // slate-600 — needs action
    };
    for (const [id, color] of Object.entries(expected)) {
      const def = getConnectorDefinition(id);
      assert.ok(def, `${id} should be registered`);
      assert.equal(def.themeColor, color, `${id} themeColor should be ${color}`);
      assert.equal(def.icon.type, 'svg');
      assert.equal(def.icon.iconId, 'github');
    }
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
