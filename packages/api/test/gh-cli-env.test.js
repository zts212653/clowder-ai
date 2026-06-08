import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { buildGhCliEnv, resolveGhCliToken } = await import('../dist/infrastructure/github/gh-cli-env.js');

describe('buildGhCliEnv', () => {
  it('strips ambient GitHub token env when no explicit token is provided', () => {
    const env = buildGhCliEnv({
      baseEnv: {
        GITHUB_TOKEN: 'ambient-token',
        GH_TOKEN: 'ambient-gh-token',
        KEEP_ME: '1',
      },
    });

    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.KEEP_ME, '1');
  });

  it('passes only the explicit token to the gh child env', () => {
    const env = buildGhCliEnv({
      token: ' explicit-token ',
      baseEnv: {
        GITHUB_TOKEN: 'ambient-token',
        GH_TOKEN: 'ambient-gh-token',
      },
    });

    assert.equal(env.GITHUB_TOKEN, 'explicit-token');
    assert.equal(env.GH_TOKEN, undefined);
  });

  it('treats an empty explicit token as absent', () => {
    const env = buildGhCliEnv({
      token: '   ',
      baseEnv: {
        GITHUB_TOKEN: 'ambient-token',
        GH_TOKEN: 'ambient-gh-token',
      },
    });

    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.GH_TOKEN, undefined);
  });

  it('resolves plugin GITHUB_TOKEN before process env tokens', () => {
    const token = resolveGhCliToken({
      pluginEnv: { GITHUB_TOKEN: ' plugin-token ' },
      baseEnv: {
        GITHUB_TOKEN: 'ambient-github-token',
        GH_TOKEN: 'ambient-gh-token',
      },
    });

    assert.equal(token, 'plugin-token');
  });

  it('resolves GH_TOKEN when no plugin or GITHUB_TOKEN value exists', () => {
    const token = resolveGhCliToken({
      pluginEnv: {},
      baseEnv: {
        GH_TOKEN: ' ambient-gh-token ',
      },
    });

    assert.equal(token, 'ambient-gh-token');
  });

  it('keeps GH_TOKEN precedence over GITHUB_TOKEN in process env fallback', () => {
    const token = resolveGhCliToken({
      pluginEnv: {},
      baseEnv: {
        GITHUB_TOKEN: ' ambient-github-token ',
        GH_TOKEN: 'ambient-gh-token',
      },
    });

    assert.equal(token, 'ambient-gh-token');
  });

  it('explicit plugin token tombstone suppresses process env token fallback', () => {
    const token = resolveGhCliToken({
      pluginEnv: { GITHUB_TOKEN: undefined },
      baseEnv: {
        GITHUB_TOKEN: 'ambient-github-token',
        GH_TOKEN: 'ambient-gh-token',
      },
    });

    assert.equal(token, undefined);
  });

  it('normalizes resolved GH_TOKEN into the isolated gh child env', () => {
    const baseEnv = { GH_TOKEN: ' ambient-gh-token ' };
    const env = buildGhCliEnv({
      token: resolveGhCliToken({ pluginEnv: {}, baseEnv }),
      baseEnv,
    });

    assert.equal(env.GITHUB_TOKEN, 'ambient-gh-token');
    assert.equal(env.GH_TOKEN, undefined);
  });
});
