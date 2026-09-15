import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
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
  const exchange = createConversationTitleExchange({
    authorizationPath: path,
    sendNative: async (message) => messages.push(message),
    timeoutMs: 50,
  });
  t.after(() => exchange.stop());
  return { root, path, messages, exchange };
}

test('concurrent refreshes share a nonce and only acknowledge persisted current grants', async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.path, 'utf8');
  const results = [
    f.exchange.refreshRequest(request('one'), revision),
    f.exchange.refreshRequest(request('two'), revision),
  ];
  while (!f.messages.length) await delay(1);
  assert.equal(f.messages.length, 1);
  await f.exchange({
    v: 1,
    kind: 'conversation_title_result',
    requestId: f.messages[0].requestId,
    titles: [{ conversationId: 'one', displayTitle: '真实名称' }],
  });
  for (const receipt of await Promise.all(results)) {
    assert.equal(receipt.status, 'synced');
    assert.equal(receipt.updatedCount, 1);
  }
  assert.equal(await readFile(f.path, 'utf8'), before);
  assert.equal((await readConversationTitles(f.path))[0].displayTitle, '真实名称');
});

test('no readable title, revoked grant, timeout and stop never report an invented update', async (t) => {
  const f = await fixture(t);
  let receipt = f.exchange.refreshRequest(request(), revision);
  while (!f.messages.length) await delay(1);
  await f.exchange({ v: 1, kind: 'conversation_title_result', requestId: f.messages.at(-1).requestId, titles: [] });
  assert.equal((await receipt).updatedCount, 0);
  receipt = f.exchange.refreshRequest(request(), revision);
  while (f.messages.length < 2) await delay(1);
  await revokePersonalChromeConversation(f.path, 'one', '2026-09-06T01:00:00.000Z');
  await f.exchange({
    v: 1,
    kind: 'conversation_title_result',
    requestId: f.messages.at(-1).requestId,
    titles: [{ conversationId: 'one', displayTitle: 'revoked' }],
  });
  assert.equal((await receipt).updatedCount, 0);
  assert.deepEqual(await readConversationTitles(f.path), []);
  const second = await fixture(t);
  receipt = second.exchange.refreshRequest(request(), revision);
  await delay(80);
  assert.equal((await receipt).errorCode, 'TITLE_SYNC_TIMEOUT');
  receipt = second.exchange.refreshRequest(request(), revision);
  second.exchange.stop();
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

test('an unresponsive Native write cannot hold the owner refresh beyond its deadline', async (t) => {
  const f = await fixture(t);
  const exchange = createConversationTitleExchange({
    authorizationPath: f.path,
    sendNative: () => new Promise(() => {}),
    timeoutMs: 30,
  });
  t.after(() => exchange.stop());
  const receipt = exchange.refreshRequest(request(), revision);
  await delay(60);
  assert.equal((await receipt).errorCode, 'TITLE_SYNC_TIMEOUT');
});
