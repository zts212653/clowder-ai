import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyMemoryTools } from './tool-availability.mjs';

test('granted config alone cannot claim a loaded tool; runtime failure stays visible', async () => {
  const rpc = {
    request: async () => ({
      data: [{ name: 'cat_cafe_memory', runtimeStatus: 'failed', tools: {}, toolsError: 'fixture startup failed' }],
    }),
  };
  await assert.rejects(verifyMemoryTools(rpc, 'fixture-thread', true), /资料工具/);
});

test('native inventory must contain the allowed file reader, then reports connected', async () => {
  let requested;
  const rpc = {
    request: async (method, params) => {
      requested = { method, params };
      return {
        data: [
          {
            name: 'cat_cafe_memory',
            runtimeStatus: 'connected',
            tools: { cat_cafe_read_file_slice: { name: 'cat_cafe_read_file_slice' } },
          },
        ],
      };
    },
  };
  assert.equal((await verifyMemoryTools(rpc, 'fixture-thread', true)).state, 'connected');
  assert.equal(requested?.params.threadId, 'fixture-thread');
  assert.equal(requested?.method, 'mcpServerStatus/list');
});

test('revocation during inventory discovery prevents a late readiness result', async () => {
  const abort = new AbortController();
  let complete;
  const rpc = {
    request: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  };
  const ready = verifyMemoryTools(rpc, 'fixture-thread', true, abort.signal);
  abort.abort();
  complete({
    data: [
      {
        name: 'cat_cafe_memory',
        runtimeStatus: 'connected',
        tools: { cat_cafe_read_file_slice: { name: 'cat_cafe_read_file_slice' } },
      },
    ],
  });
  await assert.rejects(ready, { name: 'AbortError' });
});
