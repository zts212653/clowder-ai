import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseConversationTitleRefreshResult } from '../scripts/f247-personal-chrome-title-refresh.mjs';
import {
  authorizePersonalChromeConversation,
  revokePersonalChromeConversation,
} from '../src/plugins/cloud-cat-personal-host/native-host/conversation-binding.mjs';
import { createConversationTitleExchange } from '../src/plugins/cloud-cat-personal-host/native-host/conversation-title-exchange.mjs';
import { readConversationTitles } from '../src/plugins/cloud-cat-personal-host/native-host/conversation-titles.mjs';
import { createNativeHostBridge } from '../src/plugins/cloud-cat-personal-host/native-host/native-host.mjs';

const revision = `sha512:${'a'.repeat(128)}`;
const request = (requestId = 'refresh') => ({
  v: 1,
  kind: 'refresh_conversation_titles',
  requestId,
  expectedHelperRevision: revision,
});
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'f247-refresh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'authorization.json');
  const stamp = '2026-09-05T10:00:00.000Z';
  await authorizePersonalChromeConversation(path, {
    conversationId: 'one',
    chatUrl: 'https://chatgpt.com/c/one',
    authorizedAt: stamp,
    updatedAt: stamp,
  });
  const messages = [];
  const native = new EventEmitter();
  const exchange = createConversationTitleExchange({
    authorizationPath: path,
    sendNative: async (message) => {
      messages.push(message);
      native.emit('message', message);
    },
    timeoutMs: 50,
  });
  t.after(() => exchange.stop());
  return { root, path, messages, native, exchange };
}

test(
  'concurrent refreshes share a nonce and only acknowledge persisted current grants',
  { timeout: 5000 },
  async (t) => {
    // Real authorization/lease/fsync work must not race a 50ms wall-clock deadline.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = await fixture(t);
    const before = await readFile(f.path, 'utf8');
    const probe = await open(join(f.root, 'sync-probe'), 'wx', 0o600);
    const prototype = Object.getPrototypeOf(probe);
    const originalSync = prototype.sync;
    await probe.close();
    const syncStarted = deferred();
    const releaseSync = deferred();
    t.mock.method(prototype, 'sync', async function sync() {
      syncStarted.resolve();
      await releaseSync.promise;
      return originalSync.call(this);
    });
    const sent = once(f.native, 'message');
    const receipts = [];
    const results = [
      f.exchange.refreshRequest(request('one'), revision),
      f.exchange.refreshRequest(request('two'), revision),
    ].map((result) => result.then((receipt) => receipts.push(receipt)));
    const [query] = await sent;
    assert.equal(f.messages.length, 1);
    const accepted = f.exchange({
      v: 1,
      kind: 'conversation_title_result',
      requestId: query.requestId,
      titles: [{ conversationId: 'one', displayTitle: '真实名称' }],
    });
    try {
      await syncStarted.promise;
      t.mock.timers.tick(49);
      assert.deepEqual(await readConversationTitles(f.path), []);
      assert.deepEqual(receipts, [], 'refresh must await the durable title write');
    } finally {
      releaseSync.resolve();
      await accepted;
    }
    await Promise.all(results);
    assert.deepEqual(receipts.map(({ requestId }) => requestId).sort(), ['one', 'two']);
    for (const receipt of receipts) {
      assert.equal(receipt.status, 'synced', JSON.stringify(receipt));
      assert.equal(receipt.updatedCount, 1);
    }
    assert.equal(await readFile(f.path, 'utf8'), before);
    assert.equal((await readConversationTitles(f.path))[0].displayTitle, '真实名称');
  },
);

test('no readable title and revoked grant never report an invented update', { timeout: 5000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t);
  let sent = once(f.native, 'message');
  let receipt = f.exchange.refreshRequest(request(), revision);
  await sent;
  await f.exchange({ v: 1, kind: 'conversation_title_result', requestId: f.messages.at(-1).requestId, titles: [] });
  assert.equal((await receipt).status, 'synced');
  assert.equal((await receipt).updatedCount, 0);
  sent = once(f.native, 'message');
  receipt = f.exchange.refreshRequest(request(), revision);
  await sent;
  await revokePersonalChromeConversation(f.path, 'one', '2026-09-06T01:00:00.000Z');
  await f.exchange({
    v: 1,
    kind: 'conversation_title_result',
    requestId: f.messages.at(-1).requestId,
    titles: [{ conversationId: 'one', displayTitle: 'revoked' }],
  });
  assert.equal((await receipt).status, 'synced');
  assert.equal((await receipt).updatedCount, 0);
  assert.deepEqual(await readConversationTitles(f.path), []);
});

