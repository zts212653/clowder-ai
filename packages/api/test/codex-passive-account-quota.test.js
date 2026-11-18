import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveByAccountRef } from '../dist/config/account-resolver.js';
import { readAccountStoreSnapshot } from '../dist/config/account-store-snapshot.js';
import { writeCatalogAccount } from '../dist/config/catalog-accounts.js';
import { resolveCodexAccountLaunch } from '../dist/config/codex-account-launch.js';
import { describeCodexManagedLayout, prepareCodexManagedLayout } from '../dist/config/codex-managed-layout.js';
import { observeCodexSessionQuota } from '../dist/config/codex-session-quota.js';
import { readNativeCodexQuota } from '../dist/config/native-codex-quota.js';
import { CodexAgentService } from '../dist/domains/cats/services/agents/providers/CodexAgentService.js';
import { createCodexSessionContextSnapshotResolver } from '../dist/domains/cats/services/agents/providers/codex-session-context-snapshot.js';
import { fakeL0Compiler } from './helpers/fake-l0-compiler.js';

function writeAuthJson(credentialHome, userId, workspaceId, accessToken = `token-${userId}`) {
  const idToken = `x.${Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': {
        chatgpt_user_id: userId,
        chatgpt_account_id: workspaceId,
      },
    }),
  ).toString('base64url')}.x`;
  mkdirSync(credentialHome, { recursive: true });
  writeFileSync(
    join(credentialHome, 'auth.json'),
    JSON.stringify({
      tokens: {
        id_token: idToken,
        access_token: accessToken,
        account_id: workspaceId,
      },
    }),
  );
}

