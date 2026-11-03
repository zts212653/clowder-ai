import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationServiceScope } from '../dist/domains/cats/services/agents/invocation/invocation-service-scope.js';
import { ExecutionAdmissionConflict } from '../dist/domains/cats/services/agents/registry/AgentServiceUnavailableError.js';

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
