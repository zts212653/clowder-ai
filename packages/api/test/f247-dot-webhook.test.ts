import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import dns from 'node:dns/promises';
import type { ClientRequest, IncomingMessage } from 'node:http';
import https, { type RequestOptions } from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough, Writable } from 'node:stream';
import { mock, test } from 'node:test';
import { dotWebhookHeaders, verifyDotWebhook } from '../src/domains/cats/services/cloud-bridge/dot/dot-webhook.js';

const secret = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;

test('verification pins the public IP while retaining the callback Host, port and TLS name', async () => {
  let captured: RequestOptions | undefined;
  let body = '';
  mock.method(dns, 'lookup', async () => [{ address: '93.184.216.34', family: 4 }]);
  syncBuiltinESMExports();
  mock.method(https, 'request', (options: RequestOptions, listener: (response: IncomingMessage) => void) => {
    captured = options;
    const response = new PassThrough() as unknown as IncomingMessage;
    response.statusCode = 200;
    const request = new Writable({
      write(chunk, _encoding, callback) {
        body += chunk.toString();
        callback();
      },
    }) as unknown as ClientRequest;
    request.once('finish', () => {
      listener(response);
      response.end(JSON.stringify({ challenge: JSON.parse(body).challenge }));
    });
    return request;
  });
  try {
    await verifyDotWebhook('https://callback.example.com:8443/events?channel=dot', 'sub_A', secret);
    assert.equal(captured?.hostname, '93.184.216.34');
    assert.equal(captured?.servername, 'callback.example.com');
    assert.equal(captured?.port, 8443);
    assert.equal(captured?.path, '/events?channel=dot');
    assert.equal(captured?.method, 'POST');
    const headers = captured?.headers as Record<string, string>;
    assert.equal(headers.Host, 'callback.example.com:8443');
    assert.equal(headers['X-MCP-Subscription-Id'], 'sub_A');
    assert.equal(headers['content-type'], 'application/json');
    const payload = JSON.parse(body);
    assert.equal(payload.type, 'verification');
    const expected = createHmac('sha256', Buffer.alloc(32, 7))
      .update(`${headers['webhook-id']}.${headers['webhook-timestamp']}.${body}`)
      .digest('base64');
    assert.equal(headers['webhook-signature'], `v1,${expected}`);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('verification refuses plaintext callback URLs before any outbound request', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      verifyDotWebhook('http://example.com/callback', 'subscription', secret, async (_url, _headers, body) => {
        calls++;
        return { status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) };
      }),
    /invalid_callback_url/,
  );
  assert.equal(calls, 0);
});

test('verification rejects a fake-IP DNS answer before opening the HTTPS connection', async () => {
  let requests = 0;
  mock.method(dns, 'lookup', async () => [{ address: '198.18.0.85', family: 4 }]);
  syncBuiltinESMExports();
  mock.method(https, 'request', () => {
    requests++;
    throw new Error('HTTPS must not run for non-public DNS');
  });
  try {
    await assert.rejects(
      () => verifyDotWebhook('https://callback.example.com/events', 'sub_A', secret),
      /private\/reserved/,
    );
    assert.equal(requests, 0);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('signs exact UTF-8 event bytes according to Standard Webhooks', () => {
  const body = JSON.stringify({ eventId: 'event_A', data: { text: '原对话' } });
  const headers = dotWebhookHeaders('event_A', 'sub_A', secret, body, 10000);
  const expected = createHmac('sha256', Buffer.alloc(32, 7)).update(`event_A.10.${body}`).digest('base64');
  assert.equal(headers['webhook-signature'], `v1,${expected}`);
  assert.equal(headers['webhook-id'], 'event_A');
  assert.equal(headers['X-MCP-Subscription-Id'], 'sub_A');
});

test('HTTP receipt alone cannot verify the subscription callback', async () => {
  await assert.rejects(
    () =>
      verifyDotWebhook('https://example.com/callback', 'sub_A', secret, async () => ({
        status: 200,
        body: '{"challenge":"wrong"}',
      })),
    /challenge_failed/,
  );
});

test('rotating a webhook key supplies both valid signatures over the identical event', () => {
  const next = `whsec_${Buffer.alloc(32, 8).toString('base64')}`;
  const body = '{"eventId":"rotation"}';
  const current = dotWebhookHeaders('rotation', 'sub_A', next, body, 10_000);
  const previous = dotWebhookHeaders('rotation', 'sub_A', secret, body, 10_000);
  const overlap = dotWebhookHeaders('rotation', 'sub_A', next, body, 10_000, secret);
  assert.equal(overlap['webhook-signature'], `${current['webhook-signature']} ${previous['webhook-signature']}`);
});
