import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { WorkspaceContentReviewService } from '../src/domains/collaborative-content/workspace-review/service.js';
import { WorkspaceContentReviewStore } from '../src/domains/collaborative-content/workspace-review/store.js';
import { WorkspaceContentSourceService } from '../src/domains/workspace/workspace-content-source.js';
import { registerWorkspaceContentReviewRoutes } from '../src/routes/workspace-content-review-routes.js';

test('file quotes are a read-only projection of authorized original messages, with honest version and location', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f309-file-quotes-'));
  const text = '# Guide\nFirst unique paragraph.\nSecond unique paragraph.\n';
  await writeFile(join(root, 'guide.md'), text);
  const source = new WorkspaceContentSourceService({
    ownerUserId: 'operator',
    resolveWorktreeRoot: async () => ({ root, canonicalWorktreeId: 'work' }),
  });
  const store = new WorkspaceContentReviewStore(join(root, 'files.sqlite'));
  const reviews = new WorkspaceContentReviewService({ source, store });
  const messages = new MessageStore(),
    threads = new ThreadStore();
  const own = threads.create('operator', '原对话', root);
  const foreign = threads.create('other', '不可见对话', root);
  const description = await source.describe({
    principal: { userId: 'operator', actor: { kind: 'human', actorId: 'operator' } },
    locator: { worktreeId: 'work', path: 'guide.md' },
  });
  const revision = description.revision;
  const append = (id: string, version: string | undefined, threadId = own.id, userId = 'operator') =>
    messages.append({
      userId,
      threadId,
      catId: createCatId('codex-astra'),
      content: '猫自己的正文不进入文件投影',
      mentions: [],
      timestamp: Date.now(),
      contentBlocks: [
        {
          type: 'context_attachment',
          attachment: {
            v: 1,
            id,
            kind: 'quote',
            text: 'First unique paragraph.',
            source: {
              kind: 'workspace_file',
              path: 'guide.md',
              worktreeId: 'work',
              ...(version ? { revision: version } : {}),
            },
          },
        },
      ],
    });
  const current = append('current', revision);
  append('legacy', undefined);
  append('changed', `sha256:${'b'.repeat(64)}`);
  append('foreign-owner', revision, foreign.id, 'other');
  append('foreign-thread', revision, foreign.id);
  append('missing-default-thread', revision, 'default');
  const recalled = append('recalled', revision);
  recalled.recall = { version: 1, exposure: 'none', recalledAt: Date.now() };
  const deleted = append('deleted', revision);
  messages.softDelete(deleted.id, 'operator');
  const before = JSON.stringify(messages.getRecent(100, 'operator'));
  const threadsBefore = JSON.stringify(threads.list('operator'));
  const app = Fastify();
  app.decorateRequest('sessionUserId', null);
  app.addHook('onRequest', async (request) => {
    request.sessionUserId =
      request.headers['x-test-user'] === 'anonymous' ? null : (request.headers['x-test-user'] as string) || 'operator';
  });
  // The pre-existing registrar ignores this dependency until the new read route is implemented: the RED is a route 404.
  const deps = { reviews, fileQuotes: { source, messages, threads } };
  registerWorkspaceContentReviewRoutes(app, deps);
  t.after(async () => {
    await app.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const url = `/api/workspace/file-quotes?worktreeId=work&path=guide.md&expectedSourceRevision=${revision}`;
  const response = await app.inject({ method: 'GET', url });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  const page = response.json();
  assert.deepEqual(
    page.quotes.map((item: { attachment: { id: string } }) => item.attachment.id),
    ['current', 'legacy', 'changed'],
  );
  assert.deepEqual(
    page.quotes.map((item: { state: string }) => item.state),
    ['current', 'unversioned', 'changed'],
  );
  assert.equal(page.quotes[0].messageId, current.id);
  assert.equal(page.quotes[0].authorCatId, 'codex-astra');
  assert.equal(page.quotes[0].anchor.quote, 'First unique paragraph.');
  assert.equal(page.quotes[1].anchor, undefined);
  assert.equal(page.quotes[2].anchor, undefined);
  assert.ok(!response.body.includes('猫自己的正文'));
  assert.equal(JSON.stringify(messages.getRecent(100, 'operator')), before);
  assert.equal(
    JSON.stringify(threads.list('operator')),
    threadsBefore,
    'reading never materializes a missing default thread',
  );
  assert.equal(await readFile(join(root, 'guide.md'), 'utf8'), text);
  const cat = await app.inject({
    method: 'GET',
    url,
    headers: { 'x-invocation-id': 'cat', 'x-callback-token': 'token' },
  });
  assert.equal(cat.statusCode, 401);
  const outsider = await app.inject({ method: 'GET', url, headers: { 'x-test-user': 'other' } });
  assert.equal(outsider.statusCode, 403);
  await writeFile(join(root, 'guide.md'), text + 'Changed.\n');
  const stale = await app.inject({ method: 'GET', url });
  assert.equal(stale.statusCode, 409);
  await writeFile(join(root, 'guide.md'), text);

  await t.test('anonymous and invalid cursors do not expose message references', async () => {
    assert.equal((await app.inject({ method: 'GET', url, headers: { 'x-test-user': 'anonymous' } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: `${url}&before=99999999999999999:id` })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: `${url}&limit=101` })).statusCode, 400);
  });
  await t.test('bounded pages retain a cursor even when their visible result is empty', async () => {
    const ids: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const reply = await app.inject({
        method: 'GET',
        url: `${url}&limit=2${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`,
      });
      assert.equal(reply.statusCode, 200, reply.body);
      const value = reply.json();
      if (pages === 0) {
        assert.equal(value.quotes.length, 0);
        assert.ok(value.nextCursor, 'empty filtered page does not claim that older quotes are absent');
      }
      ids.push(...value.quotes.map((item: { attachment: { id: string } }) => item.attachment.id));
      assert.notEqual(value.nextCursor, cursor, 'pagination advances across equal timestamps');
      cursor = value.nextCursor;
      pages += 1;
      assert.ok(pages <= 4, 'read remains bounded by the fixture message count');
    } while (cursor);
    assert.deepEqual(ids.sort(), ['changed', 'current', 'legacy']);
  });
  await t.test('a message recalled while the batch is resolving is absent from the final response', async () => {
    const first = append('recall-during-page', revision);
    append('later-location', revision);
    const resolve = source.resolveRenderedTextSelections.bind(source);
    source.resolveRenderedTextSelections = async (input) => {
      const result = await resolve(input);
      first.recall = { version: 1, exposure: 'none', recalledAt: Date.now() };
      return result;
    };
    try {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 200, response.body);
      assert.ok(!response.json().quotes.some((item: { messageId: string }) => item.messageId === first.id));
    } finally {
      source.resolveRenderedTextSelections = resolve;
    }
  });
  await t.test('permission withdrawn during location removes the whole thread at publication', async () => {
    const resolve = source.resolveRenderedTextSelections.bind(source);
    source.resolveRenderedTextSelections = async (input) => {
      const result = await resolve(input);
      own.deletedAt = Date.now();
      return result;
    };
    try {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json().quotes, []);
    } finally {
      delete own.deletedAt;
      source.resolveRenderedTextSelections = resolve;
    }
  });
  await t.test('a file changed during the read never returns anchors for its prior bytes', async () => {
    const resolve = source.resolveRenderedTextSelections.bind(source);
    source.resolveRenderedTextSelections = async (input) => {
      const result = await resolve(input);
      await writeFile(join(root, 'guide.md'), `${text}Changed independently.\n`);
      return result;
    };
    try {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(response.json().quotes, undefined);
    } finally {
      await writeFile(join(root, 'guide.md'), text);
      source.resolveRenderedTextSelections = resolve;
    }
  });
  await t.test('projects published queued cat references without publishing queued human or Host work', async () => {
    const queued = append('queued-cat', revision);
    queued.deliveryStatus = 'queued';
    const privateHuman = append('queued-human', revision);
    privateHuman.catId = null;
    privateHuman.deliveryStatus = 'queued';
    const privateHost = append('queued-host', revision);
    privateHost.catId = createCatId('system');
    privateHost.deliveryStatus = 'queued';
    const canceled = append('canceled-cat', revision);
    canceled.deliveryStatus = 'queued';
    messages.markCanceled(canceled.id);
    const recordBefore = JSON.stringify(queued);
    assert.ok(
      messages
        .getByThread(own.id, 100, 'operator', { includeQueuedCatMessages: true })
        .some((message) => message.id === queued.id),
    );
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 200, response.body);
    const projected = response.json().quotes.map((quote: { messageId: string }) => quote.messageId);
    assert.ok(projected.includes(queued.id));
    assert.ok([privateHuman.id, privateHost.id, canceled.id].every((id) => !projected.includes(id)));
    assert.equal(JSON.stringify(queued), recordBefore, 'projection never settles queued execution custody');
  });
});

