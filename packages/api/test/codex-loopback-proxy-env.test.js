import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { codexLoopbackProxyEnvironment } from '../dist/domains/cats/services/agents/providers/codex-loopback-proxy-env.js';

const loopback = ['localhost', '127.0.0.1', '::1'];

for (const [name, overrides, inherited, expected] of [
  ['system proxy without environment exclusions', {}, {}, loopback],
  ['upper spelling only', { NO_PROXY: 'office.example,10.0.0.0/8' }, {}, ['office.example', '10.0.0.0/8', ...loopback]],
  ['lower spelling only', { no_proxy: 'lower.example' }, {}, ['lower.example', ...loopback]],
  [
    'both inherited spellings survive the explicit child overlay',
    {},
    { NO_PROXY: 'upper.example', no_proxy: 'lower.example' },
    ['upper.example', 'lower.example', ...loopback],
  ],
  [
    'final account override wins while the other inherited spelling survives',
    { NO_PROXY: 'account.example' },
    { NO_PROXY: 'shadowed.example', no_proxy: 'inherited.example' },
    ['account.example', 'inherited.example', ...loopback],
  ],
  [
    'case and whitespace do not duplicate existing loopback hosts',
    { NO_PROXY: ' LOCALHOST,127.0.0.1,::1, OFFICE.example ', no_proxy: 'office.EXAMPLE,localhost' },
    {},
    ['LOCALHOST', '127.0.0.1', '::1', 'OFFICE.example'],
  ],
  [
    'explicit deletion does not resurrect inherited exclusions',
    { NO_PROXY: null, no_proxy: '' },
    { NO_PROXY: 'deleted.example', no_proxy: 'deleted-lower.example' },
    loopback,
  ],
  ['existing user wildcard is preserved rather than introduced', { no_proxy: '*' }, {}, ['*', ...loopback]],
]) {
  test(name, () => {
    const env = Object.freeze(overrides);
    const parent = Object.freeze(inherited);
    const result = codexLoopbackProxyEnvironment(env, parent);
    assert.deepEqual(result, { NO_PROXY: expected.join(','), no_proxy: expected.join(',') });
    assert.deepEqual(codexLoopbackProxyEnvironment(result, parent), result, 'repeat launches are stable');
  });
}

test('the normalization produces no proxy endpoint, credential or global environment changes', () => {
  const fingerprint = () =>
    createHash('sha256')
      .update(JSON.stringify(Object.entries(process.env).sort()))
      .digest('hex');
  const before = fingerprint();
  const input = Object.freeze({
    HTTP_PROXY: 'http://user-proxy.example:8080',
    ALL_PROXY: 'socks5://user-proxy.example:1080',
    TOKEN: 'fixture-token',
  });
  const patch = codexLoopbackProxyEnvironment(input, {});
  assert.deepEqual(Object.keys(patch).sort(), ['NO_PROXY', 'no_proxy']);
  assert.deepEqual({ ...input, ...patch }, { ...input, NO_PROXY: loopback.join(','), no_proxy: loopback.join(',') });
  assert.equal(fingerprint(), before, 'the parent environment must remain unchanged');
});
