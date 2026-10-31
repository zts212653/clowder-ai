// @ts-check

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { prepareAcpProcessEnv, tryPrepareAcpProcessEnv } = await import(
  '../../dist/domains/cats/services/agents/providers/acp/acp-spawn-env.js'
);

describe('prepareAcpProcessEnv', () => {
  it('fails fast when a generic ACP api_key account has no API key', () => {
    assert.throws(
      () =>
        prepareAcpProcessEnv({
          clientId: 'acp',
          provider: undefined,
          baseModel: 'deepseek-chat',
          account: {
            id: 'deepseek-key',
            authType: 'api_key',
            envVars: { DEEPSEEK_API_KEY: '${api_key}' },
          },
        }),
      /account "deepseek-key" is configured as api_key but has no API key set/,
    );
  });

  it('ignores provider for generic ACP (clientId=acp) — env-map is account-envVars driven, not BUILTIN_ENV_MAPS[provider]', () => {
    // F161 AC-A5 / KD-1: generic ACP is a transport, not a provider identity. A stale provider
    // (migrated from clientId=opencode, sitting in a pack/runtime catalog, or sent via direct
    // API) must NOT select a BUILTIN_ENV_MAPS[provider] template. Env customization flows ONLY
    // through the account's envVars templates. Locks the invariant at the runtime layer.
    const env = prepareAcpProcessEnv({
      clientId: 'acp',
      provider: 'anthropic', // stale / catalog value — must be ignored for generic ACP
      baseModel: 'kimi-k2',
      account: {
        id: 'moonshot-key',
        authType: 'api_key',
        apiKey: 'sk-moonshot-xyz',
        envVars: { MOONSHOT_API_KEY: '${api_key}' },
      },
    });
    assert.ok(env, 'env should be defined');
    assert.equal(env.MOONSHOT_API_KEY, 'sk-moonshot-xyz', 'account envVars template should resolve');
    assert.equal(env.ANTHROPIC_API_KEY, undefined, 'stale provider must NOT inject BUILTIN_ENV_MAPS[anthropic] key');
    assert.equal(env.ANTHROPIC_BASE_URL, undefined, 'stale provider must NOT inject anthropic base url');
  });

  it('still honors provider for opencode over ACP transport (clientId=opencode is a real carrier)', () => {
    // Guard the other side of the invariant: opencode IS a provider carrier (multi-provider
    // routing), even when running over the ACP transport. Narrowing must not break it.
    const env = prepareAcpProcessEnv({
      clientId: 'opencode',
      provider: 'anthropic',
      baseModel: 'claude-sonnet-4-5',
      account: {
        id: 'anthropic-key',
        authType: 'api_key',
        apiKey: 'sk-ant-xyz',
      },
    });
    assert.ok(env, 'env should be defined');
    assert.equal(
      env.ANTHROPIC_API_KEY,
      'sk-ant-xyz',
      'opencode provider must still select BUILTIN_ENV_MAPS[anthropic]',
    );
  });

  it('preserves literal env vars that contain unsupported shell placeholders', () => {
    const env = prepareAcpProcessEnv({
      clientId: 'acp',
      provider: undefined,
      baseModel: 'deepseek-chat',
      account: {
        id: 'deepseek-key',
        authType: 'api_key',
        apiKey: 'sk-deepseek',
        envVars: {
          DEEPSEEK_API_KEY: '${api_key}',
          HTTPS_PROXY: 'http://${PROXY_HOST}:8080',
        },
      },
    });
    assert.ok(env, 'env should be defined');
    assert.equal(env.DEEPSEEK_API_KEY, 'sk-deepseek');
    assert.equal(env.HTTPS_PROXY, 'http://${PROXY_HOST}:8080');
  });

  it('offers a non-throwing registry sync path for misconfigured api_key accounts', () => {
    const result = tryPrepareAcpProcessEnv({
      clientId: 'acp',
      provider: undefined,
      baseModel: 'deepseek-chat',
      account: {
        id: 'deepseek-key',
        authType: 'api_key',
        envVars: { DEEPSEEK_API_KEY: '${api_key}' },
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.error.message, /account "deepseek-key" is configured as api_key but has no API key set/);
  });
});
