import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  authorizePersonalChromeConversation,
  PERSONAL_CHROME_AUTHORIZATION_LIMIT,
  readPersonalChromeConversationAuthorizations,
  removePersonalChromeConversationAuthorizations,
  revokePersonalChromeConversation,
  validatePersonalChromeConversationAuthorizations,
  writePersonalChromeConversationAuthorizationsAtomic,
} from '../src/plugins/cloud-cat-personal-host/native-host/conversation-binding.mjs';

const roots = new Set();

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

async function testRoot() {
  const root = await mkdtemp(join(tmpdir(), 'cat-cafe-f247-authorization-'));
  roots.add(root);
  return root;
}

function authorization(conversationId = 'conversation-7', timestamp = '2026-08-21T07:00:00.000Z') {
  return {
    conversationId,
    chatUrl: `https://chatgpt.com/c/${conversationId}`,
    authorizedAt: timestamp,
    updatedAt: timestamp,
  };
}

function collection(conversations = [authorization()], updatedAt = '2026-08-21T07:00:00.000Z') {
  return {
    schemaVersion: 2,
    provider: 'chatgpt',
    conversations,
    updatedAt,
  };
}

function legacyBinding() {
  return {
    schemaVersion: 1,
    provider: 'chatgpt',
    conversationId: 'conversation-7',
    chatUrl: 'https://chatgpt.com/c/conversation-7',
    boundAt: '2026-08-21T07:00:00.000Z',
    updatedAt: '2026-08-21T07:00:00.000Z',
  };
}

