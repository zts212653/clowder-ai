import assert from 'node:assert/strict';
import { chmodSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

describe('MCP callback tools: agent-key support', () => {
  const savedEnv = {};

  function setEnv(vars) {
    for (const [k, v] of Object.entries(vars)) {
      savedEnv[k] = process.env[k];
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  });

  it('getCallbackConfig returns agent-key config when only CAT_CAFE_AGENT_KEY_SECRET is set', async () => {
    setEnv({
      CAT_CAFE_API_URL: 'http://localhost:3004',
      CAT_CAFE_INVOCATION_ID: undefined,
      CAT_CAFE_CALLBACK_TOKEN: undefined,
      CAT_CAFE_AGENT_KEY_SECRET: 'ak-secret-test',
      CAT_CAFE_AGENT_KEY_FILE: undefined,
      CAT_CAFE_AGENT_KEY_FILES: undefined,
    });
    // Dynamic import to pick up env
    const mod = await import(`../dist/tools/callback-tools.js?t=${Date.now()}`);
    const config = mod.getCallbackConfig();
    assert.ok(config, 'config should not be null');
    assert.equal(config.agentKeySecret, 'ak-secret-test');
    assert.equal(config.invocationId, undefined);
  });

  it('buildAuthHeaders returns x-agent-key-secret when no invocation creds', async () => {
    const mod = await import(`../dist/tools/callback-tools.js?t=${Date.now()}`);
    const headers = mod.buildAuthHeaders({
      apiUrl: 'http://localhost:3004',
      agentKeySecret: 'ak-secret-test',
    });
    assert.equal(headers['x-agent-key-secret'], 'ak-secret-test');
    assert.equal(headers['x-invocation-id'], undefined);
  });

  it('buildAuthHeaders prefers invocation creds over agent-key', async () => {
    const mod = await import(`../dist/tools/callback-tools.js?t=${Date.now()}`);
    const headers = mod.buildAuthHeaders({
      apiUrl: 'http://localhost:3004',
      invocationId: 'inv-1',
      callbackToken: 'tok-1',
      agentKeySecret: 'ak-secret-test',
    });
    assert.equal(headers['x-invocation-id'], 'inv-1');
    assert.equal(headers['x-callback-token'], 'tok-1');
    assert.equal(headers['x-agent-key-secret'], undefined);
  });

  it('getCallbackConfig rejects partial invocation creds (P2 — only invocationId, no token)', async () => {
    setEnv({
      CAT_CAFE_API_URL: 'http://localhost:3004',
      CAT_CAFE_INVOCATION_ID: 'inv-orphan',
      CAT_CAFE_CALLBACK_TOKEN: undefined,
      CAT_CAFE_AGENT_KEY_SECRET: undefined,
      CAT_CAFE_AGENT_KEY_FILE: undefined,
      CAT_CAFE_AGENT_KEY_FILES: undefined,
    });
    const mod = await import(`../dist/tools/callback-tools.js?t=${Date.now()}`);
    const config = mod.getCallbackConfig();
    assert.equal(config, null, 'partial invocation creds (only invocationId) must return null');
  });

  it('getCallbackConfig rejects partial invocation creds (P2 — only token, no invocationId)', async () => {
    setEnv({
      CAT_CAFE_API_URL: 'http://localhost:3004',
      CAT_CAFE_INVOCATION_ID: undefined,
      CAT_CAFE_CALLBACK_TOKEN: 'tok-orphan',
      CAT_CAFE_AGENT_KEY_SECRET: undefined,
      CAT_CAFE_AGENT_KEY_FILE: undefined,
      CAT_CAFE_AGENT_KEY_FILES: undefined,
    });
    const mod = await import(`../dist/tools/callback-tools.js?t=${Date.now()}`);
    const config = mod.getCallbackConfig();
    assert.equal(config, null, 'partial invocation creds (only callbackToken) must return null');
  });

  it('getCallbackConfig accepts partial invocation when agent-key fallback exists', async () => {
    setEnv({
      CAT_CAFE_API_URL: 'http://localhost:3004',
      CAT_CAFE_INVOCATION_ID: 'inv-with-fallback',
      CAT_CAFE_CALLBACK_TOKEN: undefined,
      CAT_CAFE_AGENT_KEY_SECRET: 'ak-fallback',
      CAT_CAFE_AGENT_KEY_FILE: undefined,
      CAT_CAFE_AGENT_KEY_FILES: undefined,
    });
    const mod = await import(`../dist/tools/callback-tools.js?t=${Date.now()}`);
    const config = mod.getCallbackConfig();
    assert.ok(config, 'should return config when agent-key fallback exists');
    assert.equal(config.agentKeySecret, 'ak-fallback');
    assert.equal(config.invocationId, undefined, 'partial invocation should be stripped');
  });

  it('reads secret from CAT_CAFE_AGENT_KEY_FILE when env var not set', async () => {
    const tmpFile = join(tmpdir(), `agent-key-test-${Date.now()}.secret`);
    writeFileSync(tmpFile, 'sidecar-secret-value\n', { mode: 0o600 });
    try {
      setEnv({
        CAT_CAFE_API_URL: 'http://localhost:3004',
        CAT_CAFE_INVOCATION_ID: undefined,
        CAT_CAFE_CALLBACK_TOKEN: undefined,
        CAT_CAFE_AGENT_KEY_SECRET: undefined,
        CAT_CAFE_AGENT_KEY_FILE: tmpFile,
        CAT_CAFE_AGENT_KEY_FILES: undefined,
      });
      const mod = await import(`../dist/tools/callback-tools.js?t=${Date.now()}`);
      const config = mod.getCallbackConfig();
      assert.ok(config, 'config should not be null');
      assert.equal(config.agentKeySecret, 'sidecar-secret-value');
    } finally {
      unlinkSync(tmpFile);
    }
  });

  it('env var CAT_CAFE_AGENT_KEY_SECRET takes precedence over sidecar file', async () => {
    const tmpFile = join(tmpdir(), `agent-key-test-prec-${Date.now()}.secret`);
    writeFileSync(tmpFile, 'file-secret\n', { mode: 0o600 });
    try {
      setEnv({
        CAT_CAFE_API_URL: 'http://localhost:3004',
        CAT_CAFE_INVOCATION_ID: undefined,
        CAT_CAFE_CALLBACK_TOKEN: undefined,
        CAT_CAFE_AGENT_KEY_SECRET: 'env-secret',
        CAT_CAFE_AGENT_KEY_FILE: tmpFile,
        CAT_CAFE_AGENT_KEY_FILES: undefined,
      });
      const mod = await import(`../dist/tools/callback-tools.js?t=${Date.now()}`);
      const config = mod.getCallbackConfig();
      assert.ok(config);
      assert.equal(config.agentKeySecret, 'env-secret');
    } finally {
      unlinkSync(tmpFile);
    }
  });

  it('reads variant-scoped secret from CAT_CAFE_AGENT_KEY_FILES when agentKeyCatId is requested', async () => {
    const antigravityFile = join(tmpdir(), `agent-key-antigravity-${Date.now()}.secret`);
    const antigOpusFile = join(tmpdir(), `agent-key-antig-opus-${Date.now()}.secret`);
    writeFileSync(antigravityFile, 'gemini-secret\n', { mode: 0o600 });
    writeFileSync(antigOpusFile, 'claude-secret\n', { mode: 0o600 });
    try {
      setEnv({
        CAT_CAFE_API_URL: 'http://localhost:3004',
        CAT_CAFE_INVOCATION_ID: undefined,
        CAT_CAFE_CALLBACK_TOKEN: undefined,
        CAT_CAFE_AGENT_KEY_SECRET: undefined,
        CAT_CAFE_AGENT_KEY_FILE: antigravityFile,
        CAT_CAFE_AGENT_KEY_FILES: JSON.stringify({
          antigravity: antigravityFile,
          'antig-opus': antigOpusFile,
        }),
      });
      const mod = await import(`../dist/tools/callback-tools.js?t=${Date.now()}`);
      const config = mod.getCallbackConfig({ agentKeyCatId: 'antig-opus' });
      assert.ok(config);
      assert.equal(config.agentKeySecret, 'claude-secret');
    } finally {
      unlinkSync(antigravityFile);
      unlinkSync(antigOpusFile);
    }
  });

  it('rejects explicit agentKeyCatId when CAT_CAFE_AGENT_KEY_FILES is missing instead of falling back', async () => {
    const defaultFile = join(tmpdir(), `agent-key-default-${Date.now()}.secret`);
    writeFileSync(defaultFile, 'default-secret\n', { mode: 0o600 });
    try {
      setEnv({
        CAT_CAFE_API_URL: 'http://localhost:3004',
        CAT_CAFE_INVOCATION_ID: undefined,
        CAT_CAFE_CALLBACK_TOKEN: undefined,
        CAT_CAFE_AGENT_KEY_SECRET: undefined,
        CAT_CAFE_AGENT_KEY_FILE: defaultFile,
        CAT_CAFE_AGENT_KEY_FILES: undefined,
      });
      const mod = await import(`../dist/tools/callback-tools.js?t=${Date.now()}`);
      const config = mod.getCallbackConfig({ agentKeyCatId: 'antig-opus' });
      assert.equal(config, null, 'explicit variant identity must not fall back to default agent key');
    } finally {
      unlinkSync(defaultFile);
    }
  });

  it('rejects explicit agentKeyCatId when the variant map omits that cat', async () => {
    const defaultFile = join(tmpdir(), `agent-key-default-${Date.now()}.secret`);
    const antigravityFile = join(tmpdir(), `agent-key-antigravity-${Date.now()}.secret`);
    writeFileSync(defaultFile, 'default-secret\n', { mode: 0o600 });
    writeFileSync(antigravityFile, 'gemini-secret\n', { mode: 0o600 });
    try {
      setEnv({
        CAT_CAFE_API_URL: 'http://localhost:3004',
        CAT_CAFE_INVOCATION_ID: undefined,
        CAT_CAFE_CALLBACK_TOKEN: undefined,
        CAT_CAFE_AGENT_KEY_SECRET: undefined,
        CAT_CAFE_AGENT_KEY_FILE: defaultFile,
        CAT_CAFE_AGENT_KEY_FILES: JSON.stringify({ antigravity: antigravityFile }),
      });
      const mod = await import(`../dist/tools/callback-tools.js?t=${Date.now()}`);
      const config = mod.getCallbackConfig({ agentKeyCatId: 'antig-opus' });
      assert.equal(config, null, 'missing requested variant must fail closed');
    } finally {
      unlinkSync(defaultFile);
      unlinkSync(antigravityFile);
    }
  });

  it('rejects explicit agentKeyCatId when CAT_CAFE_AGENT_KEY_FILES is invalid JSON', async () => {
    const defaultFile = join(tmpdir(), `agent-key-default-${Date.now()}.secret`);
    writeFileSync(defaultFile, 'default-secret\n', { mode: 0o600 });
    try {
      setEnv({
        CAT_CAFE_API_URL: 'http://localhost:3004',
        CAT_CAFE_INVOCATION_ID: undefined,
        CAT_CAFE_CALLBACK_TOKEN: undefined,
        CAT_CAFE_AGENT_KEY_SECRET: undefined,
        CAT_CAFE_AGENT_KEY_FILE: defaultFile,
        CAT_CAFE_AGENT_KEY_FILES: '{not-json',
      });
      const mod = await import(`../dist/tools/callback-tools.js?t=${Date.now()}`);
      const config = mod.getCallbackConfig({ agentKeyCatId: 'antig-opus' });
      assert.equal(config, null, 'invalid variant map must fail closed for explicit variant identity');
    } finally {
      unlinkSync(defaultFile);
    }
  });

  it('rejects omitted agentKeyCatId when a shared variant key map exists', async () => {
    const defaultFile = join(tmpdir(), `agent-key-default-${Date.now()}.secret`);
    const antigravityFile = join(tmpdir(), `agent-key-antigravity-${Date.now()}.secret`);
    const antigOpusFile = join(tmpdir(), `agent-key-antig-opus-${Date.now()}.secret`);
    writeFileSync(defaultFile, 'default-secret\n', { mode: 0o600 });
    writeFileSync(antigravityFile, 'gemini-secret\n', { mode: 0o600 });
    writeFileSync(antigOpusFile, 'claude-secret\n', { mode: 0o600 });
    try {
      setEnv({
        CAT_CAFE_API_URL: 'http://localhost:3004',
        CAT_CAFE_INVOCATION_ID: undefined,
        CAT_CAFE_CALLBACK_TOKEN: undefined,
        CAT_CAFE_AGENT_KEY_SECRET: undefined,
        CAT_CAFE_AGENT_KEY_FILE: defaultFile,
        CAT_CAFE_AGENT_KEY_FILES: JSON.stringify({
          antigravity: antigravityFile,
          'antig-opus': antigOpusFile,
        }),
      });
      const mod = await import(`../dist/tools/callback-tools.js?t=${Date.now()}`);
      const config = mod.getCallbackConfig();
      assert.equal(config, null, 'shared Antigravity MCP must require agentKeyCatId instead of using default key');
    } finally {
      unlinkSync(defaultFile);
      unlinkSync(antigravityFile);
      unlinkSync(antigOpusFile);
    }
  });

  it('rejects omitted agentKeyCatId in shared variant mode even when legacy env secret exists', async () => {
    const antigravityFile = join(tmpdir(), `agent-key-antigravity-${Date.now()}.secret`);
    const antigOpusFile = join(tmpdir(), `agent-key-antig-opus-${Date.now()}.secret`);
    writeFileSync(antigravityFile, 'gemini-secret\n', { mode: 0o600 });
    writeFileSync(antigOpusFile, 'claude-secret\n', { mode: 0o600 });
    try {
      setEnv({
        CAT_CAFE_API_URL: 'http://localhost:3004',
        CAT_CAFE_INVOCATION_ID: undefined,
        CAT_CAFE_CALLBACK_TOKEN: undefined,
        CAT_CAFE_AGENT_KEY_SECRET: 'legacy-env-secret',
        CAT_CAFE_AGENT_KEY_FILE: undefined,
        CAT_CAFE_AGENT_KEY_FILES: JSON.stringify({
          antigravity: antigravityFile,
          'antig-opus': antigOpusFile,
        }),
      });
      const mod = await import(`../dist/tools/callback-tools.js?t=${Date.now()}`);
      const config = mod.getCallbackConfig();
      assert.equal(config, null, 'shared variant map must not fall back to a cat-ambiguous legacy secret');
    } finally {
      unlinkSync(antigravityFile);
      unlinkSync(antigOpusFile);
    }
  });
});
