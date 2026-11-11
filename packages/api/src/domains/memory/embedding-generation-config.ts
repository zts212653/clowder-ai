import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { normalizeLoopbackUrl } from '../services/loopback-url.js';
import type { EmbedConfig } from './interfaces.js';
import { type VectorGenerationId, vectorGenerationTables } from './vector-generation-tables.js';

export interface EmbeddingRecipe {
  version: number;
  modelId: string;
  modelRevision: string;
  modelConfigSha256: string;
  weightsSha256: string;
  quantization: string;
  tokenizerSha256: string;
  tokenizerConfigSha256: string;
  backend: string;
  backendVersion: string;
  backendCodeSha256: string;
  mlxVersion: string;
  queryInstruction: string;
  documentInstruction: string;
  textCharacterLimit: number;
  tokenLimit: number;
  pooling: string;
  nativeDim: number;
  dim: number;
  normalization: string;
}
export interface EmbeddingDeployment {
  version: 1;
  activeId: VectorGenerationId;
  retainedIds: VectorGenerationId[];
  buildTargetId: VectorGenerationId;
  generations: Record<
    VectorGenerationId,
    {
      recipe: EmbeddingRecipe | null;
      runtime: { maxModelMemMb: number | null; cacheMb: 0; retainedEndpoint?: string | null };
    }
  >;
}

/** Versioned intent, not an active flag in each database or a build trigger. */
export function readEmbeddingDeployment(): EmbeddingDeployment {
  const value = JSON.parse(
    readFileSync(new URL('../../../runtime/services/embedding-generations.json', import.meta.url), 'utf8'),
  ) as EmbeddingDeployment;
  if (value.version !== 1 || !Array.isArray(value.retainedIds)) throw new Error('Invalid embedding deployment');
  for (const id of [value.activeId, value.buildTargetId, ...value.retainedIds]) vectorGenerationTables(id);
  return value;
}

/** An explicit retained address is independent of the active generation endpoint. */
export function resolveRetainedG0Endpoint(
  deployment: EmbeddingDeployment,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = env.EMBED_G0_URL ?? deployment.generations.g0.runtime.retainedEndpoint;
  if (configured == null || configured === '') return;
  if (typeof configured !== 'string') throw new Error('Invalid retained G0 endpoint');
  return requireLoopbackEmbeddingEndpoint(configured);
}

export function requireLoopbackEmbeddingEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Embedding endpoint must be loopback');
  return normalizeLoopbackUrl(url.toString().replace(/\/$/, ''));
}

export function embeddingRecipeFingerprint(recipe: EmbeddingRecipe): string {
  return createHash('sha256')
    .update(JSON.stringify(Object.fromEntries(Object.entries(recipe).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))))
    .digest('hex');
}

export function generationEmbedConfig(
  config: EmbedConfig,
  deployment: EmbeddingDeployment,
  id = deployment.activeId,
): EmbedConfig {
  const entry = deployment.generations[vectorGenerationTables(id).generationId];
  if (!entry) throw new Error('Embedding generation is not configured');
  if (!entry.recipe) {
    if (id !== 'g0') throw new Error('Embedding representation recipe is required');
    return { ...config, generationId: 'g0' };
  }
  const maxModelMemMb = entry.runtime.maxModelMemMb;
  if (!Number.isSafeInteger(maxModelMemMb) || !maxModelMemMb || maxModelMemMb < 1 || entry.runtime.cacheMb !== 0) {
    throw new Error('Embedding generation memory limit has not been validated');
  }
  return {
    ...config,
    generationId: id,
    embedModel: entry.recipe.modelId,
    embedModelRev: entry.recipe.modelRevision,
    embedDim: entry.recipe.dim,
    representationFingerprint: embeddingRecipeFingerprint(entry.recipe),
    maxModelMemMb,
    queryInstruction: entry.recipe.queryInstruction,
  };
}
