import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  handleLiveMeetingAttach,
  handleLiveMeetingSources,
  handleLiveMeetingStart,
  handleLiveMeetingStatus,
  handleLiveMeetingStop,
} from '../src/tools/live-meeting-tools.js';

test('sources/status use short callback deadlines while media mutations retain their drain budget', async (t) => {
  const keys = ['CAT_CAFE_API_URL', 'CAT_CAFE_INVOCATION_ID', 'CAT_CAFE_CALLBACK_TOKEN', 'CAT_CAFE_CREDENTIAL_FILE'];
  const saved = keys.map((key) => process.env[key]);
  t.after(() =>
    keys.forEach((key, i) => {
      if (saved[i] === undefined) delete process.env[key];
      else process.env[key] = saved[i];
    }),
  );
  process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:1';
  process.env.CAT_CAFE_INVOCATION_ID = 'meeting-transport-test';
  process.env.CAT_CAFE_CALLBACK_TOKEN = 'synthetic-test-token';
  delete process.env.CAT_CAFE_CREDENTIAL_FILE;
  const budgets: number[] = [],
    paths: string[] = [];
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    budgets.push(ms);
    return new AbortController().signal;
  });
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    paths.push(String(url));
    return new Response('{}');
  });
  await handleLiveMeetingSources();
  await handleLiveMeetingStatus();
  await handleLiveMeetingStart({ sourceId: 'exact-app' });
  await handleLiveMeetingAttach({ sourceId: 'exact-app' });
  await handleLiveMeetingStop({ meetingId: 'exact-meeting' });
  assert.deepEqual(budgets, [15_000, 15_000, 130_000, 130_000, 130_000]);
  assert.deepEqual(
    paths.map((url) => new URL(url).pathname),
    [
      '/api/callbacks/meeting-sources',
      '/api/callbacks/meeting-status',
      '/api/callbacks/meeting-start',
      '/api/callbacks/meeting-start',
      '/api/callbacks/meeting-stop',
    ],
  );
});