test('one large-page projection resolves 1200 quotes from one authorized text snapshot', async (t) => {
  const { WorkspaceFileQuoteProjection } = await import(
    '../src/domains/collaborative-content/workspace-review/file-quote-projection.js'
  );
  const root = await mkdtemp(join(tmpdir(), 'f309-quote-batch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const text = 'padding '.repeat(131072) + '\n\nOnly one **rendered passage**.\n';
  await writeFile(join(root, 'large.md'), text);
  const source = new WorkspaceContentSourceService({
    ownerUserId: 'operator',
    resolveWorktreeRoot: async () => ({ root, canonicalWorktreeId: 'work' }),
  });
  const principal = { userId: 'operator', actor: { kind: 'human' as const, actorId: 'operator' } };
  const locator = { worktreeId: 'work', path: 'large.md' };
  const description = await source.describe({ principal, locator });
  const messages = new MessageStore(),
    threads = new ThreadStore();
  const thread = threads.create('operator', '引用', root);
  for (let message = 0; message < 100; message++)
    messages.append({
      userId: 'operator',
      threadId: thread.id,
      catId: createCatId('codex61-sol'),
      content: 'quoted',
      mentions: [],
      timestamp: message,
      contentBlocks: Array.from({ length: 12 }, (_, quote) => ({
        type: 'context_attachment' as const,
        attachment: {
          v: 1 as const,
          id: 'quote-' + quote,
          kind: 'quote' as const,
          text: 'Only one rendered passage.',
          source: { kind: 'workspace_file' as const, ...locator, revision: description.revision },
        },
      })),
    });
  const read = source.readText.bind(source);
  let reads = 0;
  source.readText = async (input) => {
    reads++;
    assert.equal(reads, 1, 'a second quote must not reread the whole large file');
    return read(input);
  };
  const view = await new WorkspaceFileQuoteProjection({ source, messages, threads }).read(
    {
      locator,
      expectedSourceRevision: description.revision,
      limit: 100,
    },
    principal,
  );
  assert.equal(view.quotes.length, 1200);
  assert.ok(
    view.quotes.every((quote) => quote.state === 'current' && quote.anchor?.quote === 'Only one **rendered passage**.'),
  );
  assert.equal(reads, 1, 'large-page quote count does not multiply authorized file reads');
});
