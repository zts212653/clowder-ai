import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONCIERGE_CONFIG_DEFAULTS, createCatId } from '@cat-cafe/shared';
import {
  resolveLiveCompanionSelection,
  sameLiveExecutionSelection,
} from '../src/domains/concierge/live/live-companion-selection.js';

const cat = (id: string, clientId: 'openai' | 'anthropic', isDefaultVariant = false) => ({
  id: createCatId(id),
  displayName: id,
  clientId,
  isDefaultVariant,
});
const cats = [cat('opus', 'anthropic', true), cat('codex-alternate', 'openai'), cat('codex', 'openai', true)];
const config = { ...CONCIERGE_CONFIG_DEFAULTS, dutyCatProfileId: 'opus', displayName: '我的猫' };

test('non-OpenAI duty keeps its identity while the explicit catalog default carries Live', () => {
  for (const candidates of [cats, [...cats].reverse()]) {
    const selected = resolveLiveCompanionSelection(config, candidates);
    assert.equal(selected.duty.catId, 'opus');
    assert.equal(selected.carrier.catId, 'codex');
    assert.equal(selected.displayName, config.displayName);
    assert.equal(selected.skin, config.skin);
    assert.equal(config.dutyCatProfileId, 'opus');
  }
});

test('a selected OpenAI cat carries itself even if it is not the breed default', () => {
  const selected = resolveLiveCompanionSelection({ ...config, dutyCatProfileId: 'codex-alternate' }, cats);
  assert.equal(selected.duty.catId, 'codex-alternate');
  assert.equal(selected.carrier.catId, 'codex-alternate');
});

test('an OpenAI cloud-only cat is a deep target, never a local native carrier', () => {
  const cloud = { ...cat('gpt-pro', 'openai', true), provider: 'openai-chatgpt-pro' };
  for (const dutyCatProfileId of ['opus', 'gpt-pro']) {
    const selected = resolveLiveCompanionSelection({ ...config, dutyCatProfileId }, [...cats, cloud]);
    assert.equal(selected.duty.catId, dutyCatProfileId);
    assert.equal(selected.carrier.catId, 'codex');
  }
});

test('Host uses the selected duty nickname for historical companion identity', () => {
  const selected = resolveLiveCompanionSelection({ ...config, dutyCatProfileId: 'fable-5' }, [
    { ...cat('fable-5', 'anthropic'), displayName: '布偶猫', nickname: '宪宪' },
    ...cats,
  ]);
  assert.equal(selected.duty.catId, 'fable-5');
  assert.equal(selected.duty.displayName, '宪宪');
  assert.equal(selected.carrier.catId, 'codex');
});

test('missing or ambiguous defaults cannot fall back to array order or change the selected duty', () => {
  for (const [candidates, code] of [
    [cats.filter((item) => !item.isDefaultVariant || item.clientId !== 'openai'), 'live_carrier_unavailable'],
    [[...cats, cat('second-default', 'openai', true)], 'live_carrier_ambiguous'],
  ] as const) {
    assert.throws(() => resolveLiveCompanionSelection(config, candidates), { code });
  }
});

test('presentation changes do not rebind execution; duty or carrier changes invalidate the call', () => {
  const initial = resolveLiveCompanionSelection(config, cats);
  assert.equal(
    sameLiveExecutionSelection(initial, resolveLiveCompanionSelection({ ...config, displayName: '新名字' }, cats)),
    true,
  );
  assert.equal(
    sameLiveExecutionSelection(initial, resolveLiveCompanionSelection({ ...config, dutyCatProfileId: 'codex' }, cats)),
    false,
  );
  assert.equal(
    sameLiveExecutionSelection(
      initial,
      resolveLiveCompanionSelection(config, [cats[0]!, cat('other-default', 'openai', true)]),
    ),
    false,
  );
});
