// F257 approval executor route tests — auth gates, gate-error mapping, happy paths.
// Route-level unit tests: fake store + injected session (bootstrap integration for
// the store itself lives in hook-override-store.test.js).
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import Fastify from 'fastify';

import { OverrideGateError } from '../dist/domains/prompt-hooks/HookOverrideStore.js';
import { promptInjectionOverrideRoutes } from '../dist/routes/prompt-injection-overrides.js';
import { validateCanonicalVersionContent } from '../dist/routes/prompt-injection-version-content.js';

const OWNER = 'test-owner';

function createFakeStore() {
  const calls = [];
  const overrides = new Map();
  const versions = new Map();
  return {
    calls,
    overrides,
    async enable(hookId, actorId, opts) {
      calls.push({ method: 'enable', hookId, actorId, opts });
      overrides.set(hookId, { hookId, enabled: true, enabledSource: opts?.source });
    },
    async disable(hookId, actorId, opts) {
      if (hookId === 's1-immutable') {
        throw new OverrideGateError(hookId, 'disable', 'disableable', false);
      }
      if (hookId === 'no-such-hook') {
        throw new OverrideGateError(hookId, 'disable', 'unknown-hook', 'missing');
      }
      calls.push({ method: 'disable', hookId, actorId, opts });
      overrides.set(hookId, { hookId, enabled: false, enabledSource: opts?.source });
    },
    async rollback(hookId, actorId, opts) {
      if (hookId === 'no-such-hook') {
        // Mirrors real store contract: rollback resolves manifest fail-closed (terra P2)
        throw new OverrideGateError(hookId, 'rollback', 'unknown-hook', 'not-found');
      }
      calls.push({ method: 'rollback', hookId, actorId, opts });
      overrides.delete(hookId);
    },
    async setContentOverride(hookId, content, actorId, opts) {
      calls.push({ method: 'setContentOverride', hookId, content, actorId, opts });
      versions.set(hookId, [{ version: 2, contentPreview: content }]);
      overrides.set(hookId, { hookId, contentOverride: content, activeEpochVersion: 2 });
    },
    async activateVersion(hookId, epochVersion, actorId, opts) {
      calls.push({ method: 'activateVersion', hookId, epochVersion, actorId, opts });
      overrides.set(hookId, { hookId, activeEpochVersion: epochVersion });
    },
    async getOverride(hookId) {
      return overrides.get(hookId) ?? null;
    },
    async listOverrides() {
      return [...overrides.values()];
    },
    async listVersions(hookId) {
      return versions.get(hookId) ?? [];
    },
    async getVersionContent(hookId, epochVersion) {
      return hookId === 'd21-决策树' && epochVersion === 2 ? 'D21 v2 full source content' : null;
    },
    async getActiveVersion(hookId) {
      return overrides.get(hookId)?.activeEpochVersion ?? 1;
    },
    async hasVersion(_hookId, epochVersion) {
      return epochVersion >= 1 && epochVersion <= 2;
    },
  };
}

function createRuntime(store, evalStatus = 'idle') {
  let current = {
    schemaVersion: 1,
    cycleId: 'cycle-live',
    ownerUserId: OWNER,
    objectiveId: 'wait-wakeup-liveness',
    version: 'objective-v1',
    versionContentRef: 'hooks:d21-决策树@1',
    cycleStart: 100,
    evalStatus,
    triggerPolicy: {
      cumulativeThreshold: 200,
      counterexampleThreshold: 3,
      cadenceDays: 7,
      minimumIntervalMs: 2 * 60 * 60 * 1000,
      consecutiveKeepCycles: 0,
      consecutiveCadenceKeepCycles: 0,
    },
    objectiveLifecycle: 'active',
    windows: [],
  };
  return {
    catalog: {
      registry: {
        evaluationModels: [
          {
            id: 'model',
            cycleTrigger: current.triggerPolicy,
          },
        ],
        objectives: [{ id: current.objectiveId, evaluationModelId: 'model' }],
      },
      manifest: {
        units: [{ unitId: 'd21-决策树', objectives: [{ objectiveId: current.objectiveId }] }],
      },
    },
    cycles: {
      async current() {
        return current;
      },
      async switchVersion(_expected, completed, version, carryoverWindows) {
        current = {
          ...current,
          ...version,
          cycleId: `cycle-next-${completed.closedAt}`,
          cycleStart: completed.closedAt,
          carryoverWindows,
        };
        return current;
      },
    },
    cycleChecker: {
      async withObjectiveLock(_ownerUserId, _objectiveId, operation) {
        return operation();
      },
    },
    async resolveVersion() {
      const activeVersion = await store.getActiveVersion('d21-决策树');
      return { version: `objective-v${activeVersion}`, versionContentRef: `hooks:d21-决策树@${activeVersion}` };
    },
    async resolveSegmentVersion(versionContentRef) {
      return Number(versionContentRef.match(/@([0-9]+)$/)?.[1] ?? 0);
    },
  };
}

