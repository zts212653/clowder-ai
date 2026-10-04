import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerCallbackAuthHook } from '../dist/routes/callback-auth-prehandler.js';
import { registerCallbackNativeTestGrantRoute } from '../dist/routes/callback-native-test-grant.js';

test('native test target is returned only for the exact authorized live Task and callback route', async () => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'f325-native-test-grant-')));
  mkdirSync(join(workspace, 'src'));
  const workUnitRef = 'file:docs/plans/2026-09-29-f325-three-pr-execution.md#p2-first-coding';
  const grant = {
    threadId: 'thread-pilot',
    taskId: 'task-pilot',
    workUnitRef,
    acceptedRevision: 'a'.repeat(40),
    workspaceRoot: workspace,
    writableFiles: ['src/change.ts', 'src/change.test.mjs'],
    testFile: 'src/change.test.mjs',
  };
  let taskStatus = 'doing';
  let threadPath = workspace;
  let allowedRoute = true;
  const app = Fastify();
  registerCallbackAuthHook(app, {
    verify: async (invocationId, callbackToken) => {
      if (invocationId !== 'inv' || callbackToken !== 'fake-token') return { ok: false, reason: 'invalid_token' };
      return {
        ok: true,
        record: {
          invocationId,
          callbackToken,
          catId: 'gemini38',
          threadId: grant.threadId,
          userId: 'user1',
          ownerAuthProvenance: 'strict',
          createdAt: Date.now(),
          expiresAt: null,
          toolExecutionPolicy: {
            mode: 'callback_allowlist',
            allowedCallbackRoutes: allowedRoute ? ['GET /api/callbacks/native-test-grant'] : [],
          },
        },
      };
    },
  });
  registerCallbackNativeTestGrantRoute(app, {
    getGrantConfig: () => grant,
    taskStore: {
      get: async () => ({
        id: grant.taskId,
        kind: 'work',
        threadId: grant.threadId,
        ownerCatId: 'gemini38',
        userId: 'user1',
        status: taskStatus,
        entrustedWork: {
          developmentScope: {
            featureRef: 'feature:F325',
            phaseKey: 'B',
            workUnitRef,
            acceptedSourceRef: workUnitRef,
            acceptedRevision: grant.acceptedRevision,
          },
          closure: { state: 'open' },
        },
      }),
    },
    threadStore: { get: async () => ({ projectPath: threadPath }) },
  });
  const request = {
    method: 'GET',
    url: '/api/callbacks/native-test-grant',
    headers: { 'x-invocation-id': 'inv', 'x-callback-token': 'fake-token' },
  };
  try {
    assert.equal((await app.inject({ method: 'GET', url: request.url })).statusCode, 401);
    const live = await app.inject(request);
    assert.equal(live.statusCode, 200);
    assert.deepEqual(live.json(), { v: 1, taskId: grant.taskId, workspaceRoot: workspace, testFile: grant.testFile });
    assert.ok(!live.body.includes('fake-token'));
    taskStatus = 'done';
    assert.equal((await app.inject(request)).statusCode, 403);
    taskStatus = 'doing';
    threadPath = tmpdir();
    assert.equal((await app.inject(request)).statusCode, 403);
    threadPath = workspace;
    allowedRoute = false;
    assert.equal((await app.inject(request)).statusCode, 403);
  } finally {
    await app.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});
