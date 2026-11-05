import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { CLIENT_REQUEST_DIAGNOSTIC_HEADER } from '@cat-cafe/shared';
import { createFixtureApi } from './browser/f311-workspace-browser.harness.mjs';

const webOrigin = 'http://127.0.0.1:43111';
const programPath = '/api/capability-evolution/programs/fixture';

async function fixture(t) {
  const programWrites = [];
  const api = createFixtureApi({
    programPath,
    programReads: new Map(),
    programWrites,
    thread: { id: 'fixture', projectPath: '/fixture' },
    browserOrigin: () => webOrigin,
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  t.after(async () => {
    api.closeAllConnections();
    await new Promise((resolve) => api.close(resolve));
  });
  return { url: `http://127.0.0.1:${api.address().port}`, programWrites };
}

test('the document runtime API origin permits credentialed reads from its owned Web server', async (t) => {
  const f = await fixture(t);
  const response = await fetch(`${f.url}/api/session`, { headers: { origin: webOrigin } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).userId, 'default-user');
  assert.equal(response.headers.get('access-control-allow-origin'), webOrigin);
  assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
});

test('server-side reads without an Origin remain available without a CORS grant', async (t) => {
  const f = await fixture(t);
  const response = await fetch(`${f.url}/api/session`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).userId, 'default-user');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('owned API preflight settles without a Program write and refuses foreign origins', async (t) => {
  const f = await fixture(t);
  const response = await fetch(`${f.url}${programPath}`, {
    method: 'OPTIONS',
    headers: {
      origin: webOrigin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': CLIENT_REQUEST_DIAGNOSTIC_HEADER,
    },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), webOrigin);
  assert.match(response.headers.get('access-control-allow-headers'), /x-csrf-token/i);
  assert.ok(
    response.headers
      .get('access-control-allow-headers')
      .toLowerCase()
      .split(',')
      .map((header) => header.trim())
      .includes(CLIENT_REQUEST_DIAGNOSTIC_HEADER),
    'the real client diagnostic header must pass preflight',
  );
  assert.deepEqual(f.programWrites, []);
  const foreign = await fetch(`${f.url}${programPath}`, {
    method: 'OPTIONS',
    headers: { origin: 'https://foreign.invalid', 'access-control-request-method': 'POST' },
  });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(f.programWrites, []);
});

test('allowing the fixture Web origin does not authorize Program mutations', async (t) => {
  const f = await fixture(t);
  const response = await fetch(`${f.url}${programPath}`, { method: 'POST', headers: { origin: webOrigin } });
  assert.equal(response.status, 405);
  assert.deepEqual(await response.json(), { error: 'read_only_contract_fixture' });
  assert.deepEqual(f.programWrites, [{ method: 'POST', path: programPath }]);
});
