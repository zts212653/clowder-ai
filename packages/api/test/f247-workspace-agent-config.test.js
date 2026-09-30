/**
 * F247 Workspace Agent slice 2b tests: config custody (mode-0600 file with
 * env bootstrap fallback, token never projected), refreshable adapter, and
 * versioned-binding reads in the bridge host path.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { CloudInvokeBridge } from '../dist/domains/cats/services/cloud-bridge/cloud-invoke-bridge.js';
import {
  createRefreshableWorkspaceAgentTriggerAdapter,
  createWorkspaceAgentTriggerConfig,
} from '../dist/domains/cats/services/cloud-bridge/workspace-agent/workspace-agent-config.js';
import {
  WorkspaceAgentTriggerError,
  WorkspaceAgentTriggerHttpAdapter,
} from '../dist/domains/cats/services/cloud-bridge/workspace-agent/workspace-agent-trigger-adapter.js';

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function tempProjectRoot() {
  return mkdtempSync(join(tmpdir(), 'f247-wa-config-'));
}

test('config: unconfigured resolves null and projects no token material', () => {
  const root = tempProjectRoot();
  try {
    const config = createWorkspaceAgentTriggerConfig({ projectRoot: root, env: {} });
    assert.equal(config.resolve(), null);
    const projection = config.project();
    assert.equal(projection.enabled, false);
    assert.equal(projection.tokenConfigured, false);
    assert.equal('token' in projection, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('config: env triple bootstraps without a file; partial env stays disabled', () => {
  const root = tempProjectRoot();
  try {
    const full = createWorkspaceAgentTriggerConfig({
      projectRoot: root,
      env: {
        CAT_CAFE_WORKSPACE_AGENT_TRIGGER_ID: 'agtch_env',
        CAT_CAFE_WORKSPACE_AGENT_WORKSPACE_ID: 'ws_env',
        CAT_CAFE_WORKSPACE_AGENT_TOKEN: 'env-secret',
      },
    });
    assert.equal(full.resolve()?.source, 'env');
    assert.equal(full.project().triggerId, 'agtch_env');

    const partial = createWorkspaceAgentTriggerConfig({
      projectRoot: root,
      env: { CAT_CAFE_WORKSPACE_AGENT_TRIGGER_ID: 'agtch_env', CAT_CAFE_WORKSPACE_AGENT_TOKEN: 'env-secret' },
    });
    assert.equal(partial.resolve(), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('config: save persists mode-0600 atomically, projects presence bit, never the token', () => {
  const root = tempProjectRoot();
  try {
    const config = createWorkspaceAgentTriggerConfig({ projectRoot: root, env: {} });
    const projection = config.save({
      triggerId: 'agtch_file',
      workspaceId: 'ws_file',
      token: 'file-secret-value',
    });
    assert.equal(projection.enabled, true);
    assert.equal(projection.tokenConfigured, true);
    assert.equal(projection.source, 'settings');
    assert.equal(JSON.stringify(projection).includes('file-secret-value'), false, 'token must never be projected');

    const mode = statSync(config.configPath).mode & 0o777;
    assert.equal(mode, 0o600, 'config file must be owner-only');
    const persisted = JSON.parse(readFileSync(config.configPath, 'utf-8'));
    assert.equal(persisted.triggerId, 'agtch_file');
    assert.equal(persisted.token, 'file-secret-value');

    // Save without token preserves the stored token (re-auth of other fields).
    config.save({ workspaceId: 'ws_file2' });
    assert.equal(config.resolve()?.workspaceId, 'ws_file2');
    assert.equal(config.resolve()?.token, 'file-secret-value');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('config: disable() keeps the token and re-enable works; file wins over env', () => {
  const root = tempProjectRoot();
  try {
    const config = createWorkspaceAgentTriggerConfig({
      projectRoot: root,
      env: {
        CAT_CAFE_WORKSPACE_AGENT_TRIGGER_ID: 'agtch_env',
        CAT_CAFE_WORKSPACE_AGENT_WORKSPACE_ID: 'ws_env',
        CAT_CAFE_WORKSPACE_AGENT_TOKEN: 'env-secret',
      },
    });
    config.save({ triggerId: 'agtch_file', workspaceId: 'ws_file', token: 'file-secret' });
    const disabled = config.disable();
    assert.equal(disabled.enabled, false);
    // Disabled file suppresses the env bootstrap fallback — explicit off means off.
    assert.equal(config.resolve(), null);
    const reenabled = config.save({ enabled: true });
    assert.equal(reenabled.enabled, true);
    assert.equal(config.resolve()?.token, 'file-secret');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refreshable adapter: reads fresh config per call; unconfigured fails typed', async () => {
  const root = tempProjectRoot();
  try {
    const config = createWorkspaceAgentTriggerConfig({ projectRoot: root, env: {} });
    const adapter = createRefreshableWorkspaceAgentTriggerAdapter(config);
    await assert.rejects(
      adapter.trigger({ input: 'x', conversationKey: 'clowder:w:t', idempotencyKey: 'k' }),
      (err) => err instanceof WorkspaceAgentTriggerError && err.code === 'WORKSPACE_AGENT_INVALID_CONFIG',
    );

    config.save({ triggerId: 'agtch_live', workspaceId: 'ws_live', token: 'tok-live' });
    const seen = [];
    // Patch global fetch for this one call to prove the live config is used.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      seen.push({ url, init });
      return jsonResponse(202, { conversation_url: 'https://chatgpt.com/c/live-1' });
    };
    try {
      const receipt = await adapter.trigger({ input: 'x', conversationKey: 'clowder:w:t', idempotencyKey: 'k' });
      assert.equal(receipt.conversationUrl, 'https://chatgpt.com/c/live-1');
      assert.ok(seen[0].url.includes('/v1/workspace_agents/agtch_live/trigger'));
      assert.equal(seen[0].init.headers.Authorization, 'Bearer tok-live');
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bridge host path: workspace-agent versioned binding reads as needs-binding (no host URL)', async () => {
  const hostCalls = [];
  const bridge = new CloudInvokeBridge({
    hostAdapter: {
      append_message: async (...args) => {
        hostCalls.push(args);
        return { hostMessageId: 'host-1' };
      },
    },
    pinchTabAdapter: null,
    emitFallback: async () => {},
    threadStore: {
      getCloudCatBindings: async () => ({
        'gpt-pro': { v: 1, provider: 'workspace-agent', workspaceId: 'ws_1', triggerId: 'agtch_x' },
      }),
      updateCloudCatBinding: async () => {},
    },
  });
  const outcome = await bridge.dispatch({
    catId: 'gpt-pro',
    threadId: 'thread_1',
    userId: 'user-1',
    threadTitle: null,
    participants: [],
    calledBy: 'zcode',
    intent: 'hello',
    sourceMessageId: 'src-1',
  });
  assert.equal(outcome.kind, 'fallback');
  assert.equal(outcome.reason, 'needs-binding');
  assert.equal(hostCalls.length, 0, 'no host append without a personal-chrome conversation binding');
});

test('bridge host path: legacy string binding still routes through host (read migration)', async () => {
  const hostCalls = [];
  const bridge = new CloudInvokeBridge({
    hostAdapter: {
      append_message: async (...args) => {
        hostCalls.push(args);
        return { hostMessageId: 'host-1' };
      },
    },
    pinchTabAdapter: null,
    emitFallback: async () => {},
    threadStore: {
      getCloudCatBindings: async () => ({ 'gpt-pro': 'https://chatgpt.com/c/legacy-1' }),
      updateCloudCatBinding: async () => {},
    },
  });
  const outcome = await bridge.dispatch({
    catId: 'gpt-pro',
    threadId: 'thread_1',
    userId: 'user-1',
    threadTitle: null,
    participants: [],
    calledBy: 'zcode',
    intent: 'hello',
    sourceMessageId: 'src-1',
  });
  assert.equal(outcome.kind, 'sent');
  assert.equal(outcome.transport, 'host');
  assert.equal(hostCalls.length, 1);
});

test('http adapter: still validates config via constructor (regression guard)', () => {
  const adapter = new WorkspaceAgentTriggerHttpAdapter({ triggerId: 'agtch_x', tokenProvider: () => 't' });
  assert.equal(adapter.triggerId, 'agtch_x');
});

// ── astra round-1 review fixes (R1/R3) ─────────────────────────────────────

import { mkdirSync, writeFileSync } from 'node:fs';

const ENV_TRIPLE = {
  CAT_CAFE_WORKSPACE_AGENT_TRIGGER_ID: 'agtch_env',
  CAT_CAFE_WORKSPACE_AGENT_WORKSPACE_ID: 'ws_env',
  CAT_CAFE_WORKSPACE_AGENT_TOKEN: 'env-secret',
};

test('R1: env-only disable persists a tombstone that survives store restart', () => {
  const root = tempProjectRoot();
  try {
    const first = createWorkspaceAgentTriggerConfig({ projectRoot: root, env: ENV_TRIPLE });
    assert.equal(first.resolve()?.source, 'env');
    const projection = first.disable();
    assert.equal(projection.enabled, false, 'disable must turn off an env-bootstrapped transport');

    // Rebuild the store (process restart) — the persisted tombstone must win.
    const second = createWorkspaceAgentTriggerConfig({ projectRoot: root, env: ENV_TRIPLE });
    assert.equal(second.resolve(), null, 'restart must not resurrect the env bootstrap');
    assert.equal(second.project().enabled, false);
    assert.equal(second.project().source, 'settings');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('R1: corrupt settings file does not resurrect env credentials', () => {
  const root = tempProjectRoot();
  try {
    mkdirSync(join(root, '.cat-cafe'), { recursive: true });
    writeFileSync(join(root, '.cat-cafe', 'workspace-agent.json'), '{ not json !!!', { mode: 0o600 });
    const config = createWorkspaceAgentTriggerConfig({ projectRoot: root, env: ENV_TRIPLE });
    assert.equal(config.resolve(), null, 'corrupt file must suppress env bootstrap');
    const projection = config.project();
    assert.equal(projection.enabled, false);
    assert.deepEqual(projection.invalidConfig, { reason: 'corrupt_file' });
    // Recovery: a full save overwrites the corrupt file and re-enables.
    config.save({ triggerId: 'agtch_new', workspaceId: 'ws_new', token: 't_new' });
    assert.equal(config.resolve()?.triggerId, 'agtch_new');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('R1: schema-invalid persisted record (enabled without token) is invalid, not env-resurrected', () => {
  const root = tempProjectRoot();
  try {
    mkdirSync(join(root, '.cat-cafe'), { recursive: true });
    writeFileSync(
      join(root, '.cat-cafe', 'workspace-agent.json'),
      JSON.stringify({ triggerId: 'agtch_x', workspaceId: 'ws_x', token: '', enabled: true }),
      { mode: 0o600 },
    );
    const config = createWorkspaceAgentTriggerConfig({ projectRoot: root, env: ENV_TRIPLE });
    assert.equal(config.resolve(), null);
    assert.deepEqual(config.project().invalidConfig, { reason: 'schema_invalid' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('R3: persisted workspaceId failing the shared segment constraint is invalid', () => {
  const root = tempProjectRoot();
  try {
    mkdirSync(join(root, '.cat-cafe'), { recursive: true });
    writeFileSync(
      join(root, '.cat-cafe', 'workspace-agent.json'),
      JSON.stringify({ triggerId: 'agtch_x', workspaceId: 'tenant:fixture', token: 't', enabled: true }),
      { mode: 0o600 },
    );
    const config = createWorkspaceAgentTriggerConfig({ projectRoot: root, env: {} });
    assert.equal(config.resolve(), null, 'a saved-but-undispatchable config must not activate');
    assert.deepEqual(config.project().invalidConfig, { reason: 'schema_invalid' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── astra round-2 review fixes (R1 EACCES / R3a env / R3b predicate parity) ─

import { chmodSync } from 'node:fs';

test('R1: unreadable settings dir (EACCES) is invalid, not env-resurrected', () => {
  const root = tempProjectRoot();
  const stateDir = join(root, '.cat-cafe');
  try {
    const first = createWorkspaceAgentTriggerConfig({ projectRoot: root, env: ENV_TRIPLE });
    first.disable(); // persisted tombstone: explicit off
    chmodSync(stateDir, 0o000); // reads now fail with EACCES
    const second = createWorkspaceAgentTriggerConfig({ projectRoot: root, env: ENV_TRIPLE });
    assert.equal(second.resolve(), null, 'permission fault must not resurrect env credentials');
    const projection = second.project();
    assert.equal(projection.enabled, false);
    assert.deepEqual(projection.invalidConfig, { reason: 'unreadable_file' });
  } finally {
    chmodSync(stateDir, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

test('R3a: complete env triple failing the shared constraints is env_invalid, never active', () => {
  const root = tempProjectRoot();
  try {
    const colon = createWorkspaceAgentTriggerConfig({
      projectRoot: root,
      env: { ...ENV_TRIPLE, CAT_CAFE_WORKSPACE_AGENT_WORKSPACE_ID: 'tenant:fixture' },
    });
    assert.equal(colon.resolve(), null);
    assert.deepEqual(colon.project().invalidConfig, { reason: 'env_invalid' });
    assert.equal(colon.project().enabled, false);

    const nul = createWorkspaceAgentTriggerConfig({
      projectRoot: root,
      env: { ...ENV_TRIPLE, CAT_CAFE_WORKSPACE_AGENT_WORKSPACE_ID: 'ws\u0000x' },
    });
    assert.equal(nul.resolve(), null);
    assert.deepEqual(nul.project().invalidConfig, { reason: 'env_invalid' });

    const badTrigger = createWorkspaceAgentTriggerConfig({
      projectRoot: root,
      env: { ...ENV_TRIPLE, CAT_CAFE_WORKSPACE_AGENT_TRIGGER_ID: 'bad trigger' },
    });
    assert.equal(badTrigger.resolve(), null);
    assert.deepEqual(badTrigger.project().invalidConfig, { reason: 'env_invalid' });

    // Partial env stays plain unconfigured (no error state).
    const partial = createWorkspaceAgentTriggerConfig({
      projectRoot: root,
      env: { CAT_CAFE_WORKSPACE_AGENT_TRIGGER_ID: 'agtch_env', CAT_CAFE_WORKSPACE_AGENT_TOKEN: 't' },
    });
    assert.equal(partial.resolve(), null);
    assert.equal(partial.project().invalidConfig, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('R3b: builder, segment guard, and full-key validator agree on every ASCII char', async () => {
  const {
    buildWorkspaceAgentConversationKey,
    isWorkspaceAgentConversationKey,
    isWorkspaceAgentConversationKeySegment,
  } = await import('../dist/domains/cats/services/cloud-bridge/workspace-agent/conversation-key.js');
  const candidates = [];
  for (let code = 0; code <= 0x7f; code += 1) candidates.push(String.fromCharCode(code));
  candidates.push('　', '\u00a0', '\u2028', '', '﻿'); // unicode whitespace + BOM
  for (const character of candidates) {
    const workspaceId = `ws${character}x`;
    let builderThrew = false;
    let built = null;
    try {
      built = buildWorkspaceAgentConversationKey({ workspaceId, threadId: 't' });
    } catch {
      builderThrew = true;
    }
    const guardAccepts = isWorkspaceAgentConversationKeySegment(workspaceId);
    assert.equal(
      builderThrew,
      !guardAccepts,
      `builder/guard disagree on U+${(character.codePointAt(0) || 0).toString(16)}`,
    );
    if (guardAccepts) {
      assert.ok(
        isWorkspaceAgentConversationKey(built),
        `guard accepts but full-key validator rejects U+${(character.codePointAt(0) || 0).toString(16)}`,
      );
    } else {
      assert.ok(built === null);
      // astra round-3 P3: reject-side parity — a segment the predicate
      // rejects must also fail the full-key validator by direct construction.
      assert.ok(
        !isWorkspaceAgentConversationKey(`clowder:${workspaceId}:t`),
        `guard rejects but full-key validator accepts U+${(character.codePointAt(0) || 0).toString(16)}`,
      );
    }
  }
  // Round-trip: every key the builder produces validates.
  const key = buildWorkspaceAgentConversationKey({ workspaceId: 'ws_1', threadId: 'thread_1' });
  assert.ok(isWorkspaceAgentConversationKey(key));
  assert.ok(!isWorkspaceAgentConversationKey('clowder:a:b:c'), 'extra colon segment must fail');
});

test('R3b: save and persisted parse reject NUL workspaceId through the same predicate', () => {
  const root = tempProjectRoot();
  try {
    const config = createWorkspaceAgentTriggerConfig({ projectRoot: root, env: {} });
    assert.throws(
      () => config.save({ triggerId: 'agtch_x', workspaceId: 'ws\u0000x', token: 't' }),
      (err) => err.code === 'WORKSPACE_AGENT_INVALID_CONFIG',
    );
    mkdirSync(join(root, '.cat-cafe'), { recursive: true });
    writeFileSync(
      join(root, '.cat-cafe', 'workspace-agent.json'),
      JSON.stringify({ triggerId: 'agtch_x', workspaceId: 'ws\u0000x', token: 't', enabled: true }),
      { mode: 0o600 },
    );
    const reloaded = createWorkspaceAgentTriggerConfig({ projectRoot: root, env: {} });
    assert.equal(reloaded.resolve(), null);
    assert.deepEqual(reloaded.project().invalidConfig, { reason: 'schema_invalid' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── astra round-4 R2: env bootstrap migration journey ─────────────────────

test('R2: explicit save on an env-bootstrapped config migrates the env token into settings custody', () => {
  const root = tempProjectRoot();
  try {
    const config = createWorkspaceAgentTriggerConfig({ projectRoot: root, env: ENV_TRIPLE });
    assert.equal(config.resolve()?.source, 'env');
    // UI journey: user keeps the token blank because the card says "留空则沿用".
    const saved = config.save({ triggerId: 'agtch_env', workspaceId: 'ws_env' });
    assert.equal(saved.enabled, true);
    assert.equal(saved.source, 'settings');
    assert.equal(JSON.stringify(saved).includes('env-secret'), false, 'token never projected');
    const persisted = JSON.parse(readFileSync(config.configPath, 'utf-8'));
    assert.equal(persisted.token, 'env-secret', 'env token migrated into the 0600 settings file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('R2: disable on an env-bootstrapped config keeps tokenConfigured for re-enable', () => {
  const root = tempProjectRoot();
  try {
    const config = createWorkspaceAgentTriggerConfig({ projectRoot: root, env: ENV_TRIPLE });
    const disabled = config.disable();
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.tokenConfigured, true, 'confirm copy "无需重新粘贴" must hold for env states');
    const reenabled = config.save({ enabled: true });
    assert.equal(reenabled.enabled, true);
    assert.equal(config.resolve()?.triggerId, 'agtch_env');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── astra round-5 R1: inheritance authority state matrix ──────────────────

test('R1: invalid file + complete env + partial save does NOT revive env credentials', () => {
  const root = tempProjectRoot();
  try {
    mkdirSync(join(root, '.cat-cafe'), { recursive: true });
    writeFileSync(join(root, '.cat-cafe', 'workspace-agent.json'), '{ not json !!!', { mode: 0o600 });
    const config = createWorkspaceAgentTriggerConfig({ projectRoot: root, env: ENV_TRIPLE });
    assert.equal(config.resolve(), null);
    assert.throws(
      () => config.save({ enabled: true }),
      (err) => err.code === 'WORKSPACE_AGENT_INVALID_CONFIG',
      'invalid persisted state requires an explicit complete recovery',
    );
    // repeat disable must not import suppressed env credentials either
    const disabled = config.disable();
    assert.equal(disabled.tokenConfigured, false, 'no env credential import through disable');
    assert.equal(disabled.triggerId, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('R1: disabled tombestone does not gain env fields on repeat disable', () => {
  const root = tempProjectRoot();
  try {
    const config = createWorkspaceAgentTriggerConfig({ projectRoot: root, env: ENV_TRIPLE });
    config.disable(); // env active → tombstone captures env (legitimate migration)
    const again = config.disable(); // second disable on the disabled tombstone
    assert.equal(again.tokenConfigured, true, 'first migration preserved');
    const persisted = JSON.parse(readFileSync(config.configPath, 'utf-8'));
    assert.equal(persisted.triggerId, 'agtch_env');
    assert.equal(persisted.enabled, false);
    // and the stored identity is stable across further disables
    const third = config.disable();
    assert.equal(third.triggerId, 'agtch_env');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('R1: disabled empty tombstone + env + save requires complete input (no env revival)', () => {
  const root = tempProjectRoot();
  try {
    // disabled empty tombstone: env suppressed, nothing stored
    mkdirSync(join(root, '.cat-cafe'), { recursive: true });
    writeFileSync(
      join(root, '.cat-cafe', 'workspace-agent.json'),
      JSON.stringify({ triggerId: '', workspaceId: '', token: '', enabled: false }),
      { mode: 0o600 },
    );
    const config = createWorkspaceAgentTriggerConfig({ projectRoot: root, env: ENV_TRIPLE });
    assert.equal(config.resolve(), null);
    assert.throws(
      () => config.save({ triggerId: 'agtch_env', workspaceId: 'ws_env' }),
      (err) => err.code === 'WORKSPACE_AGENT_INVALID_CONFIG',
      'a disabled tombstone must not be filled from suppressed env via save',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