test('extracts passive Codex rate_limits from session rollout and updates managed & native accounts safely', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-passive-quota-'));
  const savedEnv = { ...process.env };
  Object.assign(process.env, {
    HOME: root,
    CAT_CAFE_GLOBAL_CONFIG_ROOT: root,
    CAT_CAFE_DATA_DIR: join(root, 'data'),
  });
  delete process.env.CODEX_HOME;

  try {
    const managedRef = `codex-${randomUUID()}`;
    const layout = prepareCodexManagedLayout(describeCodexManagedLayout(root, managedRef));
    const managedIdentity = { userId: 'user-managed', workspaceId: 'ws-managed' };
    writeAuthJson(layout.credentialHome, managedIdentity.userId, managedIdentity.workspaceId, 'tok-managed');
    writeCatalogAccount(root, managedRef, {
      authType: 'oauth',
      clientId: 'openai',
      displayName: 'Pro 主号',
      codex: { ...layout, identity: managedIdentity },
      quota: {
        owner: { accountRef: managedRef, ...managedIdentity },
        observedAt: Date.parse('2026-11-15T21:01:46.000Z'),
        status: 'ok',
        source: 'codex_official_readonly',
        items: [
          {
            label: '每周使用限额',
            usedPercent: 22,
            percentKind: 'used',
            poolId: 'codex-main',
            resetsAt: '2026-11-20T16:11:10.000Z',
          },
        ],
      },
    });

    const sessionsDir = join(layout.credentialHome, 'sessions', '2026', '11', '16');
    mkdirSync(sessionsDir, { recursive: true });
    const sessionId = '01a1e42c-a41c-7230-9ce6-f537edb7a75a';
    const resetSeconds = Math.trunc(Date.parse('2026-11-20T16:11:10.000Z') / 1000);
    const observedIso = '2026-11-16T12:23:28.391Z';
    const rolloutFile = join(sessionsDir, `rollout-2026-11-16T04-23-28-${sessionId}.jsonl`);
    const turnStartLine = JSON.stringify({
      timestamp: observedIso,
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-unit-1' },
    });
    const firstLine = JSON.stringify({
      timestamp: observedIso,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 48000 },
          model_context_window: 258400,
        },
        rate_limits: {
          limit_id: 'codex',
          primary: { used_percent: 44, window_minutes: 10080, resets_at: resetSeconds },
          secondary: null,
          credits: { has_credits: true, unlimited: false, balance: '60631.7037605000' },
          plan_type: 'promax',
        },
      },
    });
    const firstRollout = `${turnStartLine}\n${firstLine}\n`;
    writeFileSync(rolloutFile, firstRollout);

    const resolveSnapshot = createCodexSessionContextSnapshotResolver({
      sessionsRoot: join(layout.credentialHome, 'sessions'),
    });
    // Without explicit rateLimitsTurnWindows, rateLimits must fail closed to undefined
    const unscopedSnapshot = await resolveSnapshot(sessionId);
    assert.equal(unscopedSnapshot?.contextUsedTokens, 48000);
    assert.equal(unscopedSnapshot?.rateLimits, undefined);

    const snapshot = await resolveSnapshot(sessionId, join(layout.credentialHome, 'sessions'), {
      rateLimitsTurnWindows: [
        {
          sessionId,
          turnId: 'turn-unit-1',
          startByteOffset: 0,
          endByteOffset: Buffer.byteLength(firstRollout, 'utf8'),
          startMs: Date.parse(observedIso) - 1_000,
          endMs: Date.parse(observedIso) + 10_000,
        },
      ],
    });
    assert.ok(snapshot?.rateLimits, 'snapshot should carry rateLimits for matching turn-unit-1 window');
    assert.equal(snapshot.rateLimits.limitId, 'codex');
    assert.equal(snapshot.rateLimits.primary?.usedPercent, 44);
    assert.equal(snapshot.rateLimits.primary?.windowMinutes, 10080);
    assert.equal(snapshot.rateLimits.observedAtMs, Date.parse(observedIso));

    const updated = observeCodexSessionQuota({
      root,
      accountRef: managedRef,
      credentialHome: layout.credentialHome,
      managed: true,
      expectedIdentity: managedIdentity,
      invocationStartedAt: Date.parse(observedIso) - 500,
      rateLimits: snapshot.rateLimits,
    });
    assert.equal(updated, true);

    const stored = readAccountStoreSnapshot(root).resolve(managedRef).account?.quota;
    assert.ok(stored);
    assert.equal(stored.observedAt, Date.parse(observedIso));
    assert.deepEqual(stored.items, [
      {
        label: '每周使用限额',
        usedPercent: 44,
        percentKind: 'used',
        poolId: 'codex-main',
        resetsAt: '2026-11-20T16:11:10.000Z',
      },
    ]);

    // A newer 0% rate_limits frame in the same admitted turn must NOT be skipped for quota
    const zeroIso = '2026-11-16T12:23:29.000Z';
    const zeroLine = JSON.stringify({
      timestamp: zeroIso,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 49000 },
          model_context_window: 258400,
        },
        rate_limits: {
          limit_id: 'codex',
          primary: { used_percent: 0, window_minutes: 10080, resets_at: resetSeconds },
          secondary: null,
        },
      },
    });
    const secondRollout = `${firstRollout}${zeroLine}\n`;
    writeFileSync(rolloutFile, secondRollout);
    const snapshotAfterZero = await resolveSnapshot(sessionId, join(layout.credentialHome, 'sessions'), {
      rateLimitsTurnWindows: [
        {
          sessionId,
          turnId: 'turn-unit-1',
          startByteOffset: 0,
          endByteOffset: Buffer.byteLength(secondRollout, 'utf8'),
          startMs: Date.parse(observedIso) - 1_000,
          endMs: Date.parse(zeroIso) + 10_000,
        },
      ],
    });
    assert.equal(snapshotAfterZero?.rateLimits?.primary?.usedPercent, 0);

    // Refuse missing timestamp or pre-invocation timestamp
    assert.equal(
      observeCodexSessionQuota({
        root,
        accountRef: managedRef,
        credentialHome: layout.credentialHome,
        managed: true,
        expectedIdentity: managedIdentity,
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 12, windowMinutes: 10080, resetsAtSeconds: resetSeconds },
        },
      }),
      false,
    );
    assert.equal(
      observeCodexSessionQuota({
        root,
        accountRef: managedRef,
        credentialHome: layout.credentialHome,
        managed: true,
        expectedIdentity: managedIdentity,
        invocationStartedAt: Date.parse('2026-11-16T12:25:00.000Z'),
        rateLimits: snapshotAfterZero?.rateLimits,
      }),
      false,
    );

    // Refuse stale session observation older than stored reading
    const staleRejected = observeCodexSessionQuota({
      root,
      accountRef: managedRef,
      credentialHome: layout.credentialHome,
      managed: true,
      expectedIdentity: managedIdentity,
      rateLimits: {
        limitId: 'codex',
        observedAtMs: Date.parse('2026-11-16T10:00:00.000Z'),
        primary: { usedPercent: 30, windowMinutes: 10080, resetsAtSeconds: resetSeconds },
      },
    });
    assert.equal(staleRejected, false);
    assert.equal(readAccountStoreSnapshot(root).resolve(managedRef).account?.quota?.items[0]?.usedPercent, 44);

    // Refuse write if auth.json identity changed after launch
    writeAuthJson(layout.credentialHome, 'different-user', 'ws-managed', 'tok-other');
    const changedRejected = observeCodexSessionQuota({
      root,
      accountRef: managedRef,
      credentialHome: layout.credentialHome,
      managed: true,
      expectedIdentity: managedIdentity,
      rateLimits: {
        limitId: 'codex',
        observedAtMs: Date.parse('2026-11-16T12:30:00.000Z'),
        primary: { usedPercent: 50, windowMinutes: 10080, resetsAtSeconds: resetSeconds },
      },
    });
    assert.equal(changedRejected, false);

    // Native default codex account passive update
    const nativeHome = join(root, '.codex');
    const nativeIdentity = { userId: 'user-native', workspaceId: 'ws-native' };
    writeAuthJson(nativeHome, nativeIdentity.userId, nativeIdentity.workspaceId, 'tok-native');
    const nativeUpdated = observeCodexSessionQuota({
      root,
      accountRef: 'codex',
      credentialHome: nativeHome,
      managed: false,
      expectedIdentity: nativeIdentity,
      rateLimits: {
        limitId: 'codex',
        observedAtMs: Date.parse(observedIso),
        primary: { usedPercent: 15, windowMinutes: 300, resetsAtSeconds: resetSeconds },
        secondary: { usedPercent: 60, windowMinutes: 10080, resetsAtSeconds: resetSeconds },
      },
    });
    assert.equal(nativeUpdated, true);
    const nativeStored = readNativeCodexQuota(root, realpathSync(nativeHome), nativeIdentity);
    assert.equal(nativeStored?.items.length, 2);
    assert.equal(nativeStored?.items[0]?.label, '5小时使用限额');
    assert.equal(nativeStored?.items[0]?.usedPercent, 15);
    assert.equal(nativeStored?.items[1]?.label, '每周使用限额');
    assert.equal(nativeStored?.items[1]?.usedPercent, 60);
  } finally {
    process.env = savedEnv;
    rmSync(root, { recursive: true, force: true });
  }
});

