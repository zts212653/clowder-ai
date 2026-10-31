import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import Fastify from 'fastify';
import type { CollectionManifest, EvidenceItem, IEvidenceStore } from '../src/domains/memory/interfaces.js';
import { SqliteEvidenceStore } from '../src/domains/memory/SqliteEvidenceStore.js';
import { memoryPageReadRoutes } from '../src/routes/memory-page-read.js';

let f: Awaited<ReturnType<typeof fixture>>;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'f321-search-'));
  await mkdir(join(root, 'docs/taste/vignettes'), { recursive: true });
  await mkdir(join(root, 'private/taste'), { recursive: true });
  const vignette = (privacy = 'public', quote = '搜索应该显示真实结果') =>
    `---\nwhen: 2026-09-25\nquotes: ["${quote}"]\nscene: "搜索设计"\ntags: ["搜索"]\ntakeaway: "先看真实界面"\nprivacy: ${privacy}\n---\n`;
  await writeFile(join(root, 'docs/taste/vignettes/approved.md'), vignette());
  await writeFile(join(root, 'private/taste/private.md'), vignette('sensitive', '搜索私有记忆'));
  await writeFile(join(root, 'docs/taste/vignettes/pending.md'), vignette().replace('when:', 'status: pending\nwhen:'));
  await writeFile(join(root, 'design.md'), '# 搜索设计\n\n真实文档原文。');
  const evidence = new SqliteEvidenceStore(':memory:');
  await evidence.initialize();
  const item: EvidenceItem = {
    anchor: 'D1',
    kind: 'architecture',
    title: '搜索设计规范',
    summary: '文档摘要',
    sourcePath: 'design.md',
    status: 'active',
    authority: 'observed',
    updatedAt: '2026-09-25',
  };
  const items = new Map([[item.anchor, item]]);
  let documentFailure = false;
  let messageFailure = false;
  const calls: Array<{ owner: string; depth?: string; scope?: string }> = [];
  const manifest: CollectionManifest = {
    id: 'project:visible',
    kind: 'project',
    name: 'visible',
    displayName: '项目资料',
    root,
    sensitivity: 'public',
    scannerLevel: 0,
    status: 'active',
    indexPolicy: { autoRebuild: false },
    reviewPolicy: { authorityCeiling: 'observed', requireOwnerApproval: false },
    createdAt: '2026-09-25',
    updatedAt: '2026-09-25',
  };
  const manifests = [
    manifest,
    { ...manifest, id: 'domain:foreign', sensitivity: 'private' as const, ownerUserId: 'another' },
  ];
  const store: Pick<IEvidenceStore, 'search' | 'getByAnchor'> = {
    search: async (_q, opts) => {
      calls.push({ owner: 'docs', depth: opts?.depth, scope: opts?.scope });
      if (documentFailure) throw new Error('unavailable');
      return [...items.values()];
    },
    getByAnchor: async (anchor) => items.get(anchor) ?? null,
  };
  const searchSources = {
    tasteRepository: { canonicalRoot: () => root, approvalLockKey: () => 'unused' },
    messageSearchService: {
      search: async (_input: unknown, principal: { userId: string }) => {
        calls.push({ owner: principal.userId });
        if (messageFailure) throw new Error('unavailable');
        return {
          results: [
            {
              threadId: 'own',
              messageId: 'message',
              threadTitle: '搜索讨论',
              snippet: { text: '搜索原话' },
              contentRevision: 'revision',
              timestamp: 1,
            },
          ],
          meta: { partial: true, hasMore: false, degraded: false },
        };
      },
    },
  };
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = request.headers['x-test-session'] as string | undefined;
  });
  const opts = {
    ownerUserId: 'owner',
    catalog: { list: () => manifests },
    stores: new Map([['project:visible', store as IEvidenceStore]]),
    evidenceDb: evidence.getDb(),
    markerQueue: { list: async () => [] },
    searchSources,
  };
  await app.register(memoryPageReadRoutes, opts);
  await app.ready();
  return {
    app,
    root,
    items,
    calls,
    manifests,
    get: (query = '?q=搜索') =>
      app.inject({
        url: `/api/memory/search${query}`,
        headers: { 'x-test-session': 'owner' },
      }),
    failDocs: () => {
      documentFailure = true;
    },
    failMessages: () => {
      messageFailure = true;
    },
    close: async () => {
      await app.close();
      await evidence.close();
      await rm(root, { recursive: true });
    },
  };
}
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.close();
});

