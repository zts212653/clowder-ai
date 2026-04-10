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

  it('snapshot contains all 7 categories', async () => {
    const { collectConfigSnapshot } = await import('../dist/config/ConfigRegistry.js');
    const snapshot = collectConfigSnapshot();

    assert.ok(snapshot.context, 'has context');
    assert.ok(snapshot.cli, 'has cli');
    assert.ok(snapshot.storage, 'has storage');
    assert.ok(snapshot.upload, 'has upload');
    assert.ok(snapshot.server, 'has server');
    assert.ok(snapshot.cats, 'has cats');
    assert.ok(snapshot.a2a, 'has a2a');
  });

  it('uses default values when env vars are missing', async () => {
    setEnv('CONTEXT_HISTORY_LIMIT', undefined);
    setEnv('MAX_CONTEXT_MSG_CHARS', undefined);
    setEnv('MAX_PROMPT_TOKENS', undefined);
    setEnv('CAT_CODEX_SANDBOX_MODE', undefined);
    setEnv('CAT_CODEX_APPROVAL_POLICY', undefined);

    const { collectConfigSnapshot } = await import('../dist/config/ConfigRegistry.js');
    const snapshot = collectConfigSnapshot();

    assert.equal(snapshot.context.maxMessages, 20);
    assert.equal(snapshot.context.maxContentLength, 1500);
    assert.equal(snapshot.context.maxPromptTokens, 32000);
    assert.equal(snapshot.context.maxTotalChars, 8000);
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

  it('reads context env overrides', async () => {
    setEnv('CONTEXT_HISTORY_LIMIT', '50');
    setEnv('MAX_CONTEXT_MSG_CHARS', '3000');
    setEnv('MAX_PROMPT_TOKENS', '64000');

    const { collectConfigSnapshot } = await import('../dist/config/ConfigRegistry.js');
    const snapshot = collectConfigSnapshot();

    assert.equal(snapshot.context.maxMessages, 50);
    assert.equal(snapshot.context.maxContentLength, 3000);
    assert.equal(snapshot.context.maxPromptTokens, 64000);
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

  it('populates cats from CAT_CONFIGS', async () => {
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

  it('has perCatBudgets for all three cats', async () => {
    const { collectConfigSnapshot } = await import('../dist/config/ConfigRegistry.js');
    const snapshot = collectConfigSnapshot();

    assert.ok(snapshot.perCatBudgets, 'has perCatBudgets');
    assert.ok(snapshot.perCatBudgets.opus, 'has opus budget');
    assert.ok(snapshot.perCatBudgets.codex, 'has codex budget');
    assert.ok(snapshot.perCatBudgets.gemini, 'has gemini budget');
  });

  it('perCatBudgets contains all budget fields', async () => {
    const { collectConfigSnapshot } = await import('../dist/config/ConfigRegistry.js');
    const snapshot = collectConfigSnapshot();

    const opusBudget = snapshot.perCatBudgets.opus;
    assert.ok(opusBudget.maxPromptTokens > 0, 'opus has maxPromptTokens');
    assert.ok(opusBudget.maxContextTokens > 0, 'opus has maxContextTokens');
    assert.ok(opusBudget.maxMessages > 0, 'opus has maxMessages');
    assert.ok(opusBudget.maxContentLengthPerMsg > 0, 'opus has maxContentLengthPerMsg');
  });

  it('context section has deprecation note', async () => {
    const { collectConfigSnapshot } = await import('../dist/config/ConfigRegistry.js');
    const snapshot = collectConfigSnapshot();

    assert.ok(snapshot.context.note, 'context has note');
    assert.ok(snapshot.context.note.includes('perCatBudgets'), 'note mentions perCatBudgets');
  });

  it('perCatBudgets reflects different budgets per cat', async () => {
    const { collectConfigSnapshot } = await import('../dist/config/ConfigRegistry.js');
    const snapshot = collectConfigSnapshot();

    // MAX_PROMPT_TOKENS may flatten prompt budgets via env, so compare the
    // cat-specific aggregate context budget that still differs by breed.
    assert.ok(
      snapshot.perCatBudgets.gemini.maxContextTokens > snapshot.perCatBudgets.codex.maxContextTokens,
      'gemini should have higher maxContextTokens than codex',
    );
    assert.ok(
      snapshot.perCatBudgets.codex.maxContextTokens > snapshot.perCatBudgets.opus.maxContextTokens,
      'codex should have higher maxContextTokens than opus',
    );
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
      'context',
      'perCatBudgets',
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
