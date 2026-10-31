/**
 * ConfigRegistry Tests
 * 验证配置快照收集的正确性
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

// Save and restore env vars around tests
const savedEnv = {};
function setEnv(key, value) {
  savedEnv[key] = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
function restoreEnv() {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe('ConfigRegistry', () => {
  afterEach(() => restoreEnv());

  it('snapshot contains runtime categories without legacy context knobs', async () => {
    const { collectConfigSnapshot } = await import('../dist/config/ConfigRegistry.js');
    const snapshot = collectConfigSnapshot();

    assert.equal(snapshot.context, undefined, 'legacy context policy is not public');
    assert.ok(snapshot.cli, 'has cli');
    assert.ok(snapshot.storage, 'has storage');
    assert.ok(snapshot.upload, 'has upload');
    assert.ok(snapshot.server, 'has server');
    assert.ok(snapshot.cats, 'has cats');
    assert.ok(snapshot.a2a, 'has a2a');
  });

  it('does not revive retired context policy from environment variables', async () => {
    setEnv('CONTEXT_HISTORY_LIMIT', undefined);
    setEnv('MAX_CONTEXT_MSG_CHARS', undefined);
    setEnv('MAX_PROMPT_TOKENS', undefined);
    setEnv('CAT_CODEX_SANDBOX_MODE', undefined);
    setEnv('CAT_CODEX_APPROVAL_POLICY', undefined);

    const { collectConfigSnapshot } = await import('../dist/config/ConfigRegistry.js');
    const snapshot = collectConfigSnapshot();

    assert.equal(snapshot.context, undefined);
    assert.equal(snapshot.cli.codexSandboxMode, 'danger-full-access');
    assert.equal(snapshot.cli.codexApprovalPolicy, 'on-request');
  });

  it('reads codex sandbox/approval env overrides', async () => {
    setEnv('CAT_CODEX_SANDBOX_MODE', 'workspace-write');
    setEnv('CAT_CODEX_APPROVAL_POLICY', 'never');

    const { collectConfigSnapshot } = await import('../dist/config/ConfigRegistry.js');
    const snapshot = collectConfigSnapshot();

    assert.equal(snapshot.cli.codexSandboxMode, 'workspace-write');
    assert.equal(snapshot.cli.codexApprovalPolicy, 'never');
  });

  it('ignores retired context env overrides', async () => {
    setEnv('CONTEXT_HISTORY_LIMIT', '50');
    setEnv('MAX_CONTEXT_MSG_CHARS', '3000');
    setEnv('MAX_PROMPT_TOKENS', '64000');

    const { collectConfigSnapshot } = await import('../dist/config/ConfigRegistry.js');
    const snapshot = collectConfigSnapshot();

    assert.equal(snapshot.context, undefined);
  });

  it('shows redis=memory when REDIS_URL not set', async () => {
    setEnv('REDIS_URL', undefined);

    const { collectConfigSnapshot } = await import('../dist/config/ConfigRegistry.js');
    const snapshot = collectConfigSnapshot();

    assert.equal(snapshot.server.redis, 'memory');
  });

  it('shows redis=connected when REDIS_URL is set', async () => {
    setEnv('REDIS_URL', 'redis://localhost:6399');

    const { collectConfigSnapshot } = await import('../dist/config/ConfigRegistry.js');
    const snapshot = collectConfigSnapshot();

    assert.equal(snapshot.server.redis, 'connected');
  });

  it('populates cats from runtime config', async () => {
    const { collectConfigSnapshot } = await import('../dist/config/ConfigRegistry.js');
    const snapshot = collectConfigSnapshot();

    assert.ok(snapshot.cats.opus, 'has opus');
    assert.ok(snapshot.cats.opus.displayName, 'opus has displayName');
    assert.ok(snapshot.cats.opus.clientId, 'opus has clientId');
    assert.ok(snapshot.cats.opus.model, 'opus has model');
    assert.equal(typeof snapshot.cats.opus.mcpSupport, 'boolean', 'opus has mcpSupport');
  });

  it('surfaces co-creator metadata for the hub overview', async () => {
    const { collectConfigSnapshot } = await import('../dist/config/ConfigRegistry.js');
    const snapshot = collectConfigSnapshot();

    assert.ok(snapshot.coCreator, 'has co-creator metadata');
    assert.ok(
      typeof snapshot.coCreator.name === 'string' && snapshot.coCreator.name.length > 0,
      'coCreator.name is a non-empty string',
    );
    assert.ok(Array.isArray(snapshot.coCreator.mentionPatterns), 'coCreator.mentionPatterns is an array');
    assert.equal(snapshot.coCreator.timeZone, 'America/Los_Angeles');
  });

  it('reads MAX_A2A_DEPTH from env', async () => {
    setEnv('MAX_A2A_DEPTH', '5');

    const { collectConfigSnapshot } = await import('../dist/config/ConfigRegistry.js');
    const snapshot = collectConfigSnapshot();

    assert.equal(snapshot.a2a.maxDepth, 5);
  });

  it('defaults a2a.maxDepth to 15', async () => {
    setEnv('MAX_A2A_DEPTH', undefined);

    const { collectConfigSnapshot } = await import('../dist/config/ConfigRegistry.js');
    const snapshot = collectConfigSnapshot();

    assert.equal(snapshot.a2a.maxDepth, 15);
    assert.equal(snapshot.a2a.enabled, true);
  });

  it('has perCatCapacities for all three cats', async () => {
    const { collectConfigSnapshot } = await import('../dist/config/ConfigRegistry.js');
    const snapshot = collectConfigSnapshot();

    assert.ok(snapshot.perCatCapacities, 'has perCatCapacities');
    assert.ok(snapshot.perCatCapacities.opus, 'has opus capacity');
    assert.ok(snapshot.perCatCapacities.codex, 'has codex capacity');
    assert.ok(snapshot.perCatCapacities.gemini, 'has gemini capacity');
  });

  it('perCatCapacities contains provenance but no prompt-policy fields', async () => {
    const { collectConfigSnapshot } = await import('../dist/config/ConfigRegistry.js');
    const snapshot = collectConfigSnapshot();

    const opusCap = snapshot.perCatCapacities.opus;
    // Capacity metadata
    assert.ok(typeof opusCap.inputCeilingTokens === 'number', 'opus has inputCeilingTokens');
    assert.ok(typeof opusCap.source === 'string', 'opus has source');
    assert.ok(typeof opusCap.actionable === 'boolean', 'opus has actionable');
    assert.ok(typeof opusCap.windowTokens === 'number', 'opus has windowTokens');
    assert.ok(typeof opusCap.provenance === 'string', 'opus has provenance');
    assert.equal('confidence' in opusCap, false);
    assert.equal('bindingKey' in opusCap, false);
    assert.equal('fingerprint' in opusCap, false);
    assert.equal('observedAt' in opusCap, false);
    assert.equal('budget' in opusCap, false);
  });

  it('perCatCapacities reflects different capacities per cat', async () => {
    const { collectConfigSnapshot } = await import('../dist/config/ConfigRegistry.js');
    const snapshot = collectConfigSnapshot();

    // Compare inputCeilingTokens across cats — models with larger windows
    // should have higher ceilings (unless manually capped or unresolved).
    const geminiCeil = snapshot.perCatCapacities.gemini?.inputCeilingTokens ?? 0;
    const codexCeil = snapshot.perCatCapacities.codex?.inputCeilingTokens ?? 0;
    const opusCeil = snapshot.perCatCapacities.opus?.inputCeilingTokens ?? 0;
    // At least one should be resolved with a non-zero ceiling
    assert.ok(geminiCeil > 0 || codexCeil > 0 || opusCeil > 0, 'at least one cat should have resolved capacity');
  });

  it('perCatCapacities resolves the same effective model shown for an env-overridden member', async () => {
    setEnv('CAT_CODEX_MODEL', 'o3');

    const { collectConfigSnapshot } = await import('../dist/config/ConfigRegistry.js');
    const snapshot = collectConfigSnapshot();

    assert.equal(snapshot.cats.codex.model, 'o3');
    assert.equal(snapshot.perCatCapacities.codex.windowTokens, 200_000);
    assert.match(snapshot.perCatCapacities.codex.provenance, /Model catalog \(o3\)/);
  });

  it('has memory section (F3-lite)', async () => {
    const { collectConfigSnapshot } = await import('../dist/config/ConfigRegistry.js');
    const snapshot = collectConfigSnapshot();

    assert.ok(snapshot.memory, 'has memory section');
    assert.equal(snapshot.memory.enabled, true);
    assert.equal(snapshot.memory.maxKeysPerThread, 50);
  });

  it('has governance section (4-D-lite)', async () => {
    const { collectConfigSnapshot } = await import('../dist/config/ConfigRegistry.js');
    const snapshot = collectConfigSnapshot();

    assert.ok(snapshot.governance, 'has governance section');
    assert.equal(snapshot.governance.degradationEnabled, true);
    assert.equal(snapshot.governance.doneTimeoutMs, 5 * 60 * 1000);
    assert.equal(snapshot.governance.heartbeatIntervalMs, 30000);
  });

  it('has deliberate section (4-E)', async () => {
    const { collectConfigSnapshot } = await import('../dist/config/ConfigRegistry.js');
    const snapshot = collectConfigSnapshot();

    assert.ok(snapshot.deliberate, 'has deliberate section');
    assert.equal(snapshot.deliberate.status, 'types_only');
  });

  it('snapshot contains all config categories', async () => {
    const { collectConfigSnapshot } = await import('../dist/config/ConfigRegistry.js');
    const snapshot = collectConfigSnapshot();

    const categories = [
      'perCatCapacities',
      'cli',
      'storage',
      'upload',
      'server',
      'cats',
      'a2a',
      'memory',
      'governance',
      'deliberate',
      'codexExecution',
      'ui',
    ];
    for (const cat of categories) {
      assert.ok(snapshot[cat], `has ${cat}`);
    }
    assert.equal(snapshot.hindsight, undefined, 'hindsight section should not exist');
  });

  it('codexExecution defaults are visible for runtime alignment', async () => {
    const { collectConfigSnapshot } = await import('../dist/config/ConfigRegistry.js');
    const snapshot = collectConfigSnapshot();

    assert.equal(snapshot.codexExecution.model, snapshot.cats.codex.model);
    assert.equal(snapshot.codexExecution.authMode, 'oauth');
    assert.equal(snapshot.codexExecution.passModelArg, true);
  });

  it('reads env overrides for codex execution mode', async () => {
    setEnv('CODEX_AUTH_MODE', 'api_key');
    setEnv('CAT_CODEX_PASS_MODEL_ARG', 'false');

    const { collectConfigSnapshot } = await import('../dist/config/ConfigRegistry.js');
    const snapshot = collectConfigSnapshot();

    assert.equal(snapshot.codexExecution.authMode, 'api_key');
    assert.equal(snapshot.codexExecution.passModelArg, false);
  });
});