test('requires session owner before any search, and rejects malformed or authority-granting query filters', async () => {
  for (const [headers, status] of [
    [{}, 401],
    [{ 'x-cat-cafe-user': 'owner' }, 401],
    [{ 'x-test-session': 'foreign' }, 403],
  ] as const) {
    assert.equal((await f.app.inject({ url: '/api/memory/search?q=搜索', headers })).statusCode, status);
  }
  for (const query of [
    '?q=',
    '?q=搜索&type=private',
    '?q=搜索&collections=domain:foreign',
    '?q=搜索&depth=other',
    '?q=搜索&limit=999',
  ])
    assert.equal((await f.get(query)).statusCode, 400);
  assert.equal(f.calls.length, 0);
});

test('unifies approved memory, typed documents and canonical message results with separate coverage', async () => {
  const response = await f.get();
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.deepEqual(
    body.groups.map((g: { type: string }) => g.type),
    ['memory', 'documents', 'conversations'],
  );
  assert.equal(body.groups[0].results.length, 2);
  assert.equal(body.groups[0].results[0].displayType, '品味');
  assert.equal(body.groups[1].results[0].displayType, '设计规范');
  assert.equal(body.groups[1].results[0].authority, 'observed');
  assert.equal(body.groups[1].results[0].destination.kind, 'document');
  assert.equal(body.groups[2].status, 'partial');
  assert.equal(body.groups[2].results[0].destination.messageId, 'message');
  assert.ok(f.calls.some((c) => c.owner === 'owner'));
  assert.ok(!JSON.stringify(body).includes('domain:foreign'));
  assert.ok(!JSON.stringify(body).includes('pending.md'));
});

