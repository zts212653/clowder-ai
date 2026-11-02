import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveCodexNetworkEnvironment, prepareCodexEnvironment } from '../dist/utils/codex-network-environment.js';

for (const platform of ['linux', 'darwin', 'win32']) {
  test(`existing exceptions, aliases and proxy settings survive on ${platform}`, () => {
    const input = {
      HTTP_PROXY: 'http://proxy.fixture.invalid:3128',
      HTTPS_PROXY: 'http://proxy.fixture.invalid:3129',
      ALL_PROXY: 'socks5://proxy.fixture.invalid:1080',
      NO_PROXY: 'internal.fixture,localhost',
      no_proxy: '.corp.fixture,127.0.0.1',
      No_Proxy: 'service.fixture,::1',
    };
    const result = deriveCodexNetworkEnvironment(input, platform, { enabled: true, hasPac: true, proxyOverride: '*' });
    assert.equal(result.diagnostic, 'environment_exceptions');
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) assert.equal(result.env[key], input[key]);
    assert.deepEqual(
      new Set(result.env.NO_PROXY.split(',')),
      new Set(['internal.fixture', 'localhost', '.corp.fixture', '127.0.0.1', 'service.fixture', '::1']),
    );
    assert.equal(result.env.No_Proxy, undefined);
    assert.equal(result.env.no_proxy, platform === 'win32' ? undefined : result.env.NO_PROXY);
    assert.equal(input.No_Proxy, 'service.fixture,::1', 'projection must not mutate its input');
  });
}

for (const env of [{}, { NO_PROXY: '' }, { no_proxy: ' , ' }]) {
  test(`missing/empty exceptions: ${JSON.stringify(env)}`, () => {
    const unix = deriveCodexNetworkEnvironment(env, 'linux');
    assert.equal(unix.env.NO_PROXY, 'localhost,127.0.0.1,::1');
    assert.equal(unix.env.no_proxy, unix.env.NO_PROXY);
    const unknown = deriveCodexNetworkEnvironment(env, 'win32');
    assert.equal(unknown.diagnostic, 'windows_system_proxy_not_read');
    assert.deepEqual(unknown.env, env);
    const failed = deriveCodexNetworkEnvironment(env, 'win32', null);
    assert.deepEqual(failed.env, env);
    assert.equal(failed.diagnostic, 'windows_system_proxy_read_failed');
    const manual = deriveCodexNetworkEnvironment(env, 'win32', {
      enabled: true,
      hasPac: false,
      proxyOverride: '10.0.0.5;127.0.0.2',
    });
    assert.equal(manual.env.NO_PROXY, '10.0.0.5,127.0.0.2,localhost,127.0.0.1,::1');
    const disabled = deriveCodexNetworkEnvironment(env, 'win32', { enabled: false, hasPac: false, proxyOverride: '*' });
    assert.equal(disabled.env.NO_PROXY, unix.env.NO_PROXY);
  });
}

for (const pattern of [
  '<local>',
  '*.corp.fixture',
  '10.0.0.0/8',
  '10.0.0.1-10.0.0.9',
  'api.fixture:8080',
  'https://api.fixture',
  'hyphen-host.fixture',
]) {
  test(`unsupported system pattern preserves original environment: ${pattern}`, () => {
    const input = { HTTPS_PROXY: 'http://proxy.fixture.invalid:3128' };
    const result = deriveCodexNetworkEnvironment(input, 'win32', {
      enabled: true,
      hasPac: false,
      proxyOverride: `valid.fixture;${pattern}`,
    });
    assert.equal(result.diagnostic, 'windows_proxy_override_unsupported');
    assert.deepEqual(result.env, input);
  });
}

test('PAC/WPAD cannot be presented as a static bypass even with the manual proxy disabled', () => {
  for (const enabled of [true, false]) {
    const result = deriveCodexNetworkEnvironment({}, 'win32', {
      enabled,
      hasPac: true,
      proxyOverride: 'internal.fixture',
    });
    assert.equal(result.diagnostic, 'windows_pac_wpad_unsupported');
    assert.deepEqual(result.env, {});
  }
});

test('explicit wildcard is retained, while the implementation never introduces one', () => {
  assert.equal(deriveCodexNetworkEnvironment({ NO_PROXY: '*' }, 'linux').env.NO_PROXY, '*,localhost,127.0.0.1,::1');
});

test('plugin-native complete environments do not inherit ambient credentials or proxy policy', async () => {
  const env = await prepareCodexEnvironment({ HOME: '/fixture', OPENAI_API_KEY: null }, { inheritParentEnv: false });
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.HTTP_PROXY, undefined);
  assert.equal(env.NO_PROXY, undefined);
});

// A plain WinINET hostname is exact; NO_PROXY would also bypass its children.
test('system hostname exceptions cannot be projected as broader domain suffix exceptions', () => {
  const input = { HTTPS_PROXY: 'http://proxy.fixture.invalid:3128' };
  for (const proxyOverride of ['api.corp.fixture', '.corp.fixture', 'singlehost', '10.0.0.5;api.corp.fixture']) {
    const result = deriveCodexNetworkEnvironment(input, 'win32', { enabled: true, hasPac: false, proxyOverride });
    assert.equal(result.diagnostic, 'windows_proxy_override_unsupported');
    assert.deepEqual(result.env, input, 'child.api.corp.fixture must keep its system proxy route');
  }
});
