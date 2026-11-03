/**
 * clowder-ai#1796: empty `defaultModel` accepted by the shared resolver.
 *
 * The production defect is the catalog-only path: GET /api/cats resolves a
 * catalog-visible, not-yet-reconciled member whose `defaultModel: ''` is legal
 * per `modelSchema` (packages/api/src/routes/cats.ts), and the truthiness
 * fallback in `getCatModel` made the whole page 500.
 *
 * `captureMemberExecutionPreferences` is the OTHER caller of the two-arg
 * `getCatModel(catId, config.defaultModel)`. Its normal production route is NOT
 * a second defect: `prepareInvocationExecutionBinding`
 * (invocation/invoke-single-cat.ts) takes config straight from
 * `catRegistry.tryGet`, so an already-registered empty model resolved to `''`
 * before this change too. These cases therefore pin SHARED-RESOLVER CONSISTENCY
 * at the function boundary — the non-native branch must agree with the native
 * branch on an empty value — not a second broken production invocation. No
 * claim is made here that this change widens empty-model support for API-key
 * carriers.
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
      configurationSource: 'managed_account',
    });
    assert.equal(prefs.model, '');
  });

  it('an explicit model argument still wins over the empty catalog value', () => {
    const prefs = captureMemberExecutionPreferences(
      'catalog-empty-1796',
      { ...emptyModelMember, configurationSource: 'managed_account' },
      'explicit-model',
    );
    assert.equal(prefs.model, 'explicit-model');
  });

  it('a non-empty catalog model is still resolved for a non-native member', () => {
    const prefs = captureMemberExecutionPreferences('catalog-model-1796', {
      ...emptyModelMember,
      configurationSource: 'managed_account',
      defaultModel: 'resolved-model',
    });
    assert.equal(prefs.model, 'resolved-model');
  });
});
