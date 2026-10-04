import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveAgyNativeCodingGrant } from '../dist/domains/cats/services/agents/providers/agy-native/agy-native-coding-grant.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'f325-coding-grant-'));
  mkdirSync(join(root, 'src'));
  const workUnitRef = 'file:docs/plans/2026-09-29-f325-three-pr-execution.md#p2-first-coding';
  const acceptedRevision = 'a'.repeat(40);
  const grant = {
    threadId: 'thread_pilot',
    taskId: 'task-pilot',
    workUnitRef,
    acceptedRevision,
    workspaceRoot: root,
    writableFiles: ['src/change.ts', 'src/change.test.mjs'],
    testFile: 'src/change.test.mjs',
  };
  const task = {
    id: grant.taskId,
    kind: 'work',
    threadId: grant.threadId,
    ownerCatId: 'gemini38',
    userId: 'user1',
    status: 'doing',
    entrustedWork: {
      developmentScope: { featureRef: 'feature:F325', workUnitRef, acceptedRevision, acceptedSourceRef: workUnitRef },
      closure: { state: 'open' },
    },
  };
  const input = {
    grant,
    threadId: grant.threadId,
    catId: 'gemini38',
    userId: 'user1',
    taskStore: { get: async () => task },
  };
  return { root, grant, task, input, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('native coding grant follows one exact open Task and accepted plan revision', async () => {
  const f = fixture();
  try {
    assert.deepEqual(await resolveAgyNativeCodingGrant(f.input), {
      workspaceRoot: realpathSync(f.root),
      writableFiles: f.grant.writableFiles,
      testFile: f.grant.testFile,
      taskId: f.grant.taskId,
    });
    assert.equal(await resolveAgyNativeCodingGrant({ ...f.input, threadId: 'thread_other' }), null);
  } finally {
    f.cleanup();
  }
});

test('native coding grant rejects stale, foreign, blocked and unsafe task bindings', async () => {
  const f = fixture();
  try {
    for (const task of [
      { ...f.task, ownerCatId: 'sonnet' },
      {
        ...f.task,
        entrustedWork: {
          ...f.task.entrustedWork,
          developmentScope: { ...f.task.entrustedWork.developmentScope, acceptedRevision: 'b'.repeat(40) },
        },
      },
    ]) {
      await assert.rejects(
        resolveAgyNativeCodingGrant({ ...f.input, taskStore: { get: async () => task } }),
        /coding grant|Task/i,
      );
    }
    for (const task of [
      { ...f.task, status: 'blocked' },
      { ...f.task, status: 'done', entrustedWork: { ...f.task.entrustedWork, closure: { state: 'satisfied' } } },
    ]) {
      assert.equal(
        await resolveAgyNativeCodingGrant({ ...f.input, taskStore: { get: async () => task } }),
        null,
        'inactive Task must remove writes without breaking ordinary native chat',
      );
    }
    await assert.rejects(resolveAgyNativeCodingGrant({ ...f.input, taskStore: undefined }), /coding grant|Task/i);
    await assert.rejects(
      resolveAgyNativeCodingGrant({ ...f.input, grant: { ...f.grant, testFile: '../escape.test.mjs' } }),
      /coding grant|unsafe|outside/i,
    );
  } finally {
    f.cleanup();
  }
});