async function buildApp(options = {}) {
  const store = options.store ?? createFakeStore();
  const sessionUserId = options.sessionUserId === undefined ? OWNER : options.sessionUserId;
  const refreshOverrideSnapshot = options.refreshOverrideSnapshot ?? (async () => {});
  const runtime = options.runtime ?? createRuntime(store);
  const validateVersionContent = options.validateVersionContent ?? (() => null);
  const app = Fastify();
  if (sessionUserId) {
    app.addHook('onRequest', (req, _reply, done) => {
      req.sessionUserId = sessionUserId;
      done();
    });
  }
  await app.register(promptInjectionOverrideRoutes, {
    overrideStore: store,
    refreshOverrideSnapshot,
    runtime,
    validateVersionContent,
  });
  await app.ready();
  return { app, store };
}

describe('prompt-injection-overrides routes (F257 approval executor)', () => {
  before(() => {
    // Owner gate: configured owner must match session user for writes.
    process.env.DEFAULT_OWNER_USER_ID = OWNER;
  });

  it('validates version source against canonical placeholders and YAML shape', () => {
    assert.match(validateCanonicalVersionContent('S13', 'expanded rich block'), /Missing required placeholders/);
    assert.match(validateCanonicalVersionContent('S6', 'not-a-mapping'), /mapping/);
    assert.equal(validateCanonicalVersionContent('S6', 'ragdoll: "{{RICH_BLOCK_SHORT}}"'), null);
  });

  it('401 without session (read + write)', async () => {
    const { app } = await buildApp({ sessionUserId: null });
    const read = await app.inject({ method: 'GET', url: '/api/prompt-hooks/overrides' });
    assert.equal(read.statusCode, 401);
    const write = await app.inject({
      method: 'POST',
      url: '/api/prompt-hooks/d21-决策树/override',
      payload: { action: 'disable', reason: 'x' },
    });
    assert.equal(write.statusCode, 401);
    await app.close();
  });

  it('403 when session user is not the configured owner', async () => {
    const { app, store } = await buildApp({ sessionUserId: 'someone-else' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/prompt-hooks/d21-决策树/override',
      payload: { action: 'disable', reason: 'trial' },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(store.calls.length, 0, 'store must not be touched');
    await app.close();
  });

  it('400 on missing/invalid action and on missing reason', async () => {
    const { app, store } = await buildApp();
    const badAction = await app.inject({
      method: 'POST',
      url: '/api/prompt-hooks/d21-决策树/override',
      payload: { action: 'set-content', reason: 'x' },
    });
    assert.equal(badAction.statusCode, 400);
    const noReason = await app.inject({
      method: 'POST',
      url: '/api/prompt-hooks/d21-决策树/override',
      payload: { action: 'disable', reason: '   ' },
    });
    assert.equal(noReason.statusCode, 400);
    assert.match(noReason.json().error, /reason/);
    assert.equal(store.calls.length, 0);
    await app.close();
  });

  it('400 on non-string reason — untrusted input must not 500 (terra P2)', async () => {
    const { app, store } = await buildApp();
    for (const reason of [{ bad: 'not-string' }, ['array'], 123]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/prompt-hooks/d21-决策树/override',
        payload: { action: 'disable', reason },
      });
      assert.equal(res.statusCode, 400, `reason=${JSON.stringify(reason)} must map to 400`);
      assert.match(res.json().error, /reason/);
    }
    assert.equal(store.calls.length, 0);
    await app.close();
  });

  it('400 on non-record body and non-string action', async () => {
    const { app, store } = await buildApp();
    const stringBody = await app.inject({
      method: 'POST',
      url: '/api/prompt-hooks/d21-决策树/override',
      headers: { 'content-type': 'application/json' },
      payload: '"just-a-string"',
    });
    assert.equal(stringBody.statusCode, 400);
    const arrayBody = await app.inject({
      method: 'POST',
      url: '/api/prompt-hooks/d21-决策树/override',
      payload: [1, 2, 3],
    });
    assert.equal(arrayBody.statusCode, 400);
    const numericAction = await app.inject({
      method: 'POST',
      url: '/api/prompt-hooks/d21-决策树/override',
      payload: { action: 123, reason: 'x' },
    });
    assert.equal(numericAction.statusCode, 400);
    assert.equal(store.calls.length, 0);
    await app.close();
  });

  it('disable happy path: store called with operator source + actor + reason, override echoed', async () => {
    const { app, store } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/prompt-hooks/d21-决策树/override',
      payload: { action: 'disable', reason: 'T1-F1 redundancy trial (operator approved)' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.override.enabled, false);
    assert.deepEqual(store.calls[0], {
      method: 'disable',
      hookId: 'd21-决策树',
      actorId: OWNER,
      opts: { source: 'operator', reason: 'T1-F1 redundancy trial (operator approved)' },
    });
    await app.close();
  });

  it('rejects the legacy rollback action so version changes only use the cycle-aware version route', async () => {
    const { app, store } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/prompt-hooks/d21-决策树/override',
      payload: { action: 'rollback', reason: 'trial regressed — instant revert' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(store.calls.length, 0);
    await app.close();
  });

  it('refreshes the runtime snapshot after successful mutations but not rejected writes', async () => {
    let refreshCount = 0;
    const { app } = await buildApp({
      refreshOverrideSnapshot: async () => {
        refreshCount++;
      },
    });

    const disabled = await app.inject({
      method: 'POST',
      url: '/api/prompt-hooks/d21-决策树/override',
      payload: { action: 'disable', reason: 'activate v2 behavior' },
    });
    assert.equal(disabled.statusCode, 200);
    assert.equal(refreshCount, 1);

    const rejected = await app.inject({
      method: 'POST',
      url: '/api/prompt-hooks/no-such-hook/override',
      payload: { action: 'disable', reason: 'must fail closed' },
    });
    assert.equal(rejected.statusCode, 404);
    assert.equal(refreshCount, 1, 'rejected writes must not publish a new runtime snapshot');

    const createdVersion = await app.inject({
      method: 'POST',
      url: '/api/prompt-hooks/d21-决策树/versions',
      payload: {
        content: 'v2 content',
        reason: 'create the bounded v2 trial',
        baseVersion: 1,
        expectedActiveVersion: 1,
      },
    });
    assert.equal(createdVersion.statusCode, 200);
    assert.equal(createdVersion.json().transition.toVersion, 2);
    assert.equal(refreshCount, 2);

    const activatedVersion = await app.inject({
      method: 'POST',
      url: '/api/prompt-hooks/d21-决策树/versions/activate',
      payload: { epochVersion: 1, reason: 'switch the active v2 trial back to baseline' },
    });
    assert.equal(activatedVersion.statusCode, 200);
    assert.equal(activatedVersion.json().transition.toVersion, 1);
    assert.equal(refreshCount, 3);
    await app.close();
  });

  it('creates from an explicit base version and guards the active version seen by the editor', async () => {
    const store = createFakeStore();
    const { app } = await buildApp({ store });
    const created = await app.inject({
      method: 'POST',
      url: '/api/prompt-hooks/d21-%E5%86%B3%E7%AD%96%E6%A0%91/versions',
      payload: {
        content: 'new branch content',
        reason: '用户编辑',
        baseVersion: 1,
        expectedActiveVersion: 1,
      },
    });

    assert.equal(created.statusCode, 200);
    assert.equal(created.json().transition.baseVersion, 1);
    const write = store.calls.find((call) => call.method === 'setContentOverride');
    assert.equal(write.opts.parentVersion, 1);

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/prompt-hooks/d21-%E5%86%B3%E7%AD%96%E6%A0%91/versions',
      payload: { content: 'x', reason: '用户编辑', baseVersion: 0, expectedActiveVersion: 1 },
    });
    assert.equal(invalid.statusCode, 400);

    const stale = await app.inject({
      method: 'POST',
      url: '/api/prompt-hooks/d21-%E5%86%B3%E7%AD%96%E6%A0%91/versions',
      payload: { content: 'stale', reason: '用户编辑', baseVersion: 1, expectedActiveVersion: 1 },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().code, 'active_version_changed');

    const missingBase = await app.inject({
      method: 'POST',
      url: '/api/prompt-hooks/d21-%E5%86%B3%E7%AD%96%E6%A0%91/versions',
      payload: { content: 'missing base', reason: '用户编辑', baseVersion: 99, expectedActiveVersion: 2 },
    });
    assert.equal(missingBase.statusCode, 404);
    assert.equal(missingBase.json().code, 'base_version_not_found');
    await app.close();
  });

  it('rejects invalid source before creating a version', async () => {
    const store = createFakeStore();
    const { app } = await buildApp({ store, validateVersionContent: () => 'Missing required placeholders: {{VALUE}}' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/prompt-hooks/d21-%E5%86%B3%E7%AD%96%E6%A0%91/versions',
      payload: { content: 'expanded value', reason: '用户编辑', baseVersion: 1, expectedActiveVersion: 1 },
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'invalid_version_content');
    assert.equal(
      store.calls.some((call) => call.method === 'setContentOverride'),
      false,
    );
    await app.close();
  });

  it('gate errors map to HTTP: disableable=false → 409, unknown-hook → 404', async () => {
    const { app } = await buildApp();
    const policy = await app.inject({
      method: 'POST',
      url: '/api/prompt-hooks/s1-immutable/override',
      payload: { action: 'disable', reason: 'x' },
    });
    assert.equal(policy.statusCode, 409);
    assert.equal(policy.json().gate, 'disableable');
    const missing = await app.inject({
      method: 'POST',
      url: '/api/prompt-hooks/no-such-hook/override',
      payload: { action: 'disable', reason: 'x' },
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().gate, 'unknown-hook');
    await app.close();
  });

  it('legacy rollback is rejected before unknown-hook lookup and records no audit write', async () => {
    const { app, store } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/prompt-hooks/no-such-hook/override',
      payload: { action: 'rollback', reason: 'cleanup attempt' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(store.calls.length, 0, 'rollback must not be recorded for unknown hook');
    await app.close();
  });

  it('GET lists current overrides (lifeline read surface)', async () => {
    const { app } = await buildApp();
    await app.inject({
      method: 'POST',
      url: '/api/prompt-hooks/d21-决策树/override',
      payload: { action: 'disable', reason: 'trial' },
    });
    const res = await app.inject({ method: 'GET', url: '/api/prompt-hooks/overrides' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().overrides.length, 1);
    await app.close();
  });

  it('GET returns exact content for a selected version and 404 for a missing snapshot', async () => {
    const { app } = await buildApp();
    const found = await app.inject({
      method: 'GET',
      url: '/api/prompt-hooks/d21-%E5%86%B3%E7%AD%96%E6%A0%91/versions/2/content',
    });
    assert.equal(found.statusCode, 200);
    assert.deepEqual(found.json(), {
      hookId: 'd21-决策树',
      epochVersion: 2,
      content: 'D21 v2 full source content',
    });
    const missing = await app.inject({
      method: 'GET',
      url: '/api/prompt-hooks/d21-%E5%86%B3%E7%AD%96%E6%A0%91/versions/3/content',
    });
    assert.equal(missing.statusCode, 404);
    await app.close();
  });

  it('refuses a version switch once evaluation has started without touching the override', async () => {
    const store = createFakeStore();
    const { app } = await buildApp({ store, runtime: createRuntime(store, 'requested') });
    const response = await app.inject({
      method: 'POST',
      url: '/api/prompt-hooks/d21-%E5%86%B3%E7%AD%96%E6%A0%91/versions/activate',
      payload: { epochVersion: 2 },
    });

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, 'evaluation_in_progress');
    assert.equal(
      store.calls.some((call) => call.method === 'activateVersion'),
      false,
    );

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/prompt-hooks/d21-%E5%86%B3%E7%AD%96%E6%A0%91/versions',
      payload: {
        content: 'must not become active',
        reason: 'evaluation owns the current version',
        baseVersion: 1,
        expectedActiveVersion: 1,
      },
    });
    assert.equal(createResponse.statusCode, 409);
    assert.equal(
      store.calls.some((call) => call.method === 'setContentOverride'),
      false,
    );

    const rollbackResponse = await app.inject({
      method: 'POST',
      url: '/api/prompt-hooks/d21-%E5%86%B3%E7%AD%96%E6%A0%91/override',
      payload: { action: 'rollback', reason: 'must not bypass the active evaluation' },
    });
    assert.equal(rollbackResponse.statusCode, 400);
    assert.equal(
      store.calls.some((call) => call.method === 'rollback'),
      false,
    );
    await app.close();
  });

  it('503 when override store unavailable (redis off)', async () => {
    const app = Fastify();
    app.addHook('onRequest', (req, _reply, done) => {
      req.sessionUserId = OWNER;
      done();
    });
    await app.register(promptInjectionOverrideRoutes, { overrideStore: undefined });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/prompt-hooks/d21-决策树/override',
      payload: { action: 'disable', reason: 'x' },
    });
    assert.equal(res.statusCode, 503);
    await app.close();
  });
});
