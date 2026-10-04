import assert from 'node:assert/strict';
import { test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { projectCollectiveWorkDelegation } from '../dist/domains/plugin/builtin-runtime/collective-work-delegation.js';

const workInvocation = { v: 1, taskId: 'task-A', observedRevision: 3 };
const originMessage = {
  id: 'message-work-trigger',
  userId: 'owner',
  threadId: 'private-A',
  catId: null,
  content: 'Run admitted Work',
  mentions: [],
  timestamp: 1,
  extra: { collectiveWorkInvocationV1: workInvocation },
};
const record = {
  userId: 'owner',
  threadId: 'private-A',
  catId: 'codex-astra',
  ownerAuthProvenance: 'strict',
  collectiveWorkBinding: {
    ...workInvocation,
    sourceRef: 'message:collective-source',
    authorityRef: 'message:owner-admission',
  },
};

test('only the exact admitted owner invocation can project a same-thread home delegation', () => {
  assert.deepEqual(
    projectCollectiveWorkDelegation({
      record,
      originMessage,
      targetThreadId: 'private-A',
      targetCatIds: ['codex-sol'],
      crossThread: false,
    }),
    {
      v: 1,
      taskId: 'task-A',
      observedRevision: 3,
      resultRevision: 1,
      executionRevision: 1,
      ownerCatId: 'codex-astra',
      targetCatIds: ['codex-sol'],
    },
  );

  for (const override of [
    { record: { ...record, collectiveWorkBinding: undefined } },
    { record: { ...record, collectiveWorkBinding: { ...record.collectiveWorkBinding, executionRevision: 2 } } },
    { targetThreadId: 'private-B' },
    { crossThread: true },
    { targetCatIds: ['codex-astra'] },
    { originMessage: { ...originMessage, extra: { collectiveWorkDelegationV1: {} } } },
    {
      originMessage: {
        ...originMessage,
        extra: { collectiveWorkInvocationV1: { ...workInvocation, observedRevision: 2 } },
      },
    },
  ]) {
    assert.equal(
      projectCollectiveWorkDelegation({
        record,
        originMessage,
        targetThreadId: 'private-A',
        targetCatIds: ['codex-sol'],
        crossThread: false,
        ...override,
      }),
      undefined,
    );
  }
});

test('home delegation retains and matches the current nondefault execution revision and protected receipt', () => {
  const execution = { executionRevision: 3, executionRef: 'message:execution-A' };
  const currentRecord = { ...record, collectiveWorkBinding: { ...record.collectiveWorkBinding, ...execution } };
  const currentMessage = {
    ...originMessage,
    extra: { collectiveWorkInvocationV1: { ...workInvocation, ...execution } },
  };
  const input = {
    record: currentRecord,
    originMessage: currentMessage,
    targetThreadId: 'private-A',
    targetCatIds: ['codex-sol'],
    crossThread: false,
  };
  assert.deepEqual(projectCollectiveWorkDelegation(input), {
    ...workInvocation,
    resultRevision: 1,
    ...execution,
    ownerCatId: record.catId,
    targetCatIds: ['codex-sol'],
  });
  for (const delta of [{ executionRevision: 2 }, { executionRef: 'message:execution-B' }, { executionRevision: 0 }]) {
    assert.equal(
      projectCollectiveWorkDelegation({
        ...input,
        originMessage: {
          ...currentMessage,
          extra: { collectiveWorkInvocationV1: { ...workInvocation, ...execution, ...delta } },
        },
      }),
      undefined,
    );
  }
});
