// Environment settings control session mode and cat-to-implementation bindings.
//
// The switch is deliberately dumb: only the two exact strings count, an unset
// switch is "plugin", everything else is "off" plus a warning, and a
// broken bindings document must never take the process down.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readSessionContractSettings } from '../../dist/domains/cats/services/agents/session-contract/session-contract-settings.js';

const MODE = 'CAT_CAFE_AGENT_SESSION_CONTRACT';
const BINDINGS = 'CAT_CAFE_AGENT_SESSION_BINDINGS';

function read(env) {
  return readSessionContractSettings(env);
}

test('[44] an unset or empty switch defaults to plugin with no bindings and no warning', () => {
  for (const env of [{}, { [MODE]: '' }]) {
    const settings = read(env);
    assert.equal(settings.mode, 'plugin');
    assert.equal(settings.bindings.size, 0);
    assert.deepEqual(settings.warnings, []);
  }
});

test('[37] an explicit off still turns the contract off', () => {
  const settings = read({ [MODE]: 'off' });
  assert.equal(settings.mode, 'off');
  assert.equal(settings.bindings.size, 0);
  assert.deepEqual(settings.warnings, []);
});

test('[37] an explicit plugin turns the switch on', () => {
  const settings = read({ [MODE]: 'plugin' });
  assert.equal(settings.mode, 'plugin');
  assert.equal(settings.bindings.size, 0);
  assert.deepEqual(settings.warnings, []);
});

test('[37] any other value is off plus one warning and binds nothing', () => {
  for (const value of ['PLUGIN', ' plugin', 'plugin ', 'on', 'true', '1', 'acp']) {
    const settings = read({ [MODE]: value, [BINDINGS]: JSON.stringify({ 'cat-1': 'plugin:acme/agent' }) });
    assert.equal(settings.mode, 'off', `"${value}" must not enable the contract`);
    assert.equal(settings.bindings.size, 0, `"${value}" must not bind anything`);
    assert.equal(settings.warnings.length, 1, `"${value}" must produce exactly one warning`);
  }
});

test('[44] the default plugin mode parses bindings and warns on a broken document', () => {
  const bound = read({ [BINDINGS]: JSON.stringify({ 'cat-1': 'plugin:acme/intranet-agent' }) });
  assert.equal(bound.mode, 'plugin');
  assert.deepEqual(bound.bindings.get('cat-1'), { pluginId: 'acme', contributionId: 'intranet-agent' });
  assert.deepEqual(bound.warnings, []);

  const broken = read({ [BINDINGS]: '{not json' });
  assert.equal(broken.mode, 'plugin');
  assert.equal(broken.bindings.size, 0);
  assert.equal(broken.warnings.length, 1);
});

test('[37] mode off never parses the bindings document', () => {
  const valid = read({ [MODE]: 'off', [BINDINGS]: JSON.stringify({ 'cat-1': 'plugin:acme/intranet-agent' }) });
  assert.equal(valid.mode, 'off');
  assert.equal(valid.bindings.size, 0);
  assert.deepEqual(valid.warnings, []);

  const broken = read({ [MODE]: 'off', [BINDINGS]: '{not json' });
  assert.equal(broken.mode, 'off');
  assert.equal(broken.bindings.size, 0);
  assert.deepEqual(broken.warnings, [], 'an unparsed document must not warn');
});

test('[37] plugin mode reads plugin:<pluginId>/<contributionId> bindings', () => {
  const settings = read({
    [MODE]: 'plugin',
    [BINDINGS]: JSON.stringify({
      'cat-1': 'plugin:acme/intranet-agent',
      'cat-2': 'plugin:other/agent-2',
    }),
  });

  assert.equal(settings.mode, 'plugin');
  assert.equal(settings.bindings.size, 2);
  assert.deepEqual(settings.bindings.get('cat-1'), { pluginId: 'acme', contributionId: 'intranet-agent' });
  assert.deepEqual(settings.bindings.get('cat-2'), { pluginId: 'other', contributionId: 'agent-2' });
  assert.deepEqual(settings.warnings, []);
});

test('[37] a missing, empty, broken or non-object bindings document binds nothing', () => {
  const missing = read({ [MODE]: 'plugin' });
  assert.equal(missing.bindings.size, 0);
  assert.deepEqual(missing.warnings, []);

  const empty = read({ [MODE]: 'plugin', [BINDINGS]: '' });
  assert.equal(empty.bindings.size, 0);

  const broken = read({ [MODE]: 'plugin', [BINDINGS]: '{"cat-1":' });
  assert.equal(broken.bindings.size, 0);
  assert.equal(broken.warnings.length, 1);

  for (const raw of ['[]', '"cat-1"', 'null', '42', 'true']) {
    const settings = read({ [MODE]: 'plugin', [BINDINGS]: raw });
    assert.equal(settings.bindings.size, 0, `${raw} must bind nothing`);
    assert.ok(settings.warnings.length >= 1, `${raw} must warn`);
  }
});

test('[37] a single invalid entry is skipped with one warning and the rest still bind', () => {
  const settings = read({
    [MODE]: 'plugin',
    [BINDINGS]: JSON.stringify({
      'cat-1': 'plugin:acme/intranet-agent',
      'cat-2': 'builtin:acp',
    }),
  });

  assert.deepEqual([...settings.bindings.keys()], ['cat-1']);
  assert.deepEqual(settings.bindings.get('cat-1'), { pluginId: 'acme', contributionId: 'intranet-agent' });
  assert.equal(settings.warnings.length, 1);
});

test('[37] every malformed binding value is skipped', () => {
  const invalidValues = [
    'builtin:acp',
    'plugin:/contribution',
    'plugin:pluginId/',
    'plugin:pluginId/contribution/extra',
    'plugin:pluginId',
    'plugin:pluginIdcontribution',
    'plugin:',
    'acme/contribution',
    '',
    42,
    null,
    ['plugin:acme/agent'],
    { pluginId: 'acme', contributionId: 'agent' },
  ];

  for (const value of invalidValues) {
    const settings = read({ [MODE]: 'plugin', [BINDINGS]: JSON.stringify({ 'cat-1': value }) });
    assert.equal(settings.bindings.size, 0, `value ${JSON.stringify(value)} must not bind`);
    assert.equal(settings.warnings.length, 1, `value ${JSON.stringify(value)} must warn once`);
  }
});

test('[37] the bindings map is a keyed map, not a plain object', () => {
  const settings = read({ [MODE]: 'plugin' });

  assert.equal(typeof settings.bindings.get, 'function');
  assert.equal(typeof settings.bindings.has, 'function');
  assert.equal(settings.bindings.get('cat-1'), undefined);
});

test('[37] reading settings never throws', () => {
  const hostile = [
    {},
    { [MODE]: 'plugin', [BINDINGS]: '{"__proto__":{"cat-1":"plugin:acme/agent"}}' },
    { [MODE]: 'plugin', [BINDINGS]: '{"cat-1":"plugin:acme/agent","cat-1":"plugin:other/agent"}' },
    { [MODE]: 'plugin', [BINDINGS]: '{"cat-1":null,"cat-2":"plugin:acme/agent"}' },
    { [MODE]: 'plugin', [BINDINGS]: '{"":"plugin:acme/agent"}' },
    { [MODE]: 'plugin', [BINDINGS]: new Array(1000).fill('plugin:acme/agent').join(',') },
  ];

  for (const env of hostile) {
    let settings;
    assert.doesNotThrow(() => {
      settings = read(env);
    });
    assert.ok(settings.mode === 'off' || settings.mode === 'plugin');
    assert.ok(Array.isArray(settings.warnings));
  }
});
