import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mock, test } from 'node:test';
import { dotDohAddresses } from '../src/domains/cats/services/cloud-bridge/dot/dot-doh-answer.js';
import { createProxyDotWebhookSender } from '../src/domains/cats/services/cloud-bridge/dot/dot-proxy-doh.js';
import {
  createDotWebhookSender,
  dotWebhookHeaders,
  sendDotWebhookPinned,
  verifyDotWebhook,
} from '../src/domains/cats/services/cloud-bridge/dot/dot-webhook.js';
import { dotProxyFixture } from './helpers/dot-proxy-tls-fixture.js';

const secret = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;

test('opt-in proxy resolves safely despite system fake-IP and pins callback TLS on the same CONNECT socket', async () => {
  const f = await dotProxyFixture();
  let systemLookups = 0;
  mock.method(dns, 'lookup', async () => {
    systemLookups++;
    return [{ address: '198.18.0.85', family: 4 }];
  });
  syncBuiltinESMExports();
  try {
    await verifyDotWebhook(
      'https://callback.example.com:8443/events?channel=dot',
      'sub_A',
      secret,
      createDotWebhookSender(f.proxyUrl),
    );
    assert.equal(systemLookups, 0);
    assert.deepEqual(f.connects.sort(), ['dns.google:443', 'dns.google:443', '93.184.216.34:8443'].sort());
    assert.equal(f.callbacks.length, 1);
    assert.equal(f.callbacks[0]?.sni, 'callback.example.com');
    assert.equal(f.callbacks[0]?.host, 'callback.example.com:8443');
    assert.equal(f.callbacks[0]?.path, '/events?channel=dot');
    assert.equal(f.callbacks[0]?.headers['x-mcp-subscription-id'], 'sub_A');
    const request = f.callbacks[0];
    assert.ok(request);
    const expected = dotWebhookHeaders(
      String(request.headers['webhook-id']),
      'sub_A',
      secret,
      request.body,
      Number(request.headers['webhook-timestamp']) * 1000,
    );
    assert.equal(request.headers['webhook-signature'], expected['webhook-signature']);
    assert.equal(f.queries.length, 2);
    assert.ok(f.queries.every((q) => !q.includes('channel') && !q.includes('whsec_')));
  } finally {
    await f.close();
    syncBuiltinESMExports();
  }
});

test('proxy transport is opt-in and rejects remote, authenticated or ambiguous proxy configuration', () => {
  assert.equal(createDotWebhookSender(), sendDotWebhookPinned);
  for (const url of [
    '',
    'http://localhost:7897',
    'https://127.0.0.1:7897',
    'http://example.com:7897',
    'http://user:password@127.0.0.1:7897',
    'http://127.0.0.1',
    'http://127.0.0.1:7897/path',
    'http://127.0.0.1:7897?token=secret',
    'http://127.0.0.1:7897#fragment',
  ])
    assert.throws(() => createDotWebhookSender(url), /invalid_dot_proxy_url/);
});

function dnsAnswer(type: 1 | 28, Answer: unknown[] = []) {
  return { Status: 0, TC: false, Question: [{ name: 'callback.example.com.', type }], Answer };
}

test('DNS questions, families and complete CNAME chains are validated before selecting any IP', () => {
  const alias = { name: 'callback.example.com.', type: 5, data: 'edge.example.com.' };
  const address = { name: 'edge.example.com.', type: 1, data: '93.184.216.34' };
  assert.deepEqual(dotDohAddresses('callback.example.com', 1, dnsAnswer(1, [alias, address])), ['93.184.216.34']);
  assert.deepEqual(dotDohAddresses('callback.example.com', 28, dnsAnswer(28)), []);
  const bad = [
    dnsAnswer(1, [alias, { name: 'edge.example.com.', type: 5, data: 'callback.example.com.' }]),
    dnsAnswer(1, [{ name: 'callback.example.com.', type: 1, data: 'not-an-ip.example.com' }]),
    dnsAnswer(1, [{ name: 'callback.example.com.', type: 1, data: '2606:4700:4700::1111' }]),
    dnsAnswer(28, [{ name: 'callback.example.com.', type: 28, data: '93.184.216.34' }]),
    { ...dnsAnswer(1), TC: true },
    { ...dnsAnswer(1), Status: 2 },
    { ...dnsAnswer(1), Question: [{ name: 'other.example.com.', type: 1 }] },
    dnsAnswer(1, [alias, address, { name: 'unrelated.example.com.', type: 1, data: '10.0.0.1' }]),
  ];
  for (const answer of bad) {
    const type = (answer.Question[0]?.type ?? 1) as 1 | 28;
    assert.throws(() => dotDohAddresses('callback.example.com', type, answer), /callback_dns_/);
  }
  const deep = Array.from({ length: 10 }, (_, i) => ({
    name: i ? `edge${i}.example.com.` : 'callback.example.com.',
    type: 5,
    data: `edge${i + 1}.example.com.`,
  }));
  assert.throws(() => dotDohAddresses('callback.example.com', 1, dnsAnswer(1, deep)), /incomplete_answer/);
});