describe('Personal Chrome conversation authorization collection', () => {
  it('accepts only a strict, unique, bounded schema-v2 collection', () => {
    assert.deepEqual(validatePersonalChromeConversationAuthorizations(collection()), collection());
    assert.throws(
      () =>
        validatePersonalChromeConversationAuthorizations(
          collection([authorization(), authorization('conversation-7', '2026-08-21T07:01:00.000Z')]),
        ),
      /duplicate conversationId/,
    );
    assert.throws(
      () =>
        validatePersonalChromeConversationAuthorizations(
          collection(
            Array.from({ length: PERSONAL_CHROME_AUTHORIZATION_LIMIT + 1 }, (_, index) =>
              authorization(`conversation-${index}`),
            ),
          ),
        ),
      /authorization limit/,
    );
    assert.throws(
      () =>
        validatePersonalChromeConversationAuthorizations(
          collection([{ ...authorization(), chatUrl: 'https://chatgpt.com/c/other' }]),
        ),
      /match conversationId/,
    );
    assert.throws(
      () => validatePersonalChromeConversationAuthorizations({ ...collection(), title: 'private' }),
      /unknown field/,
    );
  });

  it('migrates a valid schema-v1 binding losslessly into the first schema-v2 entry', async () => {
    const root = await testRoot();
    const path = join(root, 'conversation-binding.json');
    await writeFile(path, `${JSON.stringify(legacyBinding(), null, 2)}\n`, { mode: 0o600 });

    const migrated = await readPersonalChromeConversationAuthorizations(path);

    assert.deepEqual(migrated, collection());
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), collection());
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });

  it('appends two conversations, preserves both, and makes duplicate authorization retries byte-idempotent', async () => {
    const root = await testRoot();
    const path = join(root, 'conversation-binding.json');
    const first = authorization('conversation-7', '2026-08-21T07:00:00.000Z');
    const second = authorization('conversation-8', '2026-08-21T07:01:00.000Z');

    await authorizePersonalChromeConversation(path, first);
    await authorizePersonalChromeConversation(path, second);
    const beforeRetry = await readFile(path, 'utf8');
    await authorizePersonalChromeConversation(path, {
      ...second,
      authorizedAt: '2026-08-21T07:09:00.000Z',
      updatedAt: '2026-08-21T07:09:00.000Z',
    });

    assert.deepEqual(
      await readPersonalChromeConversationAuthorizations(path),
      collection([first, second], second.updatedAt),
    );
    assert.equal(await readFile(path, 'utf8'), beforeRetry);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(root), ['conversation-binding.json']);
  });

  it('keeps collection time monotonic when the local clock moves backward', async () => {
    const root = await testRoot();
    const path = join(root, 'conversation-binding.json');
    const first = authorization('conversation-7', '2026-08-21T07:02:00.000Z');
    const second = authorization('conversation-8', '2026-08-21T07:01:00.000Z');
    await authorizePersonalChromeConversation(path, first);

    const appended = await authorizePersonalChromeConversation(path, second);
    const revoked = await revokePersonalChromeConversation(path, first.conversationId, '2026-08-21T07:00:00.000Z');

    assert.equal(appended.collection.updatedAt, first.updatedAt);
    assert.equal(revoked.collection.updatedAt, first.updatedAt);
    assert.deepEqual(revoked.collection.conversations, [second]);
  });

  it('fails closed at the bound instead of evicting an existing authorization', async () => {
    const root = await testRoot();
    const path = join(root, 'conversation-binding.json');
    const conversations = Array.from({ length: PERSONAL_CHROME_AUTHORIZATION_LIMIT }, (_, index) =>
      authorization(`conversation-${index}`, `2026-08-21T07:${String(index).padStart(2, '0')}:00.000Z`),
    );
    await writePersonalChromeConversationAuthorizationsAtomic(
      path,
      collection(conversations, conversations.at(-1).updatedAt),
    );

    await assert.rejects(
      authorizePersonalChromeConversation(path, authorization('conversation-overflow', '2026-08-21T08:00:00.000Z')),
      (error) => error?.code === 'AUTHORIZATION_LIMIT_REACHED',
    );
    assert.deepEqual((await readPersonalChromeConversationAuthorizations(path)).conversations, conversations);
  });

  it('revokes one exact conversation without disturbing the remaining authorization', async () => {
    const root = await testRoot();
    const path = join(root, 'conversation-binding.json');
    const first = authorization('conversation-7', '2026-08-21T07:00:00.000Z');
    const second = authorization('conversation-8', '2026-08-21T07:01:00.000Z');
    await writePersonalChromeConversationAuthorizationsAtomic(path, collection([first, second], second.updatedAt));

    const result = await revokePersonalChromeConversation(path, 'conversation-7', '2026-08-21T07:02:00.000Z');

    assert.equal(result.revoked, true);
    assert.deepEqual(result.collection, collection([second], '2026-08-21T07:02:00.000Z'));
    const retry = await revokePersonalChromeConversation(path, 'conversation-7', '2026-08-21T07:03:00.000Z');
    assert.equal(retry.revoked, false);
    assert.deepEqual(retry.collection, result.collection);
  });

  it('preserves the last valid collection when atomic replacement fails', async () => {
    const root = await testRoot();
    const path = join(root, 'conversation-binding.json');
    await writePersonalChromeConversationAuthorizationsAtomic(path, collection());

    await assert.rejects(
      writePersonalChromeConversationAuthorizationsAtomic(
        path,
        collection([authorization()], '2026-08-21T07:02:00.000Z'),
        { renameFile: async () => Promise.reject(new Error('injected rename failure')) },
      ),
      /injected rename failure/,
    );

    assert.deepEqual(await readPersonalChromeConversationAuthorizations(path), collection());
    assert.equal((await readFile(path, 'utf8')).includes('07:02'), false);
    assert.deepEqual(await readdir(root), ['conversation-binding.json']);
  });

  it('fails closed for missing, damaged, over-permissive, and oversized persisted state', async () => {
    const root = await testRoot();
    const path = join(root, 'conversation-binding.json');
    await assert.rejects(
      readPersonalChromeConversationAuthorizations(path),
      (error) => error?.code === 'NEEDS_AUTHORIZATION',
    );

    await writeFile(path, '{not json}\n', { mode: 0o600 });
    await assert.rejects(readPersonalChromeConversationAuthorizations(path), /unreadable/);
    await assert.rejects(authorizePersonalChromeConversation(path, authorization()), /unreadable/);

    await writePersonalChromeConversationAuthorizationsAtomic(path, collection());
    await chmod(path, 0o644);
    await assert.rejects(readPersonalChromeConversationAuthorizations(path), /mode 0600/);

    await chmod(path, 0o600);
    await writeFile(path, ' '.repeat(70 * 1024), { mode: 0o600 });
    await assert.rejects(readPersonalChromeConversationAuthorizations(path), /size limit/);
  });

  it('explicit uninstall removal returns the Host to typed needs-authorization', async () => {
    const root = await testRoot();
    const path = join(root, 'conversation-binding.json');
    await writePersonalChromeConversationAuthorizationsAtomic(path, collection());
    await removePersonalChromeConversationAuthorizations(path);
    await removePersonalChromeConversationAuthorizations(path);

    await assert.rejects(
      readPersonalChromeConversationAuthorizations(path),
      (error) => error?.code === 'NEEDS_AUTHORIZATION',
    );
  });
});
