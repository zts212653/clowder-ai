import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const serviceWorkerPath = join(apiRoot, 'src/plugins/cloud-cat-personal-host/extension/service-worker.js');
const helperArtifactRevision = `sha512:${'0'.repeat(128)}`;

it('forwards a validated source-bound assistant final from the content script to Native Messaging', async () => {
  const serviceWorkerSource = await readFile(serviceWorkerPath, 'utf8');
  const contentListeners = [];
  const nativeListeners = [];
  const outbound = [];
  const chrome = {
    runtime: {
      connectNative() {
        return {
          onMessage: { addListener: (listener) => nativeListeners.push(listener) },
          onDisconnect: { addListener() {} },
          postMessage: (message) => outbound.push(message),
        };
      },
      onMessage: { addListener: (listener) => contentListeners.push(listener) },
    },
    alarms: { create: async () => undefined, onAlarm: { addListener() {} } },
    action: { onClicked: { addListener() {} }, setBadgeText() {}, setTitle() {} },
    tabs: {},
  };
  runInNewContext(serviceWorkerSource, { chrome, URL, TextEncoder, setTimeout() {}, clearTimeout() {} });
  let response;
  const observed = {
    v: 2,
    kind: 'assistant_final_observed',
    requestId: 'assistant-return-request-1',
    conversationId: 'conversation-7',
    idempotencyKey: 'source-message-9',
    hostMessageId: 'conversation-turn-41',
    assistantMessageId: 'conversation-turn-42',
    content: 'the exact ordinary assistant final',
    observedRevisions: {
      helper: helperArtifactRevision,
      extension: '0.2.10',
      pageAdapter: '2026-09-02.1',
    },
  };

  const waitsForDurability = contentListeners[0](observed, {}, (value) => {
    response = value;
  });

  assert.deepEqual(outbound.at(-1), observed);
  assert.equal(waitsForDurability, true);
  assert.equal(response, undefined);
  nativeListeners[0]({
    v: 2,
    kind: 'assistant_final_result',
    requestId: observed.requestId,
    status: 'accepted',
  });
  assert.equal(response.accepted, true);

  response = undefined;
  const retry = { ...observed, requestId: 'assistant-return-request-2' };
  contentListeners[0](retry, {}, (value) => {
    response = value;
  });
  nativeListeners[0]({ v: 2, kind: 'assistant_final_result', requestId: retry.requestId, status: 'retryable' });
  assert.equal(response.accepted, false);
});

it('forwards a privacy-safe assistant observation failure and waits for durable Native acceptance', async () => {
  const serviceWorkerSource = await readFile(serviceWorkerPath, 'utf8');
  const contentListeners = [];
  const nativeListeners = [];
  const outbound = [];
  const chrome = {
    runtime: {
      connectNative() {
        return {
          onMessage: { addListener: (listener) => nativeListeners.push(listener) },
          onDisconnect: { addListener() {} },
          postMessage: (message) => outbound.push(message),
        };
      },
      onMessage: { addListener: (listener) => contentListeners.push(listener) },
    },
    alarms: { create: async () => undefined, onAlarm: { addListener() {} } },
    action: { onClicked: { addListener() {} }, setBadgeText() {}, setTitle() {} },
    tabs: {},
  };
  runInNewContext(serviceWorkerSource, { chrome, URL, TextEncoder, setTimeout() {}, clearTimeout() {} });
  let response;
  const failure = {
    v: 2,
    kind: 'assistant_observation_failed',
    requestId: 'assistant-failure-request-1',
    conversationId: 'conversation-7',
    idempotencyKey: 'source-message-9',
    hostMessageId: 'conversation-turn-41',
    errorCode: 'ASSISTANT_FINAL_NOT_OBSERVED',
    diagnostic: {
      v: 1,
      userTurnConnected: true,
      anchorTurnFound: true,
      followingTurnCount: 1,
      assistantCandidateCount: 1,
      laterUserTurnPresent: false,
      assistantHostIdStatus: 'missing_or_ambiguous',
      assistantContentStatus: 'present',
      streamingControlPresent: false,
    },
    observedRevisions: {
      helper: helperArtifactRevision,
      extension: '0.2.10',
      pageAdapter: '2026-09-02.1',
    },
  };

  const waitsForDurability = contentListeners[0](failure, {}, (value) => {
    response = value;
  });

  assert.deepEqual(outbound.at(-1), failure);
  assert.equal(waitsForDurability, true);
  nativeListeners[0]({
    v: 2,
    kind: 'assistant_observation_failure_result',
    requestId: failure.requestId,
    status: 'accepted',
  });
  assert.equal(response.accepted, true);
});
