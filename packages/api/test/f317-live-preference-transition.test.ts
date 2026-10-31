import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { LiveCompanionSessions } from '../src/domains/concierge/live/LiveCompanionSessions.js';

test('owner preference changes serialize stop then persistence, blocking prepare until the change settles', async () => {
  const sessions = new LiveCompanionSessions();
  const options = {
    binding: { userId: 'owner', threadId: 'home', catId: createCatId('codex-astra'), callId: 'call' },
    messageStore: new MessageStore(),
    mcpDistDir: resolve('../mcp-server/dist'),
    allowedDirectories: [],
    verifyNativeBinding: async () => true,
    publish() {},
  };
  const call = await sessions.prepare(options);
  let endStop!: () => void;
  let startStop!: () => void;
  const started = new Promise<void>((resolve) => {
    startStop = resolve;
  });
  const stopped = new Promise<void>((resolve) => {
    endStop = resolve;
  });
  await call.ready('native', {
    submitText: async () => 'turn',
    request: async (method) => {
      if (method === 'thread/realtime/start')
        await call.observe({ method: 'thread/realtime/sdp', params: { threadId: 'native', sdp: 'answer' } });
      if (method === 'thread/realtime/stop') {
        startStop();
        await stopped;
      }
      return {};
    },
  });
  await call.start('offer');
  let write = false;
  const changed = sessions.withOwnerPreferenceChange('owner', async () => {
    assert.equal(call.status().state, 'closed');
    write = true;
    await assert.rejects(sessions.prepare({ ...options, binding: { ...options.binding, callId: 'new' } }), /active/);
  });
  await started;
  assert.equal(write, false, 'permissions cannot be written before acknowledged call closure');
  await assert.rejects(
    sessions.withOwnerPreferenceChange('owner', async () => {}),
    /active/,
  );
  endStop();
  await changed;
  assert.equal(write, true);
  await Promise.resolve();
  const next = await sessions.prepare({ ...options, binding: { ...options.binding, callId: 'new' } });
  await next.stop();
});

test('unconfirmed teardown cannot change household permissions', async () => {
  const sessions = new LiveCompanionSessions();
  const call = await sessions.prepare({
    binding: { userId: 'owner', threadId: 'home', catId: createCatId('codex-astra'), callId: 'call' },
    messageStore: new MessageStore(),
    mcpDistDir: resolve('../mcp-server/dist'),
    allowedDirectories: [],
    verifyNativeBinding: async () => true,
    publish() {},
  });
  await call.ready('native', {
    submitText: async () => 'turn',
    request: async (method) => {
      if (method === 'thread/realtime/start')
        await call.observe({ method: 'thread/realtime/sdp', params: { threadId: 'native', sdp: 'answer' } });
      if (method === 'thread/realtime/stop') throw new Error('stop unconfirmed');
      return {};
    },
  });
  await call.start('offer');
  let writes = 0;
  await assert.rejects(
    sessions.withOwnerPreferenceChange('owner', async () => {
      writes++;
    }),
    /teardown unconfirmed/,
  );
  assert.equal(writes, 0);
});
