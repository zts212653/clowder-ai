const assert = require('node:assert/strict');
const { test } = require('node:test');
const { HostApiHost } = require('./host-api.cjs');

function hostWithFailure(status, body) {
  return new HostApiHost({
    apiUrl: 'http://127.0.0.1:3383',
    fetcher: async () => new Response(JSON.stringify(body), { status }),
  });
}

test('unsupported voice capability does not tell the user to wait for an active call', async () => {
  const host = hostWithFailure(409, { code: 'live_native_unavailable' });
  await assert.rejects(host.requestApi('/api/concierge/live', 'POST', {}), (error) => {
    assert.equal(error.code, 'live_native_unavailable');
    assert.equal(error.retryable, false);
    assert.match(error.message, /语音能力尚未接通/);
    assert.doesNotMatch(error.message, /稍后重试|准备或收尾/);
    return true;
  });
});

test('only a known busy-call conflict suggests retrying later', async () => {
  const busy = hostWithFailure(409, { code: 'live_call_active' });
  await assert.rejects(busy.requestApi('/api/concierge/live'), (error) => {
    assert.equal(error.retryable, true);
    assert.match(error.message, /稍后重试/);
    return true;
  });
  const unknown = hostWithFailure(409, { error: 'provider payload private-token', code: 'toString' });
  await assert.rejects(unknown.requestApi('/api/concierge/live'), (error) => {
    assert.equal(error.retryable, false);
    assert.doesNotMatch(error.message, /稍后重试|private-token|provider payload/);
    return true;
  });
});

test('scope denial cannot be presented as a busy call even with a mismatched code', async () => {
  const host = hostWithFailure(403, { code: 'live_call_active', error: 'private runtime context' });
  await assert.rejects(host.requestApi('/api/concierge/live'), (error) => {
    assert.equal(error.code, 'live_access_denied');
    assert.equal(error.retryable, false);
    assert.match(error.message, /访问/);
    assert.doesNotMatch(error.message, /稍后重试|private runtime context/);
    return true;
  });
});

test('an unreadable error body has a safe actionable fallback', async () => {
  const host = new HostApiHost({
    apiUrl: 'http://127.0.0.1:3383',
    fetcher: async () => new Response('private non-JSON body', { status: 503 }),
  });
  await assert.rejects(host.requestApi('/api/concierge/live'), (error) => {
    assert.equal(error.code, 'live_connection_unavailable');
    assert.doesNotMatch(error.message, /private|JSON/);
    return true;
  });
});