test('CodexAgentService isolates shared rollout across A->B switches (zero-usage & no-new-frame) and wires native auto mode', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-service-quota-')));
  const workDir = join(root, 'workspace');
  mkdirSync(workDir, { recursive: true });
  const savedEnv = { ...process.env };
  Object.assign(process.env, {
    HOME: root,
    CAT_CAFE_GLOBAL_CONFIG_ROOT: root,
    CAT_CAFE_DATA_DIR: join(root, 'data'),
  });
  delete process.env.CODEX_HOME;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_API_BASE;

  try {
    const nativeHome = join(root, '.codex');
    const nativeIdentity = { userId: 'u-native-auto', workspaceId: 'ws-native-auto' };
    writeAuthJson(nativeHome, nativeIdentity.userId, nativeIdentity.workspaceId, 'tok-native-auto');

    const refA = `codex-${randomUUID()}`;
    const refB = `codex-${randomUUID()}`;
    const idA = { userId: 'user-a', workspaceId: 'ws-a' };
    const idB = { userId: 'user-b', workspaceId: 'ws-b' };
    const layoutA = prepareCodexManagedLayout(describeCodexManagedLayout(root, refA), root);
    const layoutB = prepareCodexManagedLayout(describeCodexManagedLayout(root, refB), root);
    writeAuthJson(layoutA.credentialHome, idA.userId, idA.workspaceId, 'tok-a');
    writeAuthJson(layoutB.credentialHome, idB.userId, idB.workspaceId, 'tok-b');
    writeCatalogAccount(root, refA, {
      authType: 'oauth',
      clientId: 'openai',
      displayName: 'Account A',
      codex: { ...layoutA, identity: idA },
    });
    writeCatalogAccount(root, refB, {
      authType: 'oauth',
      clientId: 'openai',
      displayName: 'Account B',
      codex: { ...layoutB, identity: idB },
    });

    const resetSeconds = Math.trunc(Date.parse('2026-11-20T16:11:10.000Z') / 1000);
    const sharedSessionsDir = join(nativeHome, 'sessions', '2026', '11', '16');
    mkdirSync(sharedSessionsDir, { recursive: true });
    const sharedSessionId = '01b2f53d-b52d-7341-adf7-a648fec8b86b';
    const rolloutPath = join(sharedSessionsDir, `rollout-2026-11-16T06-00-00-${sharedSessionId}.jsonl`);

    // Universal OAuth accounts sharing the same sessions/ directory via symlink (runs on macOS, Linux CI, Windows)
    const oauthHomeA = join(root, 'oauth-home-a');
    const oauthHomeB = join(root, 'oauth-home-b');
    writeAuthJson(oauthHomeA, idA.userId, idA.workspaceId, 'tok-oauth-a');
    writeAuthJson(oauthHomeB, idB.userId, idB.workspaceId, 'tok-oauth-b');
    const { symlinkSync } = await import('node:fs');
    symlinkSync(join(nativeHome, 'sessions'), join(oauthHomeA, 'sessions'));
    symlinkSync(join(nativeHome, 'sessions'), join(oauthHomeB, 'sessions'));
    const oauthRefA = 'codex-shared-a';
    const oauthRefB = 'codex-shared-b';
    writeCatalogAccount(root, oauthRefA, {
      authType: 'oauth',
      clientId: 'openai',
      displayName: 'Shared OAuth A',
      envVars: { CODEX_HOME: oauthHomeA },
    });
    writeCatalogAccount(root, oauthRefB, {
      authType: 'oauth',
      clientId: 'openai',
      displayName: 'Shared OAuth B',
      envVars: { CODEX_HOME: oauthHomeB },
    });

    const service = new CodexAgentService({
      carrierMode: 'app_server',
      model: 'gpt-5.4',
      cliCommand: process.execPath,
      nativeShellSafetyCheck: false,
      l0CompilerFn: fakeL0Compiler,
    });

    async function drain(iter) {
      const out = [];
      for await (const item of iter) out.push(item);
      return out;
    }

    function appendTurnRollout(filePath, turnId, rateLimits) {
      const existing = (() => {
        try {
          return readFileSync(filePath, 'utf8');
        } catch {
          return '';
        }
      })();
      const nowIso = new Date().toISOString();
      const rows = [
        JSON.stringify({ timestamp: nowIso, type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } }),
        JSON.stringify({
          timestamp: nowIso,
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: { last_token_usage: { input_tokens: 1200 }, model_context_window: 258400 },
            rate_limits: rateLimits,
          },
        }),
        JSON.stringify({ timestamp: nowIso, type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId } }),
      ];
      writeFileSync(filePath, `${existing}${rows.join('\n')}\n`);
    }

    // 1) Account A runs Turn 1 on app_server and emits used_percent = 44 inside turn-1-a
    const launchA = resolveCodexAccountLaunch(resolveByAccountRef(root, oauthRefA), { cwd: workDir });
    await drain(
      service.invoke('turn 1 on A', {
        invocationId: 'inv-turn-1-a',
        workingDirectory: workDir,
        codexAccountLaunch: launchA,
        accountEnv: { CODEX_HOME: oauthHomeA },
        executionAccount: {
          accountRef: oauthRefA,
          authType: 'oauth',
          accountRevision: launchA.accountRevision,
          identity: idA,
        },
        agentCarrierSessionFactory: async () =>
          new MockAppServerWire({
            threadId: sharedSessionId,
            cwd: workDir,
            turnId: 'turn-1-a',
            turnCompletion: { status: 'completed' },
            onTurnStarted: async (_inbox, _threadId, turnId) => {
              appendTurnRollout(rolloutPath, turnId, {
                limit_id: 'codex',
                primary: { used_percent: 44, window_minutes: 10080, resets_at: resetSeconds },
              });
            },
          }),
      }),
    );
    assert.equal(readAccountStoreSnapshot(root).resolve(oauthRefA).account?.quota?.items[0]?.usedPercent, 44);

    // 2) Switch to Account B, resume shared session, but Turn 2 fails before emitting a token_count
    const launchB = resolveCodexAccountLaunch(resolveByAccountRef(root, oauthRefB), { cwd: workDir });
    await drain(
      service.invoke('turn 2 on B failed before token_count', {
        invocationId: 'inv-turn-2-b-fail',
        sessionId: sharedSessionId,
        workingDirectory: workDir,
        codexAccountLaunch: launchB,
        accountEnv: { CODEX_HOME: oauthHomeB },
        executionAccount: {
          accountRef: oauthRefB,
          authType: 'oauth',
          accountRevision: launchB.accountRevision,
          identity: idB,
        },
        agentCarrierSessionFactory: async () =>
          new MockAppServerWire({
            threadId: sharedSessionId,
            cwd: workDir,
            turnId: 'turn-2-b',
            turnCompletion: { status: 'failed', error: { message: 'network interrupted' } },
          }),
      }),
    );
    assert.equal(
      readAccountStoreSnapshot(root).resolve(oauthRefB).account?.quota,
      undefined,
      'Account B must NOT inherit Account A quota when Turn 2 emitted no new token_count',
    );

    // 3) Account B runs Turn 3 on the same shared session and emits used_percent = 0 inside turn-3-b
    await drain(
      service.invoke('turn 3 on B with fresh 0% usage', {
        invocationId: 'inv-turn-3-b-zero',
        sessionId: sharedSessionId,
        workingDirectory: workDir,
        codexAccountLaunch: launchB,
        accountEnv: { CODEX_HOME: oauthHomeB },
        executionAccount: {
          accountRef: oauthRefB,
          authType: 'oauth',
          accountRevision: launchB.accountRevision,
          identity: idB,
        },
        agentCarrierSessionFactory: async () =>
          new MockAppServerWire({
            threadId: sharedSessionId,
            cwd: workDir,
            turnId: 'turn-3-b',
            turnCompletion: { status: 'completed' },
            onTurnStarted: async (_inbox, _threadId, turnId) => {
              appendTurnRollout(rolloutPath, turnId, {
                limit_id: 'codex',
                primary: { used_percent: 0, window_minutes: 10080, resets_at: resetSeconds },
              });
            },
          }),
      }),
    );
    assert.equal(
      readAccountStoreSnapshot(root).resolve(oauthRefB).account?.quota?.items[0]?.usedPercent,
      0,
      'Account B must record its own 0% frame rather than falling back to Account A 44%',
    );
    assert.equal(
      readAccountStoreSnapshot(root).resolve(oauthRefA).account?.quota?.items[0]?.usedPercent,
      44,
      'Account A quota must remain 44%',
    );

    // 4) Synthetic native default codex (authMode === "auto") updates native-codex-quota.json
    const nativeSessionId = '01c3a64e-c63e-7452-bef8-b759afd9c97c';
    const nativeRolloutPath = join(sharedSessionsDir, `rollout-2026-11-16T06-05-00-${nativeSessionId}.jsonl`);
    const launchNative = resolveCodexAccountLaunch(resolveByAccountRef(root, 'codex'), { cwd: workDir });
    assert.equal(launchNative.authMode, 'auto');
    await drain(
      service.invoke('native auto turn', {
        invocationId: 'inv-turn-4-native',
        workingDirectory: workDir,
        codexAccountLaunch: launchNative,
        executionAccount: {
          accountRef: 'codex',
          authType: 'oauth',
          accountRevision: launchNative.accountRevision,
        },
        agentCarrierSessionFactory: async () =>
          new MockAppServerWire({
            threadId: nativeSessionId,
            cwd: workDir,
            turnId: 'turn-4-native',
            turnCompletion: { status: 'completed' },
            onTurnStarted: async (_inbox, _threadId, turnId) => {
              appendTurnRollout(nativeRolloutPath, turnId, {
                limit_id: 'codex',
                primary: { used_percent: 27, window_minutes: 300, resets_at: resetSeconds },
                secondary: { used_percent: 63, window_minutes: 10080, resets_at: resetSeconds },
              });
            },
          }),
      }),
    );
    const nativeQuota = readNativeCodexQuota(root, realpathSync(nativeHome), nativeIdentity);
    assert.equal(nativeQuota?.items[0]?.usedPercent, 27, 'native auto mode should persist 5h window');
    assert.equal(nativeQuota?.items[1]?.usedPercent, 63, 'native auto mode should persist weekly window');

    // 5) Native auto mode MUST NOT record OAuth quota when custom base URL or API key env is active
    const customSessionId = '01d4b75f-d74f-7563-af09-c86ab0ead08d';
    const customRolloutPath = join(sharedSessionsDir, `rollout-2026-11-16T06-06-00-${customSessionId}.jsonl`);
    await drain(
      service.invoke('custom gateway turn', {
        invocationId: 'inv-turn-5-custom',
        workingDirectory: workDir,
        codexAccountLaunch: launchNative,
        accountEnv: { OPENAI_BASE_URL: 'https://gateway.example.test/v1', OPENAI_API_KEY: 'sk-gateway' },
        agentCarrierSessionFactory: async () =>
          new MockAppServerWire({
            threadId: customSessionId,
            cwd: workDir,
            turnId: 'turn-5-custom',
            turnCompletion: { status: 'completed' },
            onTurnStarted: async (_inbox, _threadId, turnId) => {
              appendTurnRollout(customRolloutPath, turnId, {
                limit_id: 'codex',
                primary: { used_percent: 99, window_minutes: 300, resets_at: resetSeconds },
              });
            },
          }),
      }),
    );
    assert.equal(
      readNativeCodexQuota(root, realpathSync(nativeHome), nativeIdentity)?.items[0]?.usedPercent,
      27,
      'custom gateway / API key invocation must not overwrite OAuth native quota',
    );
  } finally {
    process.env = savedEnv;
    rmSync(root, { recursive: true, force: true });
  }
});

