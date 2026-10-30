import assert from 'node:assert/strict';

/**
 * Older owner tests explicitly model an already-known native history. Declare
 * that fixture precondition; unknown/mismatched binding tests use real stores
 * without this helper (persisted-execution-boundary.test.js).
 */
export async function declareKnownHostSessionFixture(deps, params, binding) {
  const store = deps.sessionChainStore;
  if (!store) return;
  const [read] = await Promise.allSettled([
    Promise.resolve().then(() => store.getActive?.(params.catId, params.threadId, params.userId)),
  ]);
  if (read.status === 'fulfilled' && read.value?.cliSessionId && !read.value.hostExecutionBoundary)
    read.value.hostExecutionBoundary = binding.hostExecutionBoundary;

  // Partial doubles exercise other owners, not SessionChainStore persistence.
  // Real stores keep their real atomic method; never replace it here.
  if (!store.bindHostExecutionBoundary)
    store.bindHostExecutionBoundary = async (id, _runtime, boundary) => {
      const record = await store.getActive(params.catId, params.threadId, params.userId);
      assert.equal(record?.id, id, 'the partial store must return its fixture-owned logical record');
      record.hostExecutionBoundary ??= boundary;
      return record;
    };
}

/** Owner regressions that begin with certified native history, rather than legacy unknown state. */
export async function* invokeKnownHostSession(deps, params) {
  const invocation = await import('../../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');
  const executionBinding = await invocation.prepareInvocationExecutionBinding(deps, params);
  await declareKnownHostSessionFixture(deps, params, executionBinding);
  yield* invocation.invokeSingleCat(deps, { ...params, executionBinding });
}
