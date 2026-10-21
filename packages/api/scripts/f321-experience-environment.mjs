// Isolated source-owner environment for F321 consumer trials, never a production data writer.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { SessionMutex } from '../dist/domains/cats/services/agents/invocation/SessionMutex.js';
import { approveProfileUpdate } from '../dist/domains/cats/services/profile/approveProfileUpdate.js';
import { FileProfileRepository } from '../dist/domains/cats/services/profile/ProfileRepository.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { InMemoryProfileUpdateProposalStore } from '../dist/domains/cats/services/stores/ports/ProfileUpdateProposalStore.js';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { IndexBuilder } from '../dist/domains/memory/IndexBuilder.js';
import { resolveEmbedConfig } from '../dist/domains/memory/interfaces.js';
import { KnowledgeResolver } from '../dist/domains/memory/KnowledgeResolver.js';
import { LibraryCatalog } from '../dist/domains/memory/LibraryCatalog.js';
import { MemoryEmbeddingLifecycle } from '../dist/domains/memory/MemoryEmbeddingLifecycle.js';
import { MessageSearchService } from '../dist/domains/memory/MessageSearchService.js';
import { SqliteEvidenceStore } from '../dist/domains/memory/SqliteEvidenceStore.js';
import { evidenceRoutes } from '../dist/routes/evidence.js';
import { libraryRoutes } from '../dist/routes/library.js';
import { canonicalTestMessageInput } from '../test/helpers/message-from-fixtures.js';

