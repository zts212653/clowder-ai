import type { EvidenceItem, IEmbeddingService } from './interfaces.js';
import type { VectorStore } from './VectorStore.js';

const EMBED_BATCH_SIZE = 64;

export interface EmbedPipelineContext {
  items: EvidenceItem[];
  embedding: IEmbeddingService;
  vectorStore: VectorStore;
  allDocsProvider?: () => EvidenceItem[];
}

export async function embedIndexedItems(ctx: EmbedPipelineContext): Promise<void> {
  if (ctx.items.length === 0) return;
  await ctx.embedding.reprobeIfNeeded();
  if (!ctx.embedding.isReady()) return;

  let toEmbed = ctx.items;

  if (ctx.allDocsProvider) {
    const consistency = ctx.vectorStore.checkMetaConsistency(ctx.embedding.getModelInfo());
    if (!consistency.consistent) {
      ctx.vectorStore.clearAll();
      toEmbed = ctx.allDocsProvider();
    }
  }

  for (let offset = 0; offset < toEmbed.length; offset += EMBED_BATCH_SIZE) {
    const batch = toEmbed.slice(offset, offset + EMBED_BATCH_SIZE);
    const texts = batch.map((i) => `${i.title} ${i.summary ?? ''}`);
    const vectors = await ctx.embedding.embed(texts);
    for (let i = 0; i < batch.length; i++) {
      ctx.vectorStore.upsert(batch[i].anchor, vectors[i]);
    }
  }

  ctx.vectorStore.initMeta(ctx.embedding.getModelInfo());
}
