const assert = require('node:assert/strict');
const { test } = require('node:test');
const { HostApiHost } = require('./host-api.cjs');
const json = (value, headers = {}) => new Response(JSON.stringify(value), { headers });

test('Host adapter keeps the owner cookie in main and admits before exposing a voice answer', async () => {
  const requests = [];
  const events = [];
  const host = new HostApiHost({
    apiUrl: 'http://127.0.0.1:3383',
    allowHomeReads: true,
    fetcher: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith('/api/session'))
        return json({ userId: 'owner' }, { 'set-cookie': 'cat_cafe_session=private; HttpOnly; Path=/' });
      if (url.endsWith('/start')) return json({ answer: 'synthetic-answer' });
      return json({ callId: 'call', state: 'ready', toolsReady: false });
    },
  });
  host.on('event', (event) => events.push(event));
  try {
    await host.prepare();
    assert.equal(JSON.parse(requests[1].options.body).allowHomeReads, true);
    assert.equal(
      'catId' in JSON.parse(requests[1].options.body),
      false,
      'execution identity comes only from Host config',
    );
    assert.equal(requests[1].options.headers.cookie, 'cat_cafe_session=private');
    assert.equal(events.length, 0, 'configured tools are not yet a successful read');
    await host.request('start', { sdp: 'synthetic-offer' });
    assert.deepEqual(events, [{ type: 'answer', sdp: 'synthetic-answer' }]);
    assert.equal(JSON.stringify(events).includes('private'), false);
  } finally {
    await host.stop();
  }
  assert.equal(host.child, null);
  assert.equal(requests.at(-1).options.method, 'DELETE');
});

test('cancel during Host admission cleans a late call instead of arming it', async () => {
  let resolveAdmission;
  let entered;
  const posted = new Promise((resolve) => {
    entered = resolve;
  });
  const methods = [];
  const host = new HostApiHost({
    apiUrl: 'http://127.0.0.1:3383',
    fetcher: async (url, options) => {
      methods.push(options.method);
      if (url.endsWith('/api/session')) return json({});
      if (options.method === 'POST') {
        entered();
        return new Promise((resolve) => {
          resolveAdmission = resolve;
        });
      }
      return json({ stopped: true });
    },
  });
  const pending = host.prepare();
  await posted;
  const finishing = host.stop();
  resolveAdmission(json({ callId: 'late', state: 'ready' }));
  await assert.rejects(pending, /取消/);
  await finishing;
  assert.equal(host.child, null);
  assert.deepEqual(methods, ['GET', 'POST', 'DELETE']);
});

test('Host origin cannot redirect cookies or user input outside the explicit local API', () => {
  for (const apiUrl of [
    'https://example.com',
    'http://user:pass@localhost:3383',
    'http://localhost:3383/path',
    'http://localhost:3383/?next=remote',
  ])
    assert.throws(() => new HostApiHost({ apiUrl }), /loopback/);
});

test('Host health diagnostics retain disconnect causes without conversation or credentials', () => {
  const logs = [];
  const host = new HostApiHost({ apiUrl: 'http://127.0.0.1:3383', reportHealth: (event) => logs.push(event) });
  host.record({ type: 'transcript', text: 'private conversation' });
  host.record({ type: 'typed-input', text: 'private request' });
  host.record({ type: 'error', reason: 'disconnect-timeout', message: 'private provider payload', token: 'secret' });
  host.record({ type: 'transport', state: 'disconnected', ice: 'failed', signaling: 'stable', sdp: 'secret' });
  assert.equal(logs.length, 2);
  assert.equal(logs[0].reason, 'disconnect-timeout');
  assert.equal(logs[1].state, 'disconnected');
  assert.doesNotMatch(JSON.stringify(logs), /private|secret/);
  host.record({ type: 'error', reason: 'private provider payload' });
  assert.equal(logs.at(-1).reason, 'unclassified');
});

test('Host terminal status tells the desktop to close instead of leaving a connected voice surface', () => {
  const host = new HostApiHost({ apiUrl: 'http://127.0.0.1:3383' });
  const events = [];
  host.on('event', (event) => events.push(event));
  host.publishStatus({ state: 'failed', toolsReady: false });
  assert.deepEqual(events, [{ type: 'closed', reason: 'Host call failed' }]);
});
