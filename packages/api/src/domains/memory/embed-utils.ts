import type { EvidenceItem, IEmbeddingService } from './interfaces.js';
import { type PassageVectorStore, passageVectorKey } from './PassageVectorStore.js';
import type { VectorStore } from './VectorStore.js';

const EMBED_BATCH_SIZE = 64;

export interface EmbedPipelineContext {
  items: EvidenceItem[];
  embedding: IEmbeddingService;
  vectorStore: VectorStore;
  allDocsProvider?: () => EvidenceItem[];
  onVectorReset?: () => void;
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
      ctx.onVectorReset?.();
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

export interface PassageEmbeddingRow {
  docAnchor: string;
  passageId: string;
  content: string;
}

export interface PassageEmbedPipelineContext {
  passages: PassageEmbeddingRow[];
  embedding: IEmbeddingService;
  passageVectorStore: PassageVectorStore;
}

export async function embedPassages(ctx: PassageEmbedPipelineContext): Promise<void> {
  if (ctx.passages.length === 0) return;
  await ctx.embedding.reprobeIfNeeded();
  if (!ctx.embedding.isReady()) return;

  for (let offset = 0; offset < ctx.passages.length; offset += EMBED_BATCH_SIZE) {
    const batch = ctx.passages.slice(offset, offset + EMBED_BATCH_SIZE);
    const vectors = await ctx.embedding.embed(batch.map((p) => p.content));
    for (let i = 0; i < batch.length; i++) {
      const passage = batch[i];
      ctx.passageVectorStore.upsert(passageVectorKey(passage.docAnchor, passage.passageId), vectors[i]);
    }
  }
}
