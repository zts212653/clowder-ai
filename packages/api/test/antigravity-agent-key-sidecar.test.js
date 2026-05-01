import assert from 'node:assert/strict';
import { readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

describe('ensureAntigravityAgentKeySidecar', () => {
  test('issues a registry-backed key and writes only the 0600 sidecar path into env', async () => {
    const { AgentKeyRegistry } = await import('../dist/domains/cats/services/agents/agent-key/AgentKeyRegistry.js');
    const { ensureAntigravityAgentKeySidecar } = await import(
      '../dist/domains/cats/services/agents/agent-key/antigravity-agent-key-sidecar.js'
    );

    const dir = join(tmpdir(), `cat-cafe-agent-key-sidecar-${Date.now()}`);
    const filePath = join(dir, 'antigravity.secret');
    const env = {};
    try {
      const registry = new AgentKeyRegistry();
      const result = await ensureAntigravityAgentKeySidecar(registry, { filePath, env });
      const secret = (await readFile(filePath, 'utf-8')).trim();
      const verify = await registry.verify(secret);
      const mode = (await stat(filePath)).mode & 0o777;

      assert.equal(env.CAT_CAFE_AGENT_KEY_FILE, filePath);
      assert.ok(env.CAT_CAFE_AGENT_KEY_FILES, 'variant key file map should be exported');
      assert.equal(env.CAT_CAFE_AGENT_KEY_SECRET, undefined);
      assert.equal(mode, 0o600);
      assert.equal(result.filePath, filePath);
      assert.equal(result.agentKeyFiles.antigravity, filePath);
      assert.equal(verify.ok, true);
      if (verify.ok) {
        assert.equal(verify.record.catId, 'antigravity');
        assert.equal(verify.record.userId, 'default-user');
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('issues separate variant-scoped sidecar keys for Antigravity Gemini and Claude variants', async () => {
    const { AgentKeyRegistry } = await import('../dist/domains/cats/services/agents/agent-key/AgentKeyRegistry.js');
    const { ensureAntigravityAgentKeySidecar } = await import(
      '../dist/domains/cats/services/agents/agent-key/antigravity-agent-key-sidecar.js'
    );

    const dir = join(tmpdir(), `cat-cafe-agent-key-variants-${Date.now()}`);
    const filePath = join(dir, 'antigravity.secret');
    const env = {};
    try {
      const registry = new AgentKeyRegistry();
      const result = await ensureAntigravityAgentKeySidecar(registry, { filePath, env });
      const files = JSON.parse(env.CAT_CAFE_AGENT_KEY_FILES);

      assert.equal(result.agentKeyFiles.antigravity, filePath);
      assert.equal(files.antigravity, filePath);
      assert.ok(files['antig-opus'], 'Claude Antigravity variant needs its own sidecar key file');
      assert.notEqual(files['antig-opus'], filePath);

      const antigOpusSecret = (await readFile(files['antig-opus'], 'utf-8')).trim();
      const verify = await registry.verify(antigOpusSecret);
      assert.equal(verify.ok, true);
      if (verify.ok) {
        assert.equal(verify.record.catId, 'antig-opus');
        assert.equal(verify.record.userId, 'default-user');
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