class AsyncInbox {
  #values = [];
  #waiters = [];
  #closed = false;

  push(value) {
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.#values.push(value);
  }

  close() {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push({ resolve }));
      },
    };
  }
}

class MockAppServerWire {
  constructor({
    threadId,
    cwd,
    mode = 'turn',
    turnId = 'turn-1',
    turnCompletion = { status: 'completed' },
    onBeforeReply,
    onTurnStarted,
  }) {
    this.threadId = threadId;
    this.cwd = cwd;
    this.mode = mode;
    this.turnId = turnId;
    this.turnCompletion = turnCompletion;
    this.onBeforeReply = onBeforeReply;
    this.onTurnStarted = onTurnStarted;
    this.inbox = new AsyncInbox();
  }

  read() {
    return this.inbox;
  }

  async write(message) {
    await this.onBeforeReply?.(message);
    if (message.method === 'initialize') {
      if (this.mode === 'pre_turn_transport') {
        this.inbox.close();
        return;
      }
      this.inbox.push({ id: message.id, result: { userAgent: 'mock-app-server' } });
      return;
    }
    if (message.method === 'config/read') {
      this.inbox.push({ id: message.id, result: { config: { mcp_servers: {} } } });
      return;
    }
    if (message.method === 'configRequirements/read') {
      this.inbox.push({ id: message.id, result: { requirements: null } });
      return;
    }
    if (message.method === 'account/read') {
      this.inbox.push({ id: message.id, result: { account: { type: 'chatgpt' } } });
      return;
    }
    if (message.method === 'thread/turns/list') {
      const data =
        this.mode === 'active_writer' ? [{ id: 'turn-old-a', status: 'inProgress', startedAt: 1_786_630_000 }] : [];
      this.inbox.push({ id: message.id, result: { data, nextCursor: null } });
      return;
    }
    if (message.method === 'thread/read') {
      this.inbox.push({
        id: message.id,
        result: {
          thread: {
            id: this.threadId,
            cwd: this.cwd,
            ...(this.mode === 'active_writer'
              ? {
                  status: { type: 'active', activeFlags: [] },
                  turns: [{ id: 'turn-old-a', status: 'inProgress', startedAt: 1_786_630_000, items: [] }],
                }
              : { turns: [] }),
          },
        },
      });
      return;
    }
    if (message.method === 'thread/resume' || message.method === 'thread/start') {
      if (this.mode === 'active_writer') {
        this.inbox.push({
          id: message.id,
          error: { code: -32600, message: `thread ${this.threadId} already has an active writer` },
        });
        return;
      }
      const id = message.method === 'thread/resume' ? message.params.threadId : this.threadId;
      this.inbox.push({ id: message.id, result: { thread: { id, turns: [] } } });
      return;
    }
    if (message.method === 'turn/start') {
      this.inbox.push({ id: message.id, result: { turn: { id: this.turnId, status: 'inProgress', items: [] } } });
      setImmediate(async () => {
        await this.onTurnStarted?.(this.inbox, message.params.threadId, this.turnId);
        this.inbox.push({
          method: 'turn/completed',
          params: {
            threadId: message.params.threadId,
            turn: { id: this.turnId, ...this.turnCompletion, items: [] },
          },
        });
      });
    }
  }

