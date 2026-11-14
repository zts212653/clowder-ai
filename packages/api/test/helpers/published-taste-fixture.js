import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionMutex } from '../../dist/domains/cats/services/agents/invocation/SessionMutex.js';
import {
  InMemoryOwnerMemoryActionReceiptStore,
  OwnerMemoryActionCoordinator,
} from '../../dist/domains/memory/owner/OwnerMemoryActionCoordinator.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { TasteMemoryLifecycleService } from '../../dist/domains/memory/taste/TasteMemoryLifecycleService.js';
import { TasteMemoryLifecycleStore } from '../../dist/domains/memory/taste/TasteMemoryLifecycleStore.js';
import { TasteMemoryProjectionWriter } from '../../dist/domains/memory/taste/TasteMemoryProjectionWriter.js';
import { TasteMemoryReader } from '../../dist/domains/memory/taste/TasteMemoryReader.js';
import { tasteDocumentAnchor } from '../../dist/domains/memory/taste/taste-memory-identity.js';
import { FileTasteRepository } from '../../dist/domains/taste/services/TasteRepository.js';
import { createRemoteFixture, git } from '../taste-publication-fixtures.js';

export const sourcePath = 'docs/taste/vignettes/astra-public.md';
export const owner = 'astra-review-owner';
export const original =
  '---\nwhen: 2026-10-06\nquotes: ["Zebramemoria"]\nscene: "Zebramemoria Old scene"\ntags: ["public"]\ndimension: visual-quality\nprivacy: public\n---\n';
export const revision = (content) => `sha256:${createHash('sha256').update(content).digest('hex')}`;
export async function fixture({ durable = false } = {}) {
  const f = createRemoteFixture();
  mkdirSync(join(f.primary, 'docs/taste/vignettes'), { recursive: true });
  writeFileSync(join(f.primary, sourcePath), original);
  git(f.primary, ['add', sourcePath]);
  git(f.primary, ['commit', '-m', 'seed existing public memory']);
  git(f.primary, ['push', 'origin', 'main']);
  const evidence = new SqliteEvidenceStore(durable ? join(f.root, 'evidence.sqlite') : ':memory:');
  await evidence.initialize();
  const store = new TasteMemoryLifecycleStore(evidence.getDb());
  const repository = new FileTasteRepository(f.runtime);
  const reader = new TasteMemoryReader(repository, owner, { lifecycle: store });
  const service = new TasteMemoryLifecycleService({
    store,
    writer: new TasteMemoryProjectionWriter(repository),
    coordinator: new OwnerMemoryActionCoordinator({
      store: new InMemoryOwnerMemoryActionReceiptStore(),
      lock: new SessionMutex(),
    }),
    targetLock: new SessionMutex(),
    lockKey: () => repository.approvalLockKey(),
    invalidateDerived: ({ sourcePath }) => evidence.deleteByAnchor(tasteDocumentAnchor(sourcePath)),
  });
  return { ...f, evidence, store, reader, service, repository };
}
