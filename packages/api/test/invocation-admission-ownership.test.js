import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationServiceScope } from '../dist/domains/cats/services/agents/invocation/invocation-service-scope.js';
import { AgentRegistry } from '../dist/domains/cats/services/agents/registry/AgentRegistry.js';
import {
  ExecutionAdmissionConflict,
  StaleServiceSourceConflict,
} from '../dist/domains/cats/services/agents/registry/AgentServiceUnavailableError.js';

for (const outcome of ['success', 'continuous', 'opaque', 'cancel-on-release']) {
  test(`admission ${outcome} releases failed pins and retains only the successful owner`, async (t) => {
    const scope = new InvocationServiceScope();
    t.after(() => scope.dispose());
    const controller = new AbortController();
    const released = { old: 0, next: 0 };
    let resolves = 0,
      captures = 0;
    const source = (label) => ({
      forInvocation: () => ({
        async *invoke() {
          assert.fail('admission must never start a model');
        },
        async releaseInvocation() {
          released[label]++;
          if (label === 'old' && outcome === 'cancel-on-release') controller.abort();
        },
      }),
      async *invoke() {
        assert.fail('the raw service must never run');
      },
    });
    const first = scope.pin(source('old'));
    const binding = Object.freeze({
      workspace: { usesDefaultWorkspace: false },
      projectRoot: process.cwd(),
      resolvedAccount: null,
    });
    const admission = scope.admit(
      first,
      () => {
        resolves++;
        return source('next');
      },
      async () => {
        captures++;
        if (outcome === 'opaque') throw Object.assign(new Error('owned opaque failure'), { statusCode: 409 });
        if (captures === 1 || outcome === 'continuous')
          throw new ExecutionAdmissionConflict('owned configuration changed');
        return binding;
      },
      controller.signal,
    );
    if (outcome === 'success') {
      assert.equal((await admission).executionBinding, binding);
      assert.deepEqual(released, { old: 1, next: 0 });
    } else if (outcome === 'cancel-on-release') await assert.rejects(admission, { name: 'AbortError' });
    else await assert.rejects(admission, outcome === 'opaque' ? /owned opaque failure/ : ExecutionAdmissionConflict);
    const retried = ['success', 'continuous'].includes(outcome);
    assert.equal(captures, retried ? 2 : 1);
    assert.equal(resolves, retried ? 1 : 0);
    await scope.dispose();
    await scope.dispose();
    assert.deepEqual(released, { old: 1, next: retried ? 1 : 0 });
  });
}

for (const outcome of [
  'success',
  'refresh-fails',
  'still-stale',
  'already-replaced',
  'cancel-before',
  'cancel-during',
]) {
  test(`admission refresh ${outcome} keeps the retry and pin ownership bounded`, async (t) => {
    const scope = new InvocationServiceScope();
    t.after(() => scope.dispose());
    const controller = new AbortController();
    const released = { old: 0, next: 0 };
    let captures = 0,
      refreshes = 0;
    const source = (label) => ({
      forInvocation: () => ({
        label,
        async *invoke() {
          assert.fail('admission must not launch a provider');
        },
        async releaseInvocation() {
          released[label]++;
          if (label === 'old' && outcome === 'already-replaced') current = next;
          if (label === 'old' && outcome === 'cancel-before') controller.abort();
        },
      }),
      async *invoke() {
        assert.fail('the raw service must never run');
      },
    });
    const old = source('old'),
      next = source('next');
    let current = old;
    const binding = Object.freeze({
      workspace: { usesDefaultWorkspace: false },
      projectRoot: process.cwd(),
      resolvedAccount: null,
    });
    const admission = scope.admit(
      scope.pin(old),
      () => current,
      async (view) => {
        captures++;
        if (view.label === 'old') throw new StaleServiceSourceConflict('fixture stale construction');
        return binding;
      },
      controller.signal,
      async () => {
        refreshes++;
        if (outcome === 'refresh-fails') throw new Error('fixture registry refresh failed');
        if (outcome !== 'still-stale') current = next;
        if (outcome === 'cancel-during') controller.abort();
      },
    );
    if (['success', 'already-replaced'].includes(outcome)) assert.equal((await admission).executionBinding, binding);
    else if (outcome.startsWith('cancel-')) await assert.rejects(admission, { name: 'AbortError' });
    else
      await assert.rejects(
        admission,
        outcome === 'refresh-fails' ? /fixture registry refresh failed/ : ExecutionAdmissionConflict,
      );
    await scope.dispose();
    assert.equal(captures, ['success', 'already-replaced', 'still-stale'].includes(outcome) ? 2 : 1);
    assert.equal(refreshes, ['already-replaced', 'cancel-before'].includes(outcome) ? 0 : 1);
    assert.deepEqual(released, {
      old: outcome === 'still-stale' ? 2 : 1,
      next: ['success', 'already-replaced', 'cancel-during'].includes(outcome) ? 1 : 0,
    });
  });
}

for (const message of [
  'Thread execution configuration changed during admission',
  'Member configuration changed during execution admission',
  'MCP configuration changed during execution admission',
  'Plugin MCP activation changed during execution admission',
]) {
  test(`ordinary admission race retries without rebuilding: ${message}`, async (t) => {
    const scope = new InvocationServiceScope();
    t.after(() => scope.dispose());
    const source = { async *invoke() {} };
    let captures = 0,
      refreshes = 0;
    await scope.admit(
      scope.pin(source),
      () => source,
      async () => {
        if (++captures === 1) throw new ExecutionAdmissionConflict(message);
        return {};
      },
      undefined,
      async () => {
        refreshes++;
      },
    );
    assert.equal(captures, 2, 'ordinary races retain the existing one retry');
    assert.equal(refreshes, 0, 'a race does not mean the service source is stale');
  });
}

test('admission refresh requests share one registry rebuild and can retry after failure', async () => {
  const registry = new AgentRegistry();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let rebuilds = 0;
  const rebuild = async () => {
    rebuilds++;
    entered.resolve();
    await release.promise;
  };
  const pending = [registry.refreshForAdmission(rebuild), registry.refreshForAdmission(rebuild)];
  const settled = Promise.allSettled(pending);
  await entered.promise;
  assert.equal(rebuilds, 1);
  release.reject(new Error('fixture rebuild refused'));
  const results = await settled;
  assert.ok(
    results.every((result) => result.status === 'rejected' && result.reason.message === 'fixture rebuild refused'),
  );
  assert.equal(rebuilds, 1);
  await registry.refreshForAdmission(async () => {
    rebuilds++;
  });
  assert.equal(rebuilds, 2, 'a failed configuration rebuild must not poison later recovery');
});
