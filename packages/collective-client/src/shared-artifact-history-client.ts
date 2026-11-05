import {
  collectiveArtifactCatalogueHistoryPageSchema,
  collectiveArtifactRequestReceiptPageSchema,
} from '@cat-cafe/shared';
import type { SharedArtifact } from './collective-artifact-client.js';

type Post = <T>(path: string, body: unknown) => Promise<T>;
export function sharedArtifactHistoryClient(
  post: Post,
  coordinates: { serviceInstanceId: string; collectiveId: string },
) {
  const history = async (
    artifact: SharedArtifact,
    page: { offset?: number; limit?: number; snapshotOwnerRevision?: number; expectedSnapshot?: string } = {},
  ) => {
    const value = collectiveArtifactCatalogueHistoryPageSchema.parse(
      await post('history', {
        ...coordinates,
        artifactId: artifact.artifactId,
        sourceEventId: artifact.sourceEventId,
        ...page,
      }),
    );
    if (
      value.artifactId !== artifact.artifactId ||
      value.contentRef !== artifact.contentRef ||
      value.sourceEventId !== artifact.sourceEventId ||
      value.offset !== (page.offset ?? 0) ||
      (page.snapshotOwnerRevision !== undefined && value.snapshotOwnerRevision !== page.snapshotOwnerRevision) ||
      (page.expectedSnapshot !== undefined && value.snapshot !== page.expectedSnapshot) ||
      (value.nextOffset !== undefined && value.nextOffset !== value.offset + value.versions.length) ||
      (value.nextOffset !== undefined && value.nextOffset >= value.total) ||
      value.versions.length > (page.limit ?? 30) ||
      (value.offset === 0 && value.versions[0]?.ownerRevision !== value.snapshotOwnerRevision) ||
      value.versions.some(
        (version, index) =>
          version.ownerRevision > value.snapshotOwnerRevision ||
          (index > 0 && version.ownerRevision >= (value.versions[index - 1]?.ownerRevision ?? 0)),
      ) ||
      (value.offset < value.total && value.versions.length === 0)
    )
      throw new Error('版本记录正在更新，请重新读取。');
    return value;
  };
  const version = async (artifact: SharedArtifact, ownerRevision: number) => {
    const value = await history(artifact, { snapshotOwnerRevision: ownerRevision, limit: 1 });
    const selected = value.versions[0];
    if (selected?.ownerRevision !== ownerRevision) throw new Error('作品版本已改变，请重新打开。');
    return selected;
  };
  const receipts = batchedRequestReceipts(post, coordinates);
  return { history, version, receipts };
}
export type SharedArtifactHistoryPage = Awaited<ReturnType<ReturnType<typeof sharedArtifactHistoryClient>['history']>>;

type ReceiptPage = ReturnType<typeof collectiveArtifactRequestReceiptPageSchema.parse>['receipts'];
function batchedRequestReceipts(post: Post, coordinates: { serviceInstanceId: string; collectiveId: string }) {
  const pending = new Map<string, Array<{ resolve(value: ReceiptPage): void; reject(error: unknown): void }>>();
  let scheduled = false;
  const flush = async () => {
    const queued = [...pending];
    pending.clear();
    scheduled = false;
    for (let offset = 0; offset < queued.length; offset += 30)
      await readReceiptBatch(post, coordinates, queued.slice(offset, offset + 30));
  };
  return (requestEventId: string): Promise<ReceiptPage> =>
    new Promise((resolve, reject) => {
      const listeners = pending.get(requestEventId) ?? [];
      listeners.push({ resolve, reject });
      pending.set(requestEventId, listeners);
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(() => {
          void flush();
        });
      }
    });
}

async function readReceiptBatch(
  post: Post,
  coordinates: { serviceInstanceId: string; collectiveId: string },
  batch: Array<[string, Array<{ resolve(value: ReceiptPage): void; reject(error: unknown): void }>]>,
) {
  try {
    const requestEventIds = batch.map(([id]) => id);
    const value = collectiveArtifactRequestReceiptPageSchema.parse(
      await post('receipts/by-request', { ...coordinates, requestEventIds }),
    );
    assertReceiptBindings(value.receipts, coordinates, requestEventIds);
    for (const [id, listeners] of batch) {
      const receipts = value.receipts.filter((receipt) => receipt.version.lineage?.requestEventId === id);
      for (const listener of listeners) listener.resolve(receipts);
    }
  } catch (error) {
    for (const [, listeners] of batch) for (const listener of listeners) listener.reject(error);
  }
}
function assertReceiptBindings(
  receipts: ReceiptPage,
  coordinates: { serviceInstanceId: string; collectiveId: string },
  requestEventIds: string[],
) {
  const seen = new Set<string>();
  for (const receipt of receipts) {
    const id = receipt.version.lineage?.requestEventId;
    if (
      !id ||
      !requestEventIds.includes(id) ||
      seen.has(id) ||
      receipt.artifact.serviceInstanceId !== coordinates.serviceInstanceId ||
      receipt.artifact.collectiveId !== coordinates.collectiveId
    )
      throw new Error('采用回执与原请求不一致，请重新读取。');
    seen.add(id);
  }
}
