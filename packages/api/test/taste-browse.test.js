import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import Fastify from 'fastify';
import { tasteBrowseRoutes } from '../dist/routes/taste-browse.js';

let app;
let root;
let proposals;
let threads;
let messages;
let failStats;
let latestThread;
const publicPath = 'docs/taste/vignettes/approved.md';
const privatePath = 'private/taste/private.md';
const vignette = (privacy = 'public', quote = '先把真实东西摆出来') =>
  `---\nwhen: 2026-09-25\nquotes: ["${quote}"]\nscene: "设计讨论"\ntags: ["真实", "设计"]\ntakeaway: "先看真实界面，再判断设计"\ndimension: visual-quality\nprivacy: ${privacy}\ncatId: codex61-sol\nproposalId: proposal-owner\n---\n`;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'f321-taste-browse-'));
  mkdirSync(join(root, 'docs/taste/vignettes'), { recursive: true });
  mkdirSync(join(root, 'private/taste'), { recursive: true });
  writeFileSync(join(root, publicPath), vignette());
  writeFileSync(join(root, privatePath), vignette('sensitive', '私有原话'));
  writeFileSync(join(root, 'docs/taste/vignettes/pending.md'), vignette().replace('when:', 'status: pending\nwhen:'));
  proposals = new Map([
    [
      'proposal-owner',
      {
        id: 'proposal-owner',
        userId: 'owner',
        status: 'approved',
        vignettePath: publicPath,
        threadId: 'thread-owner',
        sourceMessageId: 'message-owner',
        createdAt: 100,
        approvedAt: 200,
        quote: '先把真实东西摆出来',
      },
    ],
  ]);
  threads = new Map([['thread-owner', { id: 'thread-owner', createdBy: 'owner', title: '设计讨论' }]]);
  messages = new Map([
    [
      'message-owner',
      {
        id: 'message-owner',
        threadId: 'thread-owner',
        userId: 'owner',
        content: '先把真实东西摆出来',
        deliveryStatus: 'delivered',
        catId: null,
        timestamp: 100,
      },
    ],
  ]);
  failStats = false;
  latestThread = null;
  app = Fastify();
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = request.headers['x-test-session'];
  });
  await app.register(tasteBrowseRoutes, {
    ownerUserId: 'owner',
    tasteRepository: { canonicalRoot: () => root, approvalLockKey: () => 'unused' },
    readObservatory: async () => {
      if (failStats) throw new Error('temporary read failure');
      return {
        entries: [
          {
            sourcePath: publicPath,
            visibility: 'public',
            namedDelivery: null,
            search: {
              hits: 2,
              opened: 1,
              unverified: 0,
              latest: latestThread ? { threadId: latestThread, recalledAt: 300, opened: true } : null,
            },
          },
        ],
        coverage: { totalUnverified: 0 },
      };
    },
    proposalStore: { get: async (id) => proposals.get(id) ?? null },
    threadStore: { get: async (id) => threads.get(id) ?? null, list: async () => [...threads.values()] },
    messageStore: { getById: async (id) => messages.get(id) ?? null },
  });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});
const get = (url, extra = {}) => app.inject({ url, headers: { 'x-test-session': 'owner' }, ...extra });
const first = async () => (await get('/api/memory/taste')).json().entries[0];

test('an approved memory without quotes or takeaway does not present its scene as an original quote', async () => {
  writeFileSync(
    join(root, publicPath),
    vignette()
      .replace('quotes: ["先把真实东西摆出来"]', 'quotes: []')
      .replace('takeaway: "先看真实界面，再判断设计"\n', ''),
  );
  const entry = (await get('/api/memory/taste')).json().entries.find((item) => item.visibility === 'public');
  assert.equal(entry.title, '品味 · 原话没有记录下来');
  assert.equal(entry.scene, '设计讨论');
});
test('latest retrieval exposes a readable owner conversation but not a foreign or deleted conversation title', async () => {
  latestThread = 'thread-owner';
  assert.equal((await first()).recall.search.latest.title, '设计讨论');
  assert.equal((await first()).recall.search.latest.threadId, 'thread-owner');
  threads.set('thread-owner', { id: 'thread-owner', createdBy: 'other', title: 'private foreign title' });
  assert.deepEqual((await first()).recall.search.latest, { at: 300, outcome: 'read', title: null });
  threads.set('thread-owner', { id: 'thread-owner', createdBy: 'owner', title: 'deleted title', deletedAt: 1 });
  assert.equal((await first()).recall.search.latest.title, null);
});
test('detail gives bounded approval dates and trigger conditions from the actual producer catalogs', async () => {
  const item = await first();
  const detail = (await get(`/api/memory/taste/${item.id}?revision=${encodeURIComponent(item.revision)}`)).json();
  assert.deepEqual(detail.approval, { status: 'approved', proposedAt: 100, approvedAt: 200 });
  assert.equal(detail.whenRemembered, '只在维度提示或猫主动检索时出现');
  writeFileSync(join(root, 'docs/taste/vignettes/visual-quality-ELI5-pcpjsd.md'), vignette());
  const eli5 = (await get('/api/memory/taste'))
    .json()
    .entries.find((e) => e.id !== item.id && e.visibility === 'public');
  assert.equal(eli5.whenRemembered, '提到 ELI5 时点名递送这条品味');
});
test('list and detail share owner/path-bound proposal instants instead of treating a truncated UTC day as local', async () => {
  const item = await first();
  assert.deepEqual(item.approval, { status: 'approved', proposedAt: 100, approvedAt: 200 });
  proposals.get('proposal-owner').userId = 'other';
  assert.deepEqual((await first()).approval, { status: 'unavailable' });
  proposals.get('proposal-owner').userId = 'owner';
  proposals.get('proposal-owner').vignettePath = 'private/taste/elsewhere.md';
  assert.deepEqual((await first()).approval, { status: 'unavailable' });
});

