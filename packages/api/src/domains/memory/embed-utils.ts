import type { EvidenceItem, IEmbeddingService } from './interfaces.js';
import type { VectorStore } from './VectorStore.js';

const EMBED_BATCH_SIZE = 64;

export async function embedIndexedItems(
  items: EvidenceItem[],
  embedding: IEmbeddingService,
  vectorStore: VectorStore,
): Promise<void> {
  if (items.length === 0) return;
  await embedding.reprobeIfNeeded();
  if (!embedding.isReady()) return;

  for (let offset = 0; offset < items.length; offset += EMBED_BATCH_SIZE) {
    const batch = items.slice(offset, offset + EMBED_BATCH_SIZE);
    const texts = batch.map((i) => `${i.title} ${i.summary ?? ''}`);
    const vectors = await embedding.embed(texts);
    for (let i = 0; i < batch.length; i++) {
      vectorStore.upsert(batch[i].anchor, vectors[i]);
    }
  }
  vectorStore.initMeta(embedding.getModelInfo());
}
