import * as sqliteVec from 'sqlite-vec';
import { CatCafeScanner } from './CatCafeScanner.js';
import { checkpointMemoryDatabase } from './checkpoint-memory-database.js';
import { GenericRepoScanner } from './GenericRepoScanner.js';
import type { EmbedModelInfo, IEmbeddingService } from './interfaces.js';
import { memoryProcessStderrBoundary } from './memory-process-diagnostics.js';
import {
  type ChildMessage,
  type EmbeddingSnapshot,
  encodeProcessError,
  type MemoryProcessJob,
  type ParentMessage,
} from './memory-process-protocol.js';
import { PassageVectorStore } from './PassageVectorStore.js';
import { projectEntityMentions } from './project-entity-mentions.js';
import { lookupShadowRanking, SqliteEvidenceStore } from './SqliteEvidenceStore.js';
import { VectorStore } from './VectorStore.js';

let rpcSequence = 0;
const pending = new Map<number, { resolve(value: Extract<ParentMessage, { type: 'embedding-result' }>): void }>();
function send(message: ChildMessage) {
  if (process.connected) process.send?.(message);
}
function embeddingProxy(snapshot: EmbeddingSnapshot): IEmbeddingService {
  let ready = snapshot.ready;
  let model: EmbedModelInfo = snapshot.model;
  async function call(method: 'load' | 'reprobeIfNeeded' | 'embed', texts?: string[]) {
    const id = ++rpcSequence;
    const result = await new Promise<Extract<ParentMessage, { type: 'embedding-result' }>>((resolve) => {
      pending.set(id, { resolve });
      send({ type: 'embedding', id, method, texts });
    });
    ready = result.ready;
    if (result.model) model = result.model;
    if (result.error) throw Object.assign(new Error(result.error.message), { name: result.error.name });
    return result.value;
  }
  return {
    load: async () => {
      await call('load');
    },
    reprobeIfNeeded: async () => {
      await call('reprobeIfNeeded');
    },
    embed: async (texts) => (await call('embed', texts)) as Float32Array[],
    isReady: () => ready,
    getModelInfo: () => model,
    dispose() {},
  };
}

async function execute(job: MemoryProcessJob, started: () => void): Promise<unknown> {
  if (job.kind === 'scan') {
    started();
    const scanner = job.scanner === 'cat-cafe' ? new CatCafeScanner(job.excludes) : new GenericRepoScanner();
    return job.singlePath ? scanner.parseSingle(job.singlePath, job.root) : scanner.discover(job.root, job.options);
  }
  if (job.kind === 'checkpoint') {
    started();
    return checkpointMemoryDatabase(job.dbPath);
  }
  const store = new SqliteEvidenceStore(job.dbPath, undefined, {
    workerMode: 'read',
    ...(job.kind === 'search' ? { sourceRoot: job.sourceRoot, sourceRef: job.sourceRef } : {}),
  });
  await store.initialize();
  try {
    const db = store.getDb();
    // Register existing vec0 tables; this does not create/migrate or mutate them.
    try {
      sqliteVec.load(db);
    } catch {
      /* vec0 remains an optional accelerator */
    }
    started();
    switch (job.kind) {
      case 'search':
      case 'message-search': {
        for (const key of Object.keys(process.env))
          if (key.startsWith('F163_') || key.startsWith('F200_')) delete process.env[key];
        Object.assign(process.env, job.flags);
        if (job.embedding) {
          const dim = job.embedding.model.dim;
          store.setEmbedDeps({
            embedding: embeddingProxy(job.embedding),
            mode: job.embedding.mode,
            vectorStore: new VectorStore(db, dim),
            ...(job.embedding.passages ? { passageVectorStore: new PassageVectorStore(db, dim) } : {}),
          });
        }
        if (job.kind === 'message-search') return await store.searchMessagePassages(job.query, job.options);
        const result = await store.searchWithMeta(job.query, job.options);
        return { result, shadow: lookupShadowRanking(result.items.map((item) => item.anchor)) };
      }
      case 'project-mentions':
        return projectEntityMentions(db, job.stagingPath, job);
    }
  } finally {
    store.close();
  }
}

process.on('message', (message: ParentMessage) => {
  if (message.type === 'embedding-result') {
    pending.get(message.id)?.resolve(message);
    pending.delete(message.id);
    return;
  }
  process.stderr.write(memoryProcessStderrBoundary(message.stderrToken, message.id, 'begin'));
  const finish = (result: Extract<ChildMessage, { type: 'result' }>) => {
    process.stderr.write(memoryProcessStderrBoundary(message.stderrToken, message.id, 'end'));
    send(result);
  };
  void execute(message.job, () => send({ type: 'started', id: message.id, pid: process.pid })).then(
    (value) => finish({ type: 'result', id: message.id, value }),
    (error) => finish({ type: 'result', id: message.id, error: encodeProcessError(error) }),
  );
});
process.on('disconnect', () => process.exit(0));
