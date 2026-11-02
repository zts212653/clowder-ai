// @ts-check

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import webpush from 'web-push';
import { PushNotificationService } from '../dist/domains/cats/services/push/PushNotificationService.js';

const ENV_KEYS = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
  'WEB_PUSH_TIMEOUT_MS',
];

const BASE_SUB = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/test-sub',
  keys: { p256dh: 'key1', auth: 'auth1' },
  userId: 'owner',
  createdAt: Date.now(),
};

/** @type {Record<string, string | undefined>} */
let envSnapshot = {};

function resetLaunchEnv() {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

/**
 * @param {Record<string, string | undefined>} overrides
 */
function applyEnv(overrides) {
  resetLaunchEnv();
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === 'string') {
      process.env[key] = value;
    } else {
      delete process.env[key];
    }
  }
}

function createService() {
  const keys = webpush.generateVAPIDKeys();
  const store = {
    listAll: async () => [BASE_SUB],
    listByUser: async () => [BASE_SUB],
    upsert: async () => {},
    remove: async () => false,
    removeForUser: async () => 0,
  };
  return new PushNotificationService({
    subscriptionStore: store,
    vapidPublicKey: keys.publicKey,
    vapidPrivateKey: keys.privateKey,
    vapidSubject: 'mailto:test@example.com',
  });
}

describe('PushNotificationService sendNotification options', () => {
  beforeEach(() => {
    envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    resetLaunchEnv();
  });

  afterEach(() => {
    mock.restoreAll();
    for (const key of ENV_KEYS) {
      if (typeof envSnapshot[key] === 'string') {
        process.env[key] = envSnapshot[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it('uses default timeout when env is not set and does not pass proxy', async () => {
    const sendMock = mock.method(webpush, 'sendNotification', async () => ({ statusCode: 201 }));
    const service = createService();

    const summary = await service.notifyUser('owner', { title: 't', body: 'b' });

    assert.equal(sendMock.mock.calls.length, 1);
    const options = sendMock.mock.calls[0].arguments[2];
    assert.equal(options.TTL, 60 * 60);
    assert.equal(options.timeout, 10_000);
    assert.equal(options.proxy, undefined);
    assert.deepEqual(summary, { attempted: 1, delivered: 1, failed: 0, removed: 0 });
  });

  it('prefers HTTPS_PROXY and WEB_PUSH_TIMEOUT_MS when provided', async () => {
    applyEnv({
      HTTPS_PROXY: 'http://127.0.0.1:7897',
      HTTP_PROXY: 'http://127.0.0.1:8888',
      WEB_PUSH_TIMEOUT_MS: '12000',
    });
    const sendMock = mock.method(webpush, 'sendNotification', async () => ({ statusCode: 201 }));
    const service = createService();

    const summary = await service.notifyUser('owner', { title: 't', body: 'b' });

    assert.equal(sendMock.mock.calls.length, 1);
    const options = sendMock.mock.calls[0].arguments[2];
    assert.equal(options.proxy, 'http://127.0.0.1:7897');
    assert.equal(options.timeout, 12_000);
    assert.deepEqual(summary, { attempted: 1, delivered: 1, failed: 0, removed: 0 });
  });

  it('falls back to HTTP proxy and default timeout for invalid values', async () => {
    applyEnv({
      ALL_PROXY: 'socks5://127.0.0.1:7897',
      HTTP_PROXY: 'http://127.0.0.1:7897',
      WEB_PUSH_TIMEOUT_MS: 'NaN',
    });
    const sendMock = mock.method(webpush, 'sendNotification', async () => ({ statusCode: 201 }));
    const service = createService();

    const summary = await service.notifyUser('owner', { title: 't', body: 'b' });

    assert.equal(sendMock.mock.calls.length, 1);
    const options = sendMock.mock.calls[0].arguments[2];
    assert.equal(options.proxy, 'http://127.0.0.1:7897');
    assert.equal(options.timeout, 10_000);
    assert.deepEqual(summary, { attempted: 1, delivered: 1, failed: 0, removed: 0 });
  });

  it('returns failed summary when web-push send rejects', async () => {
    const sendMock = mock.method(webpush, 'sendNotification', async () => {
      throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    });
    const service = createService();

    const summary = await service.notifyUser('owner', { title: 't', body: 'b' });

    assert.equal(sendMock.mock.calls.length, 1);
    assert.deepEqual(summary, { attempted: 1, delivered: 0, failed: 1, removed: 0 });
  });
});
