import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executionMcpFactory } from '../dist/domains/plugin/execution-worker/shared-mcp.js';

function factory(worker) {
  return executionMcpFactory({
    worker,
    instanceId: 'instance',
    entrypoint: '/fixture.js',
    exportName: 'create',
    assertCurrent() {},
    scopes: new Set(),
  })({ invoke: async () => {} });
}
const transport = () => ({ start: async () => {}, send: async () => {}, close: async () => {} });

test('closing an unconnected shared MCP server prevents subsequent lease allocation', async () => {
  let allocated = 0;
  const server = factory({
    async lease() {
      allocated++;
      throw new Error('unexpected lease');
    },
  });
  await server.close();
  await assert.rejects(server.connect(transport()), /closed/);
  assert.equal(allocated, 0);
});

test('close during asynchronous execution lease allocation joins and releases that lease', async () => {
  const entered = Promise.withResolvers();
  const pendingLease = Promise.withResolvers();
  let released = 0;
  let imported = 0;
  const server = factory({
    async lease() {
      entered.resolve();
      return pendingLease.promise;
    },
  });
  const connecting = server.connect(transport());
  connecting.catch(() => {});
  await entered.promise;
  const closing = server.close();
  pendingLease.resolve({
    exited: false,
    retain: (value) => value,
    async call() {
      imported++;
      return { connect: async () => {}, close: async () => {} };
    },
    async close() {
      released++;
    },
  });
  await assert.rejects(connecting, /closed/);
  await closing;
  assert.equal(imported, 0);
  assert.equal(released, 1);
});
