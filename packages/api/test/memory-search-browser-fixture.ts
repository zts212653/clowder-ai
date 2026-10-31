/** Real production routes, SQLite index and canonical message reads; no listeners or Redis. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { IndexBuilder } from '../src/domains/memory/IndexBuilder.js';
import { LibraryCatalog } from '../src/domains/memory/LibraryCatalog.js';
import { MessageSearchService } from '../src/domains/memory/MessageSearchService.js';
import { replaceDocumentPassages } from '../src/domains/memory/replace-document-passages.js';
import { SqliteEvidenceStore } from '../src/domains/memory/SqliteEvidenceStore.js';
import { InMemoryTasteProposalStore } from '../src/domains/taste/stores/InMemoryTasteProposalStore.js';
import { evidenceRoutes } from '../src/routes/evidence.js';
import { libraryRoutes } from '../src/routes/library.js';
import { memoryPageReadRoutes } from '../src/routes/memory-page-read.js';
import { tasteBrowseRoutes } from '../src/routes/taste-browse.js';

const root = await mkdtemp(join(tmpdir(), 'f321-real-search-'));
const evidence = new SqliteEvidenceStore(':memory:');
const app = Fastify();
try {
  await mkdir(join(root, 'docs/taste/vignettes'), { recursive: true });
  await mkdir(join(root, 'private/taste'), { recursive: true });
  await writeFile(
    join(root, 'docs/taste/vignettes/approved.md'),
    '---\nwhen: 2026-09-25\nquotes: ["搜索设计先看真实界面"]\nscene: "搜索设计讨论"\ntags: ["搜索设计"]\ntakeaway: "先看真实界面，再讨论布局"\nprivacy: public\n---\n',
  );
  const content = '# 搜索设计规范\n\n搜索设计先摆出真实结果；读不到与空分开。';
  await writeFile(join(root, 'docs/design.md'), content);
  await writeFile(join(root, 'docs/states.md'), '# 状态约定\n\n状态只来自可核对的证据。');
  await evidence.initialize();
  const items = [
    {
      anchor: 'search-design',
      kind: 'architecture' as const,
      status: 'active' as const,
      title: '搜索设计规范',
      summary: '搜索设计：先显示真实结果，再核对类型与来源。',
      sourcePath: 'design.md',
      authority: 'validated' as const,
      updatedAt: '2026-09-25',
    },
    {
      anchor: 'read-states',
      kind: 'decision' as const,
      status: 'active' as const,
      title: '可读取状态的约定',
      summary: '已核对的数据才可以解释。',
      sourcePath: 'states.md',
      authority: 'observed' as const,
      updatedAt: '2026-09-25',
    },
  ];
  await evidence.upsert(items);
  const primary = items[0];
  if (!primary) throw new Error('Missing primary fixture document');
  replaceDocumentPassages(evidence.getDb(), [{ item: primary, passages: [content] }]);
  await evidence.addEdge({ fromAnchor: 'search-design', toAnchor: 'read-states', relation: 'related' });
  const threadStore = new ThreadStore();
  const messageStore = new MessageStore();
  const own = threadStore.create('owner', '搜索设计的讨论');
  const foreign = threadStore.create('foreign', '其他主人的私有标题');
  const message = messageStore.append({
    userId: 'owner',
    threadId: own.id,
    from: { kind: 'user', userId: 'owner' },
    mentions: [],
    content: '搜索设计要显示原话和出处。',
    timestamp: Date.parse('2026-09-25T12:00:00Z'),
  });
  messageStore.append({
    userId: 'foreign',
    threadId: foreign.id,
    from: { kind: 'user', userId: 'foreign' },
    mentions: [],
    content: '搜索设计不能泄露这段私有原话。',
    timestamp: Date.parse('2026-09-25T13:00:00Z'),
  });
  const builder = new IndexBuilder(
    evidence,
    join(root, 'docs'),
    undefined,
    undefined,
    () => [own, foreign],
    (id, limit) => messageStore.getByThread(id, limit),
  );
  builder.markThreadDirty(own.id);
  builder.markThreadDirty(foreign.id);
  await builder.flushDirtyThreads();
  const messages = new MessageSearchService({ evidenceStore: evidence, threadStore, messageStore });
  const catalog = new LibraryCatalog();
  catalog.register({
    id: 'project:search',
    kind: 'project',
    name: 'search',
    displayName: '项目资料',
    root: join(root, 'docs'),
    sensitivity: 'public',
    scannerLevel: 0,
    status: 'active',
    indexPolicy: { autoRebuild: false },
    reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
    createdAt: '2026-09-25',
    updatedAt: '2026-09-25',
  });
  const stores = new Map([['project:search', evidence]]);
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = request.headers['x-test-session'] as string | undefined;
  });
  await app.register(memoryPageReadRoutes, {
    ownerUserId: 'owner',
    catalog,
    stores,
    evidenceDb: evidence.getDb(),
    markerQueue: { list: async () => [] },
    searchSources: {
      tasteRepository: { canonicalRoot: () => root, approvalLockKey: () => 'unused' },
      messageSearchService: messages,
    },
  });
  await app.register(evidenceRoutes, { evidenceStore: evidence, messageSearchService: messages });
  await app.register(libraryRoutes, { catalog, stores });
  await app.register(tasteBrowseRoutes, {
    ownerUserId: 'owner',
    tasteRepository: { canonicalRoot: () => root, approvalLockKey: () => 'unused' },
    proposalStore: new InMemoryTasteProposalStore(),
    threadStore,
    messageStore,
    readObservatory: async () => ({ entries: [], coverage: { totalUnverified: 0 } }),
  });
  await app.ready();
  const samples: Record<string, { status: number; body: unknown }> = {};
  async function sample(url: string) {
    const response = await app.inject({ url, headers: { 'x-test-session': 'owner' } });
    assert.equal(response.statusCode, 200, `Production search fixture read failed: ${url}: ${response.body}`);
    const key = new URL(url, 'http://fixture');
    key.searchParams.sort();
    samples[key.pathname + key.search] = { status: response.statusCode, body: response.json() };
    return response;
  }
  for (const q of ['搜索设计', 'never-seen-token', 'old']) {
    for (const type of ['all', 'memory', 'documents', 'conversations']) {
      for (const depth of ['summary', 'raw'])
        await sample(`/api/memory/search?${new URLSearchParams({ q, type, depth })}`);
    }
  }
  await sample('/api/memory/search/document?collection=project:search&anchor=search-design');
  await sample('/api/library/graph?anchor=search-design&depth=1&collection=project:search');
  const tasteResponse = await sample('/api/memory/taste');
  const taste = tasteResponse.json().entries[0];
  if (!taste) throw new Error('Real taste browser source missing');
  await sample(`/api/memory/taste/${taste.id}?revision=${encodeURIComponent(taste.revision)}`);
  await sample(`/api/memory/taste/${taste.id}/source?revision=${encodeURIComponent(taste.revision)}`);
  const messageResponse =
    samples[
      new URL(
        `/api/memory/search?${new URLSearchParams({ q: '搜索设计', type: 'conversations', depth: 'summary' })}`,
        'http://fixture',
      ).pathname +
        '?' +
        new URLSearchParams({ depth: 'summary', q: '搜索设计', type: 'conversations' })
    ];
  const body = messageResponse?.body as {
    groups: Array<{
      results: Array<{ destination: { threadId: string; messageId: string; contentRevision: string } }>;
    }>;
  };
  const target = body.groups[0]?.results[0]?.destination;
  if (!target) throw new Error('Real canonical message search did not return its owner source');
  await sample(
    `/api/evidence/navigation-source?${new URLSearchParams({ threadId: target.threadId, messageId: target.messageId, contentRevision: target.contentRevision })}`,
  );
  const ownMessages = { messages: messageStore.getByThread(own.id, 100), hasMore: false };
  samples[`/api/threads/${own.id}`] = { status: 200, body: own };
  samples[`/api/threads/${own.id}/messages?limit=50`] = { status: 200, body: ownMessages };
  process.stdout.write(`F321_SEARCH_JSON=${JSON.stringify({ samples, ownThreadId: own.id, messageId: message.id })}\n`);
} finally {
  await app.close();
  await evidence.close();
  await rm(root, { recursive: true });
}
