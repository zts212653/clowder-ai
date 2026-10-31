import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HomeWindowCapabilities } from '../src/domains/concierge/live/host/home/home-window-capabilities.js';

test('an expired token never authorizes an action but the exact owner can release its old discovery entry', (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const clients = new HomeWindowCapabilities();
  const lease = clients.register('owner', 'client', 'socket');
  now = lease.expiresAt;
  assert.equal(clients.owns('owner', 'client', lease.clientToken), false);
  assert.deepEqual(clients.connections('owner', 'client'), []);
  assert.equal(clients.unregister('foreign', 'client', lease.clientToken), false);
  assert.equal(clients.unregister('owner', 'client', 'forged'), false);
  assert.equal(clients.unregister('owner', 'client', lease.clientToken), true);
  assert.deepEqual(clients.connections('owner'), []);
});