test('browse gives actual payload and separate channel truth without path/proposal refs', async () => {
  const response = await get('/api/memory/taste');
  assert.equal(response.statusCode, 200);
  const data = response.json();
  const entry = data.entries.find((item) => item.visibility === 'public');
  assert.equal(entry.title, '先看真实界面，再判断设计');
  assert.deepEqual(entry.quotes, ['先把真实东西摆出来']);
  assert.equal(entry.recall.namedDelivery, null);
  assert.equal(entry.recall.search.hits, 2);
  assert.equal(entry.recall.dimensionHint, undefined);
  assert.match(entry.revision, /^sha256:/);
  assert.equal(response.body.includes(publicPath), false);
  assert.equal(response.body.includes('proposal-owner'), false);
});
test('normal session is mandatory; foreign session and identity headers cannot browse', async () => {
  assert.equal((await app.inject({ url: '/api/memory/taste' })).statusCode, 401);
  assert.equal(
    (await app.inject({ url: '/api/memory/taste', headers: { 'x-cat-cafe-user': 'owner' } })).statusCode,
    401,
  );
  assert.equal((await get('/api/memory/taste', { headers: { 'x-test-session': 'other' } })).statusCode, 403);
});
test('remote owner sees only public; private id stays unavailable for detail and source', async () => {
  const local = (await get('/api/memory/taste')).json().entries;
  const privateEntry = local.find((item) => item.visibility === 'private');
  assert.ok(privateEntry);
  const remote = await get('/api/memory/taste', { remoteAddress: '10.0.0.2' });
  assert.equal(remote.statusCode, 200);
  assert.equal(remote.body.includes('私有原话'), false);
  assert.equal(remote.json().entries.length, 1);
  for (const suffix of ['', '/source'])
    assert.equal(
      (
        await get(
          `/api/memory/taste/${privateEntry.id}${suffix}?revision=${encodeURIComponent(privateEntry.revision)}`,
          { remoteAddress: '10.0.0.2' },
        )
      ).statusCode,
      404,
    );
});
test('invalid files/symlinks never become listed memories; missing directory is unavailable', async () => {
  writeFileSync(join(root, 'outside.md'), vignette());
  symlinkSync(join(root, 'outside.md'), join(root, 'docs/taste/vignettes/link.md'));
  writeFileSync(join(root, 'docs/taste/vignettes/bad.md'), 'not a vignette');
  const data = (await get('/api/memory/taste')).json();
  assert.equal(data.entries.length, 2);
  rmSync(join(root, 'docs/taste/vignettes'), { recursive: true });
  assert.equal((await get('/api/memory/taste')).statusCode, 503);
});
test('statistics failure preserves real memories and reports partial, never zero', async () => {
  failStats = true;
  const data = (await get('/api/memory/taste')).json();
  assert.equal(data.readStatus, 'partial');
  assert.equal(data.entries.length, 2);
  assert.equal(data.entries[0].recall, null);
});
test('detail is bound to actual revision; stale version cannot resolve source', async () => {
  const item = await first();
  const detail = await get(`/api/memory/taste/${item.id}?revision=${encodeURIComponent(item.revision)}`);
  assert.equal(detail.statusCode, 200);
  writeFileSync(join(root, publicPath), vignette('public', '新版原话'));
  for (const suffix of ['', '/source'])
    assert.equal(
      (await get(`/api/memory/taste/${item.id}${suffix}?revision=${encodeURIComponent(item.revision)}`)).statusCode,
      409,
    );
});
test('source returns verified exact message only, not raw proposal/path or body', async () => {
  const item = await first();
  const response = await get(`/api/memory/taste/${item.id}/source?revision=${encodeURIComponent(item.revision)}`);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    status: 'ready',
    title: '设计讨论',
    canOpen: true,
    threadId: 'thread-owner',
    messageId: 'message-owner',
  });
  assert.equal(response.body.includes(publicPath), false);
  assert.equal(response.body.includes('先把真实'), false);
});
test('source guards proposal owner/status/path, thread/message owner and deletion/publication', async () => {
  const item = await first();
  const url = `/api/memory/taste/${item.id}/source?revision=${encodeURIComponent(item.revision)}`;
  const p = proposals.get('proposal-owner');
  for (const changed of [{ userId: 'other' }, { status: 'pending' }, { vignettePath: 'wrong.md' }]) {
    proposals.set(p.id, { ...p, ...changed });
    assert.equal((await get(url)).json().canOpen, false);
  }
  proposals.set(p.id, p);
  const t = threads.get('thread-owner');
  for (const changed of [{ createdBy: 'other' }, { deletedAt: 1 }]) {
    threads.set(t.id, { ...t, ...changed });
    assert.equal((await get(url)).json().canOpen, false);
  }
  threads.set(t.id, t);
  const m = messages.get('message-owner');
  for (const changed of [{ userId: 'other' }, { threadId: 'other' }, { deletedAt: 1 }, { deliveryStatus: 'queued' }]) {
    messages.set(m.id, { ...m, ...changed });
    assert.equal((await get(url)).json().canOpen, false);
  }
});
test('missing source coordinate and a failed source read are different states', async () => {
  const item = await first();
  const url = `/api/memory/taste/${item.id}/source?revision=${encodeURIComponent(item.revision)}`;
  proposals.set('proposal-owner', { ...proposals.get('proposal-owner'), sourceMessageId: undefined });
  assert.equal((await get(url)).json().status, 'not_recorded');
  proposals.get('proposal-owner').sourceMessageId = 'message-owner';
  messages.delete('message-owner');
  assert.equal((await get(url)).json().status, 'unavailable');
});