test('complete A/AAAA set refuses mixed public/fake-IP, loopback, private and mapped IPv6 before callback CONNECT', async () => {
  const f = await dotProxyFixture();
  try {
    const send = createDotWebhookSender(f.proxyUrl);
    for (const address of ['198.18.0.85', '127.0.0.1', '10.0.0.1']) {
      f.settings.a = ['93.184.216.34', address];
      await assert.rejects(() => send('https://callback.example.com/events', {}, '{}'), /private\/reserved/);
    }
    for (const address of ['::1', 'fc00::1', '::ffff:10.0.0.1']) {
      f.settings.a = ['93.184.216.34'];
      f.settings.aaaa = [address];
      await assert.rejects(() => send('https://callback.example.com/events', {}, '{}'), /private\/reserved/);
    }
    assert.ok(f.connects.every((target) => target === 'dns.google:443'));
    assert.equal(f.callbacks.length, 0);
  } finally {
    await f.close();
  }
});

test('IPv6-only valid answer pins bracketed CONNECT; 302 is returned without a second POST', async () => {
  const f = await dotProxyFixture();
  try {
    f.settings.a = [];
    f.settings.aaaa = ['2606:4700:4700::1111'];
    f.settings.status = 302;
    const response = await createDotWebhookSender(f.proxyUrl)('https://callback.example.com/events', {}, '{}');
    assert.equal(response.status, 302);
    assert.equal(f.callbacks.length, 1);
    assert.equal(f.connects.at(-1), '[2606:4700:4700::1111]:443');
  } finally {
    await f.close();
  }
});

test('invalid callback URLs, bad DNS JSON, failed CONNECT and untrusted certificates never fall back', async () => {
  const f = await dotProxyFixture();
  try {
    const send = createDotWebhookSender(f.proxyUrl);
    for (const url of [
      'http://callback.example.com/events',
      'https://user:pass@callback.example.com/',
      'https://callback.example.com/#fragment',
      'https://127.0.0.1/events',
    ])
      await assert.rejects(() => send(url, {}, '{}'));
    assert.equal(f.connects.length, 0);
    f.settings.dnsText = 'not-json';
    await assert.rejects(() => send('https://callback.example.com/events', {}, '{}'), /invalid_response/);
    f.settings.dnsText = 'x'.repeat(64 * 1024 + 1);
    await assert.rejects(() => send('https://callback.example.com/events', {}, '{}'), /response_too_large/);
    f.settings.dnsText = undefined;
    f.settings.connectStatus = 502;
    await assert.rejects(() => send('https://callback.example.com/events', {}, '{}'), /proxy_connect_failed/);
    f.settings.connectStatus = 200;
    f.settings.trustCertificate = false;
    await assert.rejects(() => send('https://callback.example.com/events', {}, '{}'), /self-signed/);
    assert.equal(f.callbacks.length, 0);
    assert.ok(f.connects.every((target) => target === 'dns.google:443'));
  } finally {
    await f.close();
  }
});

test('DNS total address count is bounded across both families and empty answers cannot open callback CONNECT', async () => {
  const f = await dotProxyFixture();
  try {
    f.settings.a = Array.from({ length: 32 }, () => '93.184.216.34');
    f.settings.aaaa = ['2606:4700:4700::1111'];
    const send = createDotWebhookSender(f.proxyUrl);
    await assert.rejects(() => send('https://callback.example.com/events', {}, '{}'), /invalid_response/);
    f.settings.a = [];
    f.settings.aaaa = [];
    await assert.rejects(() => send('https://callback.example.com/events', {}, '{}'), /invalid_response/);
    assert.ok(f.connects.every((target) => target === 'dns.google:443'));
  } finally {
    await f.close();
  }
});

// Advance only the production timers; real loopback TLS/HTTP still reaches both DNS consumers.
async function waitForIo(predicate: () => boolean) {
  const until = performance.now() + 2000;
  while (!predicate()) {
    assert.ok(performance.now() < until, 'loopback I/O did not reach its observation barrier');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

test('A and AAAA remain pending before the shared five-second deadline, then both close', async (t) => {
  const f = await dotProxyFixture();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    f.settings.dnsDelayMs = 20_000;
    let settled = false;
    const request = createDotWebhookSender(f.proxyUrl)('https://callback.example.com/events', {}, '{}');
    const rejected = assert.rejects(
      request.finally(() => {
        settled = true;
      }),
      /callback_dns_timeout/,
    );
    await waitForIo(() => f.queries.length === 2);
    assert.ok(f.queries.some((q) => q.includes('type=1&')));
    assert.ok(f.queries.some((q) => q.includes('type=28&')));
    t.mock.timers.tick(4999);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false, 'the complete five-second budget must be available');
    assert.ok(f.clientSockets.size > 0);
    t.mock.timers.tick(1);
    await rejected;
    await waitForIo(() => f.clientSockets.size === 0);
    assert.equal(f.callbacks.length, 0);
  } finally {
    t.mock.timers.reset();
    await f.close();
  }
});

