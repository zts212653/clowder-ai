import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  authorizePersonalChromeConversation,
  readPersonalChromeConversationAuthorizations,
  revokePersonalChromeConversation,
} from '../src/plugins/cloud-cat-personal-host/native-host/conversation-binding.mjs';
import { createConversationTitleExchange } from '../src/plugins/cloud-cat-personal-host/native-host/conversation-title-exchange.mjs';
import {
  conversationTitlesPath,
  projectConversationTitles,
  readConversationTitles,
} from '../src/plugins/cloud-cat-personal-host/native-host/conversation-titles.mjs';

const stamp = '2026-09-05T10:00:00.000Z';
const later = '2026-09-05T10:00:01.000Z';
const authorization = (authorizedAt = stamp) => ({
  conversationId: 'one',
  chatUrl: 'https://chatgpt.com/c/one',
  authorizedAt,
  updatedAt: authorizedAt,
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'f247-title-guards-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'authorizations.json');
  await authorizePersonalChromeConversation(path, authorization());
  let request;
  let instant = new Date(later);
  const exchange = createConversationTitleExchange({
    authorizationPath: path,
    now: () => instant,
    sendNative: async (message) => {
      request = message;
    },
  });
  const query = async () => {
    await exchange({ v: 1, kind: 'query_conversation_titles' });
    return request;
  };
  const result = (titles = [{ conversationId: 'one', displayTitle: '小星星工作室' }], requestId = request.requestId) =>
    exchange({ v: 1, kind: 'conversation_title_result', requestId, titles });
  return {
    root,
    path,
    query,
    result,
    advance: () => {
      instant = new Date('2026-09-05T10:01:00.000Z');
    },
  };
}

test('title persists independently of an exchange instance, owner-private and unable to alter authority', async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.path, 'utf8');
  await f.query();
  await f.result();
  const titles = await readConversationTitles(f.path);
  const collection = await readPersonalChromeConversationAuthorizations(f.path);
  assert.equal(projectConversationTitles(collection.conversations, titles)[0].displayTitle, '小星星工作室');
  assert.equal((await stat(conversationTitlesPath(f.path))).mode & 0o777, 0o600);
  assert.equal(await readFile(f.path, 'utf8'), before);
  assert.equal(projectConversationTitles([authorization(later)], titles)[0].displayTitle, undefined);
});

test('nonce, expiry, one-use, exact membership and response shape fence presentation updates', async (t) => {
  const f = await fixture(t);
  await f.query();
  await f.result(undefined, 'unrequested-nonce');
  assert.deepEqual(await readConversationTitles(f.path), []);
  await f.result();
  await f.result([{ conversationId: 'one', displayTitle: 'replayed' }]);
  assert.equal((await readConversationTitles(f.path))[0].displayTitle, '小星星工作室');
  for (const titles of [
    [{ conversationId: 'other', displayTitle: 'unauthorized' }],
    [{ conversationId: 'one', displayTitle: 'bad', chatUrl: 'https://evil.example/' }],
    [{ conversationId: 'one', displayTitle: 'bad\u202e' }],
    [{ conversationId: 'one', displayTitle: 'x'.repeat(161) }],
    [
      { conversationId: 'one', displayTitle: 'one' },
      { conversationId: 'one', displayTitle: 'duplicate' },
    ],
  ]) {
    await f.query();
    await f.result(titles);
    assert.equal((await readConversationTitles(f.path))[0].displayTitle, '小星星工作室');
  }
  await f.query();
  f.advance();
  await f.result([{ conversationId: 'one', displayTitle: 'expired' }]);
  assert.equal((await readConversationTitles(f.path))[0].displayTitle, '小星星工作室');
});

test('revoke prunes persisted titles and an in-flight response cannot attach to a regrant', async (t) => {
  const f = await fixture(t);
  await f.query();
  await f.result();
  await f.query();
  await revokePersonalChromeConversation(f.path, 'one', later);
  assert.deepEqual(await readConversationTitles(f.path), []);
  await authorizePersonalChromeConversation(f.path, authorization(later));
  await f.result([{ conversationId: 'one', displayTitle: 'stale response' }]);
  assert.deepEqual(await readConversationTitles(f.path), []);
  assert.equal((await readPersonalChromeConversationAuthorizations(f.path)).conversations.length, 1);
});

test('corrupt, oversized, broadly-readable and symlink sidecars never contaminate authorization', async (t) => {
  const f = await fixture(t);
  await f.query();
  await f.result();
  const titlePath = conversationTitlesPath(f.path);
  const good = await readFile(titlePath);
  const before = await readFile(f.path, 'utf8');
  for (const value of ['not json', 'x'.repeat(65 * 1024)]) {
    await writeFile(titlePath, value);
    assert.deepEqual(await readConversationTitles(f.path), []);
  }
  await writeFile(titlePath, good);
  await chmod(titlePath, 0o644);
  assert.deepEqual(await readConversationTitles(f.path), []);
  await rm(titlePath);
  await symlink(f.path, titlePath);
  assert.deepEqual(await readConversationTitles(f.path), []);
  assert.equal(await readFile(f.path, 'utf8'), before);
  assert.equal((await readPersonalChromeConversationAuthorizations(f.path)).conversations.length, 1);
});