  rememberSession() {}

  async close() {
    this.inbox.close();
  }
}

test('binds passive quota strictly to admitted turns across interleaved writers and app_server wait/retry branches', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-turn-provenance-')));
  const workDir = join(root, 'workspace');
  mkdirSync(workDir, { recursive: true });
  const savedEnv = { ...process.env };
  Object.assign(process.env, {
    HOME: root,
    CAT_CAFE_GLOBAL_CONFIG_ROOT: root,
    CAT_CAFE_DATA_DIR: join(root, 'data'),
  });
  delete process.env.CODEX_HOME;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_API_BASE;

  try {
    const sharedRoot = join(root, 'shared-codex');
    const sharedSessionsDir = join(sharedRoot, 'sessions', '2026', '11', '16');
    mkdirSync(sharedSessionsDir, { recursive: true });
    const sharedSessionId = '01e5c86a-e85a-7674-bf1a-d97bc1fbe19e';
    const rolloutPath = join(sharedSessionsDir, `rollout-2026-11-16T07-00-00-${sharedSessionId}.jsonl`);
    writeFileSync(
      rolloutPath,
      `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: { id: sharedSessionId } })}\n`,
    );

    const idA = { userId: 'writer-a', workspaceId: 'ws-shared' };
    const idB = { userId: 'writer-b', workspaceId: 'ws-shared' };
    const homeA = join(root, 'home-a');
    const homeB = join(root, 'home-b');
    writeAuthJson(homeA, idA.userId, idA.workspaceId, 'tok-writer-a');
    writeAuthJson(homeB, idB.userId, idB.workspaceId, 'tok-writer-b');
    const { symlinkSync } = await import('node:fs');
    symlinkSync(join(sharedRoot, 'sessions'), join(homeA, 'sessions'));
    symlinkSync(join(sharedRoot, 'sessions'), join(homeB, 'sessions'));

    const refA = 'codex-writer-a';
    const refB = 'codex-writer-b';
    writeCatalogAccount(root, refA, {
      authType: 'oauth',
      clientId: 'openai',
      displayName: 'Writer A',
      envVars: { CODEX_HOME: homeA },
    });
    writeCatalogAccount(root, refB, {
      authType: 'oauth',
      clientId: 'openai',
      displayName: 'Writer B',
      envVars: { CODEX_HOME: homeB },
    });

    const resetSeconds = Math.trunc(Date.parse('2026-11-20T16:11:10.000Z') / 1000);
    const appendRolloutSample = (usedPercent, turnId) => {
      const prefix = turnId
        ? `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } })}\n`
        : '';
      const sample = JSON.stringify({
        timestamp: new Date().toISOString(),
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { last_token_usage: { input_tokens: 1500 }, model_context_window: 258400 },
          rate_limits: {
            limit_id: 'codex',
            primary: { used_percent: usedPercent, window_minutes: 10080, resets_at: resetSeconds },
          },
        },
      });
      const suffix = turnId
        ? `\n${JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId } })}`
        : '';
      writeFileSync(rolloutPath, `${readFileSync(rolloutPath, 'utf8')}${prefix}${sample}${suffix}\n`);
    };

    async function drain(iter) {
      const out = [];
      for await (const item of iter) out.push(item);
      return out;
    }

    const launchB = resolveCodexAccountLaunch(resolveByAccountRef(root, refB), { cwd: workDir });

    // Case 1 (Interleaved exec_json repro): B freezes launch & pre-launch bytes first, then finishing A appends 44%, and B fails with 0 samples
    const execService = new CodexAgentService({
      model: 'gpt-5.4',
      cliCommand: process.execPath,
      nativeShellSafetyCheck: false,
      l0CompilerFn: fakeL0Compiler,
    });
    await drain(
      execService.invoke('interleaved B fails before reading', {
        sessionId: sharedSessionId,
        workingDirectory: workDir,
        carrierOverride: 'exec_json',
        codexAccountLaunch: launchB,
        accountEnv: { CODEX_HOME: homeB },
        executionAccount: {
          accountRef: refB,
          authType: 'oauth',
          accountRevision: launchB.accountRevision,
          identity: idB,
        },
        spawnCliOverride: async function* () {
          // Writer A finishes and appends used=44 AFTER B already started its invocation
          appendRolloutSample(44);
          yield { type: 'thread.started', thread_id: sharedSessionId };
          yield { type: 'turn.started' };
          yield { __cliError: true, exitCode: 1, message: 'failed before receiving model reading' };
        },
      }),
    );
    assert.equal(
      readAccountStoreSnapshot(root).resolve(refB).account?.quota,
      undefined,
      'exec_json: B must NOT inherit A sample appended after B invocation started when B failed before reading',
    );

    // Case 2 (app_server active_writer_retry): A appends 44% while B waits on active_writer_retry, then B turn fails or completes with 0 samples
    const appService = new CodexAgentService({
      carrierMode: 'app_server',
      model: 'gpt-5.4',
      cliCommand: process.execPath,
      nativeShellSafetyCheck: false,
      l0CompilerFn: fakeL0Compiler,
    });

    let writerRetryCall = 0;
    const retryEvents = await drain(
      appService.invoke('B waits on active writer A then fails without samples', {
        invocationId: 'inv-b-active-writer-fail',
        sessionId: sharedSessionId,
        workingDirectory: workDir,
        codexAccountLaunch: launchB,
        accountEnv: { CODEX_HOME: homeB },
        executionAccount: {
          accountRef: refB,
          authType: 'oauth',
          accountRevision: launchB.accountRevision,
          identity: idB,
        },
        agentCarrierSessionFactory: async () => {
          writerRetryCall += 1;
          if (writerRetryCall === 1) {
            return new MockAppServerWire({
              threadId: sharedSessionId,
              cwd: workDir,
              mode: 'active_writer',
              onBeforeReply: async (msg) => {
                if (msg.method === 'thread/resume') {
                  // Old writer A appends 44% while B is blocked on active writer!
                  appendRolloutSample(44, 'turn-old-a');
                }
              },
            });
          }
          return new MockAppServerWire({
            threadId: sharedSessionId,
            cwd: workDir,
            turnId: 'turn-b-failed',
            turnCompletion: { status: 'failed', error: { message: 'upstream disconnected before reading' } },
          });
        },
      }),
    );
    assert.equal(
      retryEvents.some((e) => e.metadata?.diagnostics?.appServerRecovery?.reason === 'active_writer_retry'),
      true,
      'active_writer_retry should be exercised',
    );
    assert.equal(
      readAccountStoreSnapshot(root).resolve(refB).account?.quota,
      undefined,
      'app_server active_writer_retry: B must NOT inherit A sample written during active_writer_retry wait',
    );

    // Case 3 (app_server active_writer_retry + B completes with 0 rollout samples): still must NOT claim A sample written during wait
    let writerRetryCompleteCall = 0;
    await drain(
      appService.invoke('B waits on active writer A then completes with 0 samples', {
        invocationId: 'inv-b-active-writer-empty-complete',
        sessionId: sharedSessionId,
        workingDirectory: workDir,
        codexAccountLaunch: launchB,
        accountEnv: { CODEX_HOME: homeB },
        executionAccount: {
          accountRef: refB,
          authType: 'oauth',
          accountRevision: launchB.accountRevision,
          identity: idB,
        },
        agentCarrierSessionFactory: async () => {
          writerRetryCompleteCall += 1;
          if (writerRetryCompleteCall === 1) {
            return new MockAppServerWire({
              threadId: sharedSessionId,
              cwd: workDir,
              mode: 'active_writer',
              onBeforeReply: async (msg) => {
                if (msg.method === 'thread/resume') appendRolloutSample(49);
              },
            });
          }
          return new MockAppServerWire({
            threadId: sharedSessionId,
            cwd: workDir,
            turnId: 'turn-b-empty-ok',
            turnCompletion: { status: 'completed' },
          });
        },
      }),
    );
    assert.equal(
      readAccountStoreSnapshot(root).resolve(refB).account?.quota,
      undefined,
      'app_server active_writer_retry: B completing with 0 samples must NOT claim A sample written before B turn/start',
    );

    // Case 4 (app_server pre_turn_transport + model_capacity wait branches): A writes during pre-turn and capacity waits
    let multiBranchCall = 0;
    await drain(
      appService.invoke('B hits pre_turn_transport and model_capacity waits', {
        invocationId: 'inv-b-capacity-wait',
        sessionId: sharedSessionId,
        workingDirectory: workDir,
        codexAccountLaunch: launchB,
        accountEnv: { CODEX_HOME: homeB },
        executionAccount: {
          accountRef: refB,
          authType: 'oauth',
          accountRevision: launchB.accountRevision,
          identity: idB,
        },
        recoveryAnchor: {
          threadId: 'cat-thread-b',
          invocationId: 'inv-b-capacity-wait',
          promptMessageIds: ['msg-1'],
        },
        agentCarrierSessionFactory: async () => {
          multiBranchCall += 1;
          if (multiBranchCall === 1) {
            appendRolloutSample(52);
            return new MockAppServerWire({ threadId: sharedSessionId, cwd: workDir, mode: 'pre_turn_transport' });
          }
          if (multiBranchCall === 2) {
            return new MockAppServerWire({
              threadId: sharedSessionId,
              cwd: workDir,
              turnId: 'turn-b-cap-1',
              turnCompletion: {
                status: 'failed',
                error: { message: 'Selected model is at capacity. Please try a different model.' },
              },
            });
          }
          // During the model_capacity backoff sleep before Attempt 3 connects, A writes 58%!
          appendRolloutSample(58);
          return new MockAppServerWire({
            threadId: sharedSessionId,
            cwd: workDir,
            turnId: 'turn-b-cap-2',
            turnCompletion: { status: 'failed', error: { message: 'aborted before reading' } },
          });
        },
      }),
    );
    assert.equal(
      readAccountStoreSnapshot(root).resolve(refB).account?.quota,
      undefined,
      'app_server pre_turn_transport + model_capacity waits: samples written outside B admitted turns must be skipped',
    );

    // Case 5 (Positive + foreign turn_id exclusion): B waits on A (44%), then B admitted turn writes B own 12% while foreign turn-a writes 88%
    let positiveCall = 0;
    await drain(
      appService.invoke('B waits on A then emits own 12% sample', {
        invocationId: 'inv-b-admitted-ok',
        sessionId: sharedSessionId,
        workingDirectory: workDir,
        codexAccountLaunch: launchB,
        accountEnv: { CODEX_HOME: homeB },
        executionAccount: {
          accountRef: refB,
          authType: 'oauth',
          accountRevision: launchB.accountRevision,
          identity: idB,
        },
        agentCarrierSessionFactory: async () => {
          positiveCall += 1;
          if (positiveCall === 1) {
            return new MockAppServerWire({
              threadId: sharedSessionId,
              cwd: workDir,
              mode: 'active_writer',
              onBeforeReply: async (msg) => {
                if (msg.method === 'thread/resume') appendRolloutSample(44, 'turn-old-a');
              },
            });
          }
          return new MockAppServerWire({
            threadId: sharedSessionId,
            cwd: workDir,
            turnId: 'turn-b-admitted',
            turnCompletion: { status: 'completed' },
            onTurnStarted: async (inbox, threadId, turnId) => {
              appendRolloutSample(12, turnId);
              // Foreign turn_id sample AND un-enveloped sample even inside byte/time window must not override B!
              appendRolloutSample(88, 'turn-foreign-intruder');
              appendRolloutSample(77);
              inbox.push({
                method: 'thread/tokenUsage/updated',
                params: {
                  threadId,
                  turnId,
                  tokenUsage: { last: { inputTokens: 1500, outputTokens: 60 } },
                },
              });
            },
          });
        },
      }),
    );
    const storedB = readAccountStoreSnapshot(root).resolve(refB).account?.quota;
    assert.equal(storedB?.owner?.userId, 'writer-b');
    assert.equal(
      storedB?.items[0]?.usedPercent,
      12,
      'B must record its own admitted turn 12% sample and ignore both pre-turn 44% and foreign turn_id 88%',
    );
  } finally {
    process.env = savedEnv;
    rmSync(root, { recursive: true, force: true });
  }
});