test('both DNS families can finish after four seconds and still deliver within the DNS budget', async (t) => {
  const f = await dotProxyFixture();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    f.settings.dnsDelayMs = 4000;
    let failure: unknown;
    const request = createDotWebhookSender(f.proxyUrl)('https://callback.example.com/events', {}, '{}');
    // Attach the rejection observer before advancing timers, including on a broken early deadline.
    const result = request.catch((error: unknown) => {
      failure = error;
      return null;
    });
    await waitForIo(() => f.queries.length === 2);
    t.mock.timers.tick(4000);
    const response = await result;
    assert.equal(failure, undefined, 'valid DNS replies within five seconds must not be cancelled early');
    assert.equal(response?.status, 200);
    assert.equal(f.callbacks.length, 1);
    assert.equal(f.connects.filter((target) => target !== 'dns.google:443').length, 1);
  } finally {
    t.mock.timers.reset();
    await f.close();
  }
});

for (const stage of ['dns', 'connect', 'tls', 'stream'] as const) {
  test(`total wall-clock deadline cancels ${stage} and destroys resources without POST retries`, async () => {
    const f = await dotProxyFixture();
    try {
      if (stage === 'dns') f.settings.dnsDelayMs = 300;
      if (stage === 'connect') f.settings.stallConnect = true;
      if (stage === 'tls') f.settings.stallTls = true;
      if (stage === 'stream') f.settings.streamForever = true;
      const started = performance.now();
      await assert.rejects(
        () => createProxyDotWebhookSender(f.proxyUrl, 120)('https://callback.example.com/events', {}, '{}'),
        /callback_timeout/,
      );
      assert.ok(performance.now() - started < 600);
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(f.clientSockets.size, 0);
      assert.equal(f.callbacks.length, stage === 'stream' ? 1 : 0);
    } finally {
      await f.close();
    }
  });
}

test('bounded callback response stops oversized streaming without retaining a subscription challenge', async () => {
  const f = await dotProxyFixture();
  try {
    f.settings.callbackText = 'x'.repeat(64 * 1024 + 1);
    await assert.rejects(
      () =>
        verifyDotWebhook('https://callback.example.com/events', 'sub_A', secret, createDotWebhookSender(f.proxyUrl)),
      /callback_response_too_large/,
    );
    assert.equal(f.callbacks.length, 1);
  } finally {
    await f.close();
  }
});

for (const family of [1, 28] as const) {
  test(`CNAME to a single-family target accepts complete NODATA for the other family (${family})`, async () => {
    const f = await dotProxyFixture();
    try {
      const chain = [
        { name: 'callback.example.com.', type: 5, data: 'first.example.com.' },
        { name: 'first.example.com.', type: 5, data: 'edge.example.com.' },
      ];
      const address = family === 1 ? '93.184.216.34' : '2606:4700:4700::1111';
      f.settings.dnsByType[1] = dnsAnswer(
        1,
        family === 1 ? [...chain, { name: 'edge.example.com.', type: 1, data: address }] : chain,
      );
      f.settings.dnsByType[28] = dnsAnswer(
        28,
        family === 28 ? [...chain, { name: 'edge.example.com.', type: 28, data: address }] : chain,
      );
      await verifyDotWebhook(
        'https://callback.example.com/events',
        'sub_A',
        secret,
        createDotWebhookSender(f.proxyUrl),
      );
      assert.equal(f.callbacks.length, 1);
      assert.equal(f.connects.at(-1), family === 1 ? `${address}:443` : `[${address}]:443`);
      f.callbacks.length = 0;
      f.connects.length = 0;
      // Both complete NODATA families still mean there is no usable endpoint.
      f.settings.dnsByType[family] = dnsAnswer(family, chain);
      await assert.rejects(
        () => createDotWebhookSender(f.proxyUrl)('https://callback.example.com/events', {}, '{}'),
        /invalid_response/,
      );
      assert.ok(f.connects.every((target) => target === 'dns.google:443'));
      assert.equal(f.callbacks.length, 0);
    } finally {
      await f.close();
    }
  });
}

for (const phase of ['connect', 'response'] as const) {
  test(`phase deadline reports callback_${phase}_timeout and destroys sockets`, async () => {
    const f = await dotProxyFixture();
    try {
      if (phase === 'connect') f.settings.stallCallbackConnect = true;
      else f.settings.streamForever = true;
      await assert.rejects(
        () => createDotWebhookSender(f.proxyUrl)('https://callback.example.com/events', {}, '{}'),
        new RegExp(`callback_${phase}_timeout`),
      );
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(f.clientSockets.size, 0);
    } finally {
      await f.close();
    }
  });
}

test('invalid startup proxy identifies the application option without echoing its value', () => {
  assert.throws(
    () => createDotWebhookSender('http://user:private-password@127.0.0.1:7897'),
    (error) =>
      error instanceof Error &&
      error.message.includes('CAT_CAFE_DOT_WEBHOOK_PROXY_URL') &&
      !error.message.includes('private-password'),
  );
});
