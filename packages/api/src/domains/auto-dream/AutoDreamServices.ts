import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveCollectionStorePath } from '../memory/external-collections.js';
import type { IEvidenceStore } from '../memory/interfaces.js';
import type { LibraryCatalog } from '../memory/LibraryCatalog.js';
import { SqliteEvidenceStore } from '../memory/SqliteEvidenceStore.js';
import { AutoDreamStore } from './AutoDreamStore.js';
import { DiaryEvidenceProjector, type DiaryProjectionResult } from './DiaryEvidenceProjector.js';

export const DIARY_COLLECTION_ID = 'world:diary';

interface CreateAutoDreamServicesOptions {
  dataDir: string;
  privateUserId: string;
  catalog: LibraryCatalog;
  collectionStores: Map<string, IEvidenceStore>;
  productDbPath?: string;
  evidenceDbPath?: string;
  awakenedLeaseMs?: number;
}

export interface AutoDreamServices {
  store: AutoDreamStore;
  evidenceStore: SqliteEvidenceStore;
  projector: DiaryEvidenceProjector;
  startupReconciliation: DiaryProjectionResult;
  close(): void;
}

async function reconcileStartupBacklog(
  projector: DiaryEvidenceProjector,
  ownerUserId: string,
): Promise<DiaryProjectionResult> {
  const total: DiaryProjectionResult = { projected: 0, removed: 0, failed: 0 };
  const batchSize = 100;
  for (;;) {
    const batch = await projector.reconcile(ownerUserId, batchSize);
    total.projected += batch.projected;
    total.removed += batch.removed;
    total.failed += batch.failed;
    if (batch.failed > 0 || batch.projected + batch.removed < batchSize) return total;
  }
}

export async function createAutoDreamServices(options: CreateAutoDreamServicesOptions): Promise<AutoDreamServices> {
  const privateUserId = options.privateUserId.trim();
  if (!privateUserId) throw new Error('privateUserId is required for auto-dream persistence');
  if (options.catalog.get(DIARY_COLLECTION_ID) || options.collectionStores.has(DIARY_COLLECTION_ID)) {
    throw new Error(`${DIARY_COLLECTION_ID} is already registered`);
  }

  const root = join(options.dataDir, 'auto-dream');
  mkdirSync(root, { recursive: true });
  const productDbPath = options.productDbPath ?? join(root, 'auto-dream.sqlite');
  const evidenceDbPath = options.evidenceDbPath ?? resolveCollectionStorePath(options.dataDir, DIARY_COLLECTION_ID);
  if (productDbPath !== ':memory:') mkdirSync(dirname(productDbPath), { recursive: true });
  if (evidenceDbPath !== ':memory:') mkdirSync(dirname(evidenceDbPath), { recursive: true });

  const store = new AutoDreamStore(productDbPath, { awakenedLeaseMs: options.awakenedLeaseMs });
  const evidenceStore = new SqliteEvidenceStore(evidenceDbPath, undefined, {
    sourceRoot: root,
    sourceRef: DIARY_COLLECTION_ID,
  });
  await store.initialize();
  try {
    await evidenceStore.initialize();
  } catch (error) {
    store.close();
    throw error;
  }

  const now = new Date().toISOString();
  options.catalog.register({
    id: DIARY_COLLECTION_ID,
    kind: 'world',
    name: 'diary',
    displayName: 'Cat Diaries',
    root,
    sensitivity: 'private',
    ownerUserId: privateUserId,
    scannerLevel: 0,
    indexPolicy: { autoRebuild: false },
    reviewPolicy: { authorityCeiling: 'observed', requireOwnerApproval: true },
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
  options.collectionStores.set(DIARY_COLLECTION_ID, evidenceStore);

  const projector = new DiaryEvidenceProjector(store, evidenceStore, privateUserId);
  const startupReconciliation = await reconcileStartupBacklog(projector, privateUserId);
  let closed = false;
  return {
    store,
    evidenceStore,
    projector,
    startupReconciliation,
    close() {
      if (closed) return;
      closed = true;
      options.collectionStores.delete(DIARY_COLLECTION_ID);
      if (options.catalog.get(DIARY_COLLECTION_ID)) options.catalog.unbind(DIARY_COLLECTION_ID);
      evidenceStore.close();
      store.close();
    },
  };
}