export async function createExperienceEnvironment(repoRoot, root) {
  const project = join(root, 'project');
  const docs = join(project, 'docs');
  mkdirSync(docs, { recursive: true });
  const paths = execFileSync(
    'git',
    ['ls-files', 'docs/features', 'docs/decisions', 'docs/design', 'docs/runbooks', 'DESIGN.md'],
    { cwd: repoRoot, encoding: 'utf8' },
  )
    .trim()
    .split('\n');
  for (const path of paths.filter(
    (path) =>
      path.endsWith('.md') && !path.includes('F321-') && !path.includes('/evidence/') && !path.includes('/assets/'),
  )) {
    const target = join(project, path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(repoRoot, path), target);
  }
  const git = (...args) =>
    execFileSync(
      'git',
      ['-c', 'user.name=F321 isolated source owner', '-c', 'user.email=f321-fixture@localhost', ...args],
      { cwd: project, encoding: 'utf8' },
    ).trim();
  git('init', '--quiet');
  git('add', 'docs', 'DESIGN.md');
  git('commit', '--quiet', '-m', 'Import controlled canonical project documents');
  const store = new SqliteEvidenceStore(join(root, 'index.sqlite'));
  await store.initialize();
  const builder = new IndexBuilder(store, docs);
  const embeddingLifecycle = new MemoryEmbeddingLifecycle(store, builder, resolveEmbedConfig({ embedMode: 'on' }));
  const activation = await embeddingLifecycle.activate('on');
  assert.equal(activation.ok, true, `healthy production embedding path required: ${JSON.stringify(activation)}`);
  const initialIndex = await builder.rebuild();
  const vectorCount = store.getDb().prepare('SELECT count(*) AS count FROM evidence_vectors').get().count;
  const documentCount = store.getDb().prepare('SELECT count(*) AS count FROM evidence_docs').get().count;
  assert.equal(vectorCount, documentCount, 'every controlled document needs its normal summary vector');
  const catalog = new LibraryCatalog();
  catalog.register({
    id: 'project:cat-cafe',
    kind: 'project',
    sensitivity: 'internal',
    root: docs,
    scannerLevel: 3,
    name: 'cat-cafe',
    displayName: 'Clowder AI',
    indexPolicy: { autoRebuild: false },
    reviewPolicy: { authorityCeiling: 'project', requireOwnerApproval: true },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const stores = new Map([['project:cat-cafe', store]]);
  const knowledgeResolver = new KnowledgeResolver({ projectStore: store, catalog, stores });
  const repository = new FileProfileRepository({ dataDir: join(root, 'data') });
  const proposals = new InMemoryProfileUpdateProposalStore();
  const registry = new InvocationRegistry();
  const messages = new MessageStore();
  const tasks = new TaskStore();
  const threads = new ThreadStore();
  const sourceThread = threads.create('trial-owner', '原始约定', project);
  const consumerThread = threads.create('trial-owner', '后续任务', project);
  const threadBuilder = new IndexBuilder(
    store,
    docs,
    {
      embedding: embeddingLifecycle.getService(),
      vectorStore: embeddingLifecycle.getVectorStore(),
      passageVectorStore: embeddingLifecycle.getPassageVectorStore(),
    },
    undefined,
    () => threads.list('trial-owner'),
    (id, limit) => messages.getByThread(id, limit, 'trial-owner'),
  );
  const messageSearch = new MessageSearchService({
    evidenceStore: store,
    messageStore: messages,
    threadStore: threads,
  });
  mkdirSync(join(project, '.codex'), { recursive: true });
  symlinkSync(join(repoRoot, 'cat-cafe-skills'), join(project, '.codex/skills'), 'dir');
  const app = Fastify();
  const requests = [];
  app.addHook('onRequest', async (req) => requests.push({ method: req.method, url: req.url }));
  const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
  await app.register(callbacksRoutes, {
    registry,
    messageStore: messages,
    threadStore: threads,
    taskStore: tasks,
    profileRepository: repository,
    profileUpdateProposalStore: proposals,
    evidenceStore: store,
    messageSearchService: messageSearch,
    socketManager: { emitToUser() {}, broadcastToRoom() {} },
  });
  await app.register(evidenceRoutes, {
    evidenceStore: store,
    docsRoot: docs,
    indexBuilder: builder,
    messageSearchService: messageSearch,
    knowledgeResolver,
    embeddingService: embeddingLifecycle.getService(),
    catalog,
  });
  await app.register(libraryRoutes, {
    catalog,
    stores: new Map([['project:cat-cafe', store]]),
    dataDir: join(root, 'data'),
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const append = (content, catId = null) =>
    messages.append(
      canonicalTestMessageInput({
        userId: 'trial-owner',
        catId,
        content,
        timestamp: Date.now(),
        mentions: [],
        threadId: sourceThread.id,
      }),
    );
  const legalProfile = async (content) => {
    const source = append(content);
    const auth = await registry.create('trial-owner', 'codex61-sol', sourceThread.id, undefined, source.id);
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/propose-profile-update',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload: {
        afterContent: content,
        rationale: '沿原 owner 保存本轮新约定与出处',
        signalKind: 'cvo-instructed',
        sourceMessageId: source.id,
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    const result = await approveProfileUpdate(response.json().proposalId, 'trial-owner', {
      store: proposals,
      lock: new SessionMutex(),
      repository,
    });
    assert.equal(result.ok, true);
    threadBuilder.markThreadDirty(sourceThread.id);
    await threadBuilder.flushDirtyThreads();
    return {
      sourceMessageId: source.id,
      revision: result.revision,
      proposalId: response.json().proposalId,
      approvedBy: 'isolated trial-owner',
    };
  };
  return {
    root,
    project,
    docs,
    app,
    address,
    registry,
    repository,
    requests,
    store,
    builder,
    initialIndex,
    retrievalHealth: {
      activation,
      model: embeddingLifecycle.getService().getModelInfo(),
      documentCount,
      vectorCount,
      target: 'default document-summary hybrid; raw passage warmup not a prerequisite for this path',
    },
    git,
    append,
    legalProfile,
    tasks,
    async flushSourceThread() {
      threadBuilder.markThreadDirty(sourceThread.id);
      await threadBuilder.flushDirtyThreads();
    },
    sourceThreadId: sourceThread.id,
    consumerThreadId: consumerThread.id,
    async recordProject(relativePath, content) {
      const path = join(docs, relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      git('add', 'docs', 'DESIGN.md');
      git('commit', '--quiet', '-m', 'Record reusable observation through the original project Git owner');
      await builder.incrementalUpdate([path]);
      threadBuilder.markThreadDirty(sourceThread.id);
      await threadBuilder.flushDirtyThreads();
      const indexed = store
        .getDb()
        .prepare('SELECT anchor, source_hash FROM evidence_docs WHERE source_path = ?')
        .get(relativePath);
      const vectorSource = store
        .getDb()
        .prepare('SELECT source_hash FROM document_vector_sources WHERE anchor = ?')
        .get(indexed.anchor);
      assert.equal(
        vectorSource.source_hash,
        indexed.source_hash,
        'source update must finish its current summary vector',
      );
      return {
        path: relativePath,
        revision: createHash('sha256').update(content).digest('hex'),
        commit: git('rev-parse', 'HEAD'),
        readable: readFileSync(path, 'utf8') === content,
        indexed,
        vectorSource,
      };
    },
    async close() {
      await app.close();
      embeddingLifecycle.deactivate();
      store.close();
    },
  };
}