test('remote owner sessions read public sources without private taste or foreign collection metadata', async () => {
  const response = await f.app.inject({
    url: '/api/memory/search?q=搜索',
    remoteAddress: '192.0.2.2',
    headers: { 'x-test-session': 'owner' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().groups[0].results.length, 1);
  assert.ok(!response.body.includes('私有记忆'));
});

test('remote document readers reject resolved Taste namespaces and preserve ordinary public documents', async () => {
  const base = f.items.get('D1');
  assert.ok(base);
  await symlink(join(f.root, 'private/taste'), join(f.root, 'taste-directory-alias'));
  await symlink(join(f.root, 'private/taste/private.md'), join(f.root, 'taste-file-alias.md'));
  await symlink(join(f.root, 'docs/taste/vignettes'), join(f.root, 'public-taste-alias'));
  const sources = ['taste-directory-alias/private.md', 'taste-file-alias.md', 'public-taste-alias/approved.md'];
  const caseVariant = 'Private/taste/private.md';
  const caseInsensitive = await stat(join(f.root, caseVariant)).then(
    () => true,
    () => false,
  );
  if (caseInsensitive) sources.push(caseVariant);
  for (const [index, sourcePath] of sources.entries()) {
    const anchor = `taste-alias-${index}`;
    f.items.set(anchor, {
      ...base,
      anchor,
      sourcePath,
      title: '品味索引不可走文档',
      summary: '品味索引摘要不可走文档',
    });
    for (const depth of ['summary', 'raw']) {
      const response = await f.app.inject({
        url: `/api/memory/search?q=搜索&type=documents&depth=${depth}`,
        remoteAddress: '192.0.2.2',
        headers: { 'x-test-session': 'owner' },
      });
      assert.equal(response.statusCode, 200);
      assert.doesNotMatch(response.body, /品味索引|搜索私有记忆/, sourcePath);
      const rows = response.json().groups[0].results;
      assert.equal(rows.length, 1, 'only the ordinary public document remains');
      assert.equal(rows[0].destination.anchor, 'D1');
    }
    const detail = await f.app.inject({
      url: `/api/memory/search/document?collection=project:visible&anchor=${anchor}`,
      remoteAddress: '192.0.2.2',
      headers: { 'x-test-session': 'owner' },
    });
    assert.equal(detail.statusCode, 404, sourcePath);
    assert.doesNotMatch(detail.body, /品味索引|搜索私有记忆/);
  }
  const publicDetail = await f.app.inject({
    url: '/api/memory/search/document?collection=project:visible&anchor=D1',
    remoteAddress: '192.0.2.2',
    headers: { 'x-test-session': 'owner' },
  });
  assert.equal(publicDetail.statusCode, 200);
  assert.match(publicDetail.json().content, /真实文档原文/);
  console.log(JSON.stringify({ resolvedTasteGuard: { sources: sources.length, caseInsensitive } }));
});

test('one unavailable source preserves the other sources and cannot claim a verified empty search', async () => {
  f.failDocs();
  const body = (await f.get()).json();
  assert.equal(body.readStatus, 'partial');
  assert.equal(body.groups[1].status, 'unavailable');
  assert.equal(body.groups[0].results.length, 2);
  assert.equal(body.groups[2].results.length, 1);
  assert.equal((await f.get('?q=搜索&type=documents')).json().readStatus, 'unavailable');
});

test('summary/raw applies only to eligible document retrieval; thread/session and pending taste indexes cannot bypass their readers', async () => {
  const base = f.items.get('D1');
  assert.ok(base);
  for (const [anchor, kind, sourcePath] of [
    ['thread-secret', 'thread', 'threads/foreign'],
    ['session-secret', 'session', 'sessions/private'],
    ['pending', 'lesson', 'docs/taste/vignettes/pending.md'],
  ] as const)
    f.items.set(anchor, { ...base, anchor, kind, sourcePath, title: '不能从索引越过读取闸门' });
  const body = (await f.get('?q=搜索&type=documents&depth=raw')).json();
  assert.equal(body.groups[0].results.length, 1);
  assert.ok(f.calls.some((c) => c.depth === 'raw'));
  assert.ok(!JSON.stringify(body).includes('不能从索引'));
});

test('document destinations reject missing and escaping files and are revalidated when opened', async () => {
  const base = f.items.get('D1');
  assert.ok(base);
  f.items.set('escape', { ...base, anchor: 'escape', sourcePath: '../secret.md' });
  f.items.set('missing', { ...base, anchor: 'missing', sourcePath: 'missing.md' });
  await symlink('/etc/hosts', join(f.root, 'escape.md'));
  f.items.set('symlink', { ...base, anchor: 'symlink', sourcePath: 'escape.md' });
  const rows = (await f.get('?q=搜索&type=documents')).json().groups[0].results;
  assert.equal(
    rows.find((r: { id: string }) => r.id.endsWith('escape')),
    undefined,
  );
  assert.equal(
    rows.find((r: { id: string }) => r.id.endsWith('symlink')),
    undefined,
  );
  assert.equal(rows.find((r: { id: string }) => r.id.endsWith('missing')).destination, null);
  const path = '/api/memory/search/document?collection=project%3Avisible&anchor=D1';
  const opened = await f.app.inject({ url: path, headers: { 'x-test-session': 'owner' } });
  assert.equal(opened.statusCode, 200);
  assert.match(opened.json().content, /真实文档原文/);
  f.items.delete('D1');
  assert.equal((await f.app.inject({ url: path, headers: { 'x-test-session': 'owner' } })).statusCode, 404);
  assert.equal((await f.app.inject({ url: path })).statusCode, 401);
});

test('parent indexes cannot disclose titles or bodies from an excluded or nested private library', async () => {
  const base = f.items.get('D1');
  assert.ok(base);
  await mkdir(join(f.root, 'private-library'));
  await writeFile(join(f.root, 'private-library/secret.md'), '搜索：不属于当前主人的正文');
  await writeFile(join(f.root, 'excluded.md'), '搜索：已排除的正文');
  const parent = f.manifests[0];
  const foreign = f.manifests[1];
  assert.ok(parent && foreign);
  parent.exclude = ['excluded.md'];
  f.manifests.push({ ...foreign, id: 'domain:nested', root: join(f.root, 'private-library') });
  f.items.set('nested-secret', {
    ...base,
    anchor: 'nested-secret',
    title: '私有标题不可泄漏',
    sourcePath: 'private-library/secret.md',
  });
  f.items.set('excluded-secret', {
    ...base,
    anchor: 'excluded-secret',
    title: '排除标题不可泄漏',
    sourcePath: 'excluded.md',
  });
  const response = await f.get('?q=搜索&type=documents&depth=raw');
  assert.equal(response.statusCode, 200);
  assert.ok(!response.body.includes('不可泄漏'));
  assert.ok(!response.body.includes('已排除的正文'));
  for (const anchor of ['nested-secret', 'excluded-secret']) {
    const source = await f.app.inject({
      url: `/api/memory/search/document?collection=project:visible&anchor=${anchor}`,
      headers: { 'x-test-session': 'owner' },
    });
    assert.equal(source.statusCode, 404);
  }
  await rm(join(f.root, 'private-library'), { recursive: true });
  await rm(join(f.root, 'excluded.md'));
  const stale = await f.get('?q=搜索&type=documents&depth=raw');
  assert.ok(!stale.body.includes('不可泄漏'), 'stale index titles must still obey declared catalog boundaries');
});