test('timeout and stop settle pending refreshes without accepting a late title', { timeout: 5000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t);
  let sent = once(f.native, 'message');
  let settled = false;
  let receipt = f.exchange.refreshRequest(request(), revision).then((result) => {
    settled = true;
    return result;
  });
  const [query] = await sent;
  t.mock.timers.tick(49);
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  assert.equal((await receipt).errorCode, 'TITLE_SYNC_TIMEOUT');
  await f.exchange({
    v: 1,
    kind: 'conversation_title_result',
    requestId: query.requestId,
    titles: [{ conversationId: 'one', displayTitle: 'too late' }],
  });
  assert.deepEqual(await readConversationTitles(f.path), []);
  sent = once(f.native, 'message');
  receipt = f.exchange.refreshRequest(request(), revision);
  await sent;
  f.exchange.stop();
  assert.equal((await receipt).errorCode, 'HOST_STOPPED');
});

function socketRequest(socketPath, envelope) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let input = '';
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(`${JSON.stringify(envelope)}\n`));
    socket.on('data', (chunk) => {
      input += chunk;
    });
    socket.once('end', () => resolve(JSON.parse(input)));
    socket.once('error', reject);
  });
}
test('the real socket rejects wrong pairing, changed Helper and request-supplied membership before querying Chrome', async (t) => {
  const f = await fixture(t);
  const bridge = await createNativeHostBridge({
    socketPath: join(f.root, 'native.sock'),
    ledgerPath: join(f.root, 'ledger.json'),
    conversationBindingPath: f.path,
    pairingSecret: 's'.repeat(64),
    helperArtifactRevision: revision,
    sendNative: async (message) => f.messages.push(message),
  });
  t.after(() => bridge.stop());
  for (const [envelope, expected] of [
    [{ pairingSecret: 'wrong', request: request() }, 'PAIRING_REJECTED'],
    [
      { pairingSecret: 's'.repeat(64), request: { ...request(), expectedHelperRevision: `sha512:${'b'.repeat(128)}` } },
      'STALE_HELPER',
    ],
    [{ pairingSecret: 's'.repeat(64), request: { ...request(), conversations: ['unauthorized'] } }, 'INVALID_REQUEST'],
  ])
    assert.equal((await socketRequest(bridge.socketPath, envelope)).errorCode, expected);
  assert.equal(f.messages.length, 0);
});

test('refresh receipts require an exact nonce and bounded counts, with no raw exception projection', () => {
  const valid = {
    v: 1,
    kind: 'conversation_titles_refreshed',
    requestId: 'one',
    status: 'synced',
    updatedCount: 1,
    requestedCount: 2,
  };
  assert.equal(parseConversationTitleRefreshResult(valid, 'one').status, 'synced');
  for (const value of [
    { ...valid, requestId: 'other' },
    { ...valid, updatedCount: 3 },
    { ...valid, requestedCount: 33 },
    { ...valid, updatedCount: -1 },
    { ...valid, status: 'unavailable', errorCode: 'private /tmp/secret' },
  ]) {
    assert.deepEqual(parseConversationTitleRefreshResult(value, 'one'), {
      status: 'unavailable',
      errorCode: 'INVALID_TITLE_RECEIPT',
    });
  }
});

test('an unresponsive Native write cannot hold the owner refresh beyond its deadline', { timeout: 5000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t);
  const sending = deferred();
  const exchange = createConversationTitleExchange({
    authorizationPath: f.path,
    sendNative: () => {
      sending.resolve();
      return new Promise(() => {});
    },
    timeoutMs: 30,
  });
  t.after(() => exchange.stop());
  let settled = false;
  const receipt = exchange.refreshRequest(request(), revision).then((result) => {
    settled = true;
    return result;
  });
  await sending.promise;
  t.mock.timers.tick(29);
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  assert.equal((await receipt).errorCode, 'TITLE_SYNC_TIMEOUT');
});
