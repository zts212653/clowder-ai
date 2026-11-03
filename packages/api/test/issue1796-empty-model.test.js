/**
 * clowder-ai#1796: empty `defaultModel` on the execution-preferences path.
 *
 * `captureMemberExecutionPreferences` is the SECOND caller of the two-arg
 * `getCatModel(catId, config.defaultModel)`. For a non-native member whose
 * catalog entry has `defaultModel: ''` — legal per `modelSchema` in
 * packages/api/src/routes/cats.ts — it used to throw on the same stale-window
 * boundary as GET /api/cats. Unlike the member list it does not 500 a page, it
 * breaks a single invocation, which is exactly why it needs its own regression.
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';

const { captureMemberExecutionPreferences } = await import(
  '../dist/domains/cats/services/agents/providers/member-execution-preferences.js'
);

// A catalog-visible, not-yet-reconciled member with a legal empty model.
const emptyModelMember = {
  ...catRegistry.tryGet('opus').config,
  id: 'empty-model-fixture-1796',
  clientId: 'anthropic',
  defaultModel: '',
};

describe('#1796: empty defaultModel preserves CLI-decided semantics', () => {
  it('native_tool member returns its empty model unchanged', () => {
    const prefs = captureMemberExecutionPreferences('native-empty-1796', {
      ...emptyModelMember,
      configurationSource: 'native_tool',
    });
    assert.equal(prefs.model, '');
  });

  it('non-native member does not throw on an empty catalog model', () => {
    const prefs = captureMemberExecutionPreferences('catalog-empty-1796', {
      ...emptyModelMember,
      configurationSource: 'app',
    });
    assert.equal(prefs.model, '');
  });

  it('an explicit model argument still wins over the empty catalog value', () => {
    const prefs = captureMemberExecutionPreferences(
      'catalog-empty-1796',
      { ...emptyModelMember, configurationSource: 'app' },
      'explicit-model',
    );
    assert.equal(prefs.model, 'explicit-model');
  });

  it('a non-empty catalog model is still resolved for a non-native member', () => {
    const prefs = captureMemberExecutionPreferences('catalog-model-1796', {
      ...emptyModelMember,
      configurationSource: 'app',
      defaultModel: 'resolved-model',
    });
    assert.equal(prefs.model, 'resolved-model');
  });
});