test('skips passive quota when exec_json stdout lacks turn_id even if B completes normally after A wrote turn-A sample', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-exec-no-turnid-')));
  const workDir = join(root, 'workspace');
  mkdirSync(workDir, { recursive: true });
  const savedEnv = { ...process.env };
  Object.assign(process.env, {
    HOME: root,
    CAT_CAFE_GLOBAL_CONFIG_ROOT: root,
    CAT_CAFE_DATA_DIR: join(root, 'data'),
  });
  delete process.env.CODEX_HOME;

  try {
    const sharedRoot = join(root, 'shared-codex');
    const sharedSessionsDir = join(sharedRoot, 'sessions', '2026', '11', '16');
    mkdirSync(sharedSessionsDir, { recursive: true });
    const sharedSessionId = '01f6d97b-f96b-7785-bf2b-ea8cd2acf2af';
    const rolloutPath = join(sharedSessionsDir, `rollout-2026-11-16T08-00-00-${sharedSessionId}.jsonl`);
    writeFileSync(
      rolloutPath,
      `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: { id: sharedSessionId } })}\n`,
    );

    const idA = { userId: 'exec-writer-a', workspaceId: 'ws-exec' };
    const idB = { userId: 'exec-writer-b', workspaceId: 'ws-exec' };
    const homeA = join(root, 'exec-home-a');
    const homeB = join(root, 'exec-home-b');
    writeAuthJson(homeA, idA.userId, idA.workspaceId, 'tok-exec-a');
    writeAuthJson(homeB, idB.userId, idB.workspaceId, 'tok-exec-b');
    const { symlinkSync } = await import('node:fs');
    symlinkSync(join(sharedRoot, 'sessions'), join(homeA, 'sessions'));
    symlinkSync(join(sharedRoot, 'sessions'), join(homeB, 'sessions'));

    writeCatalogAccount(root, 'codex-exec-a', {
      authType: 'oauth',
      clientId: 'openai',
      displayName: 'Exec Writer A',
      envVars: { CODEX_HOME: homeA },
    });
    writeCatalogAccount(root, 'codex-exec-b', {
      authType: 'oauth',
      clientId: 'openai',
      displayName: 'Exec Writer B',
      envVars: { CODEX_HOME: homeB },
    });

    const resetSeconds = Math.trunc(Date.parse('2026-11-20T16:11:10.000Z') / 1000);
    const launchB = resolveCodexAccountLaunch(resolveByAccountRef(root, 'codex-exec-b'), { cwd: workDir });
    const execService = new CodexAgentService({
      model: 'gpt-5.4',
      cliCommand: process.execPath,
      nativeShellSafetyCheck: false,
      l0CompilerFn: fakeL0Compiler,
    });

    const out = [];
    for await (const msg of execService.invoke('B completes normally on exec_json with rate_limits=null', {
      sessionId: sharedSessionId,
      workingDirectory: workDir,
      carrierOverride: 'exec_json',
      codexAccountLaunch: launchB,
      accountEnv: { CODEX_HOME: homeB },
      executionAccount: {
        accountRef: 'codex-exec-b',
        authType: 'oauth',
        accountRevision: launchB.accountRevision,
        identity: idB,
      },
      spawnCliOverride: async function* () {
        const nowIso = () => new Date().toISOString();
        const lines = [
          // Writer A finishes turn-A with 44% after B spawned
          JSON.stringify({
            timestamp: nowIso(),
            type: 'event_msg',
            payload: { type: 'task_started', turn_id: 'turn-A' },
          }),
          JSON.stringify({
            timestamp: nowIso(),
            type: 'event_msg',
            payload: {
              type: 'token_count',
              info: { last_token_usage: { input_tokens: 1100 }, model_context_window: 258400 },
              rate_limits: {
                limit_id: 'codex',
                primary: { used_percent: 44, window_minutes: 10080, resets_at: resetSeconds },
              },
            },
          }),
          JSON.stringify({
            timestamp: nowIso(),
            type: 'event_msg',
            payload: { type: 'task_complete', turn_id: 'turn-A' },
          }),
          // Writer B runs turn-B normally, but its own token_count has rate_limits: null
          JSON.stringify({
            timestamp: nowIso(),
            type: 'event_msg',
            payload: { type: 'task_started', turn_id: 'turn-B' },
          }),
          JSON.stringify({
            timestamp: nowIso(),
            type: 'event_msg',
            payload: {
              type: 'token_count',
              info: { last_token_usage: { input_tokens: 1400 }, model_context_window: 258400 },
              rate_limits: null,
            },
          }),
          JSON.stringify({
            timestamp: nowIso(),
            type: 'event_msg',
            payload: { type: 'task_complete', turn_id: 'turn-B' },
          }),
        ];
        writeFileSync(rolloutPath, `${readFileSync(rolloutPath, 'utf8')}${lines.join('\n')}\n`);
        // Authentic exec --json stdout shape (no turn_id on stdout events)
        yield { type: 'thread.started', thread_id: sharedSessionId };
        yield { type: 'turn.started' };
        yield { type: 'turn.completed', usage: { input_tokens: 1400, output_tokens: 55 } };
      },
    })) {
      out.push(msg);
    }

    assert.equal(
      readAccountStoreSnapshot(root).resolve('codex-exec-b').account?.quota,
      undefined,
      'B completing normally without stdout turn_id and with rate_limits=null must NOT claim turn-A 44%',
    );
  } finally {
    process.env = savedEnv;
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails closed when tail truncation drops enclosing turn_id marker for a foreign turn sample', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-tail-truncation-')));
  try {
    const sessionsDir = join(root, 'sessions', '2026', '11', '16');
    mkdirSync(sessionsDir, { recursive: true });
    const sessionId = '01a7e08c-a08c-7896-bf3c-fb9de3bd03b0';
    const rolloutFile = join(sessionsDir, `rollout-2026-11-16T08-10-00-${sessionId}.jsonl`);
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const resetSeconds = Math.trunc((nowMs + 86_400_000) / 1000);

    // Put turn-A start marker followed by >600 bytes of padding so 512B tail slice drops task_started(turn-A)
    const lines = [
      JSON.stringify({ timestamp: nowIso, type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-A' } }),
      JSON.stringify({
        timestamp: nowIso,
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: 'x'.repeat(700) },
      }),
      JSON.stringify({
        timestamp: nowIso,
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { last_token_usage: { input_tokens: 2100 }, model_context_window: 258400 },
          rate_limits: {
            limit_id: 'codex',
            primary: { used_percent: 44, window_minutes: 10080, resets_at: resetSeconds },
          },
        },
      }),
    ];
    const content = `${lines.join('\n')}\n`;
    writeFileSync(rolloutFile, content);
    const totalBytes = Buffer.byteLength(content, 'utf8');

    // Simulate default 256KiB tail truncation using 512B tailBytes on the exact production resolver
    const resolveTruncated = createCodexSessionContextSnapshotResolver({
      sessionsRoot: join(root, 'sessions'),
      tailBytes: 512,
    });
    const snapshot = await resolveTruncated(sessionId, join(root, 'sessions'), {
      rateLimitsTurnWindows: [
        {
          sessionId,
          turnId: 'turn-B',
          startByteOffset: 0,
          endByteOffset: totalBytes,
          startMs: nowMs - 5_000,
          endMs: nowMs + 5_000,
        },
      ],
    });

    assert.equal(snapshot?.contextUsedTokens, 2100, 'context token snapshot remains readable');
    assert.equal(
      snapshot?.rateLimits,
      undefined,
      'sample whose enclosing turn_id was truncated outside tail must NOT match target turn-B',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
