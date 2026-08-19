import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { TasteRepository } from '../../../taste/services/TasteRepository.js';
import { TasteMemoryReader, type TasteMemoryReadResult } from '../../taste/TasteMemoryReader.js';
import type { TasteDimensionMapSource } from '../resolvers/TasteCueResolver.js';

const TASTE_MAP_VERSION = 1;
const MAX_DRILL_PAYLOAD_CHARS = 32_768;
const PUBLIC_DIRECTORY = 'docs/taste/vignettes';
const PRIVATE_DIRECTORY = 'private/taste';
const KNOWN_DIMENSIONS = new Set([
  'relationship-stance',
  'cognitive-honesty',
  'architecture-aesthetics',
  'visual-quality',
  'authentic-expression',
  'system-philosophy',
  'creative-craft',
]);

export const TASTE_SKILL_DIMENSIONS_V1 = Object.freeze({
  'writing-plans': Object.freeze(['cognitive-honesty', 'architecture-aesthetics']),
  'co-creation-docs': Object.freeze(['cognitive-honesty', 'authentic-expression']),
  'fresh-context-review': Object.freeze(['cognitive-honesty', 'architecture-aesthetics']),
  'request-review': Object.freeze(['cognitive-honesty', 'architecture-aesthetics']),
});

type TasteSkill = keyof typeof TASTE_SKILL_DIMENSIONS_V1;

interface TasteSnapshot {
  dimensions: string[];
  revision: string;
  visibility: 'owner_public' | 'owner_private';
  results: TasteMemoryReadResult[];
  totalCount: number;
}

export type TasteMemoryCueReadResult =
  | { status: 'ok'; payload: unknown }
  | { status: 'not_available'; invalidationReason: 'source_corrected' | 'source_forgotten' };

function listSourcePaths(root: string): string[] {
  return [PUBLIC_DIRECTORY, PRIVATE_DIRECTORY].flatMap((directory) => {
    try {
      return readdirSync(join(root, directory), { withFileTypes: true })
        .filter((entry) => entry.isFile() || entry.isSymbolicLink())
        .map((entry) => `${directory}/${entry.name}`);
    } catch {
      return [];
    }
  });
}

function boundedResults(results: TasteMemoryReadResult[], dimensions: readonly string[]): TasteMemoryReadResult[] {
  const selected: TasteMemoryReadResult[] = [];
  for (const result of results) {
    const candidate = [...selected, result];
    if (JSON.stringify({ dimensions, vignettes: candidate }).length > MAX_DRILL_PAYLOAD_CHARS) break;
    selected.push(result);
  }
  return selected;
}

/** Read-only dimension directory over approved F221 vignettes. */
export class CanonicalTasteMemoryCueSource implements TasteDimensionMapSource {
  private readonly reader: TasteMemoryReader;

  constructor(
    private readonly repository: TasteRepository,
    private readonly ownerUserId: string,
  ) {
    this.reader = new TasteMemoryReader(repository, ownerUserId);
  }

  async resolve(input: {
    ownerUserId: string;
    stage: 'quality_gate' | 'review';
    selectedSkill: TasteSkill;
    featureId: string;
  }): Promise<Pick<TasteSnapshot, 'dimensions' | 'revision' | 'visibility'> | null> {
    void input.stage;
    void input.featureId;
    if (input.ownerUserId !== this.ownerUserId) return null;
    const snapshot = this.snapshot(input.ownerUserId, TASTE_SKILL_DIMENSIONS_V1[input.selectedSkill]);
    return snapshot
      ? { dimensions: snapshot.dimensions, revision: snapshot.revision, visibility: snapshot.visibility }
      : null;
  }

  async read(input: {
    ownerUserId: string;
    anchor: string;
    expectedRevision: string;
  }): Promise<TasteMemoryCueReadResult> {
    if (input.ownerUserId !== this.ownerUserId || !input.anchor.startsWith('taste-dimensions:')) {
      return { status: 'not_available', invalidationReason: 'source_forgotten' };
    }
    const dimensions = [...new Set(input.anchor.slice('taste-dimensions:'.length).split(',').filter(Boolean))].sort();
    if (dimensions.length === 0 || dimensions.length > 6 || dimensions.some((value) => !KNOWN_DIMENSIONS.has(value))) {
      return { status: 'not_available', invalidationReason: 'source_forgotten' };
    }
    const snapshot = this.snapshot(input.ownerUserId, dimensions);
    if (!snapshot) return { status: 'not_available', invalidationReason: 'source_forgotten' };
    if (snapshot.revision !== input.expectedRevision) {
      return { status: 'not_available', invalidationReason: 'source_corrected' };
    }
    return {
      status: 'ok',
      payload: {
        dimensions: snapshot.dimensions,
        totalCount: snapshot.totalCount,
        vignettes: snapshot.results,
      },
    };
  }

  private snapshot(ownerUserId: string, requestedDimensions: readonly string[]): TasteSnapshot | null {
    const dimensions = [...new Set(requestedDimensions)].sort();
    const all = listSourcePaths(this.repository.canonicalRoot())
      .sort()
      .flatMap((sourcePath) => {
        const result = this.reader.read({ ownerUserId, sourcePath });
        return result?.payload.dimension && dimensions.includes(result.payload.dimension) ? [result] : [];
      });
    if (all.length === 0) return null;
    const availableDimensions = dimensions.filter((dimension) =>
      all.some((result) => result.payload.dimension === dimension),
    );
    const revision = `sha256:${createHash('sha256')
      .update(
        JSON.stringify({
          v: TASTE_MAP_VERSION,
          dimensions: availableDimensions,
          sources: all.map((result) => [result.sourcePath, result.revision]),
        }),
      )
      .digest('hex')}`;
    return {
      dimensions: availableDimensions,
      revision,
      visibility: all.some((result) => result.visibility === 'private') ? 'owner_private' : 'owner_public',
      results: boundedResults(all, availableDimensions),
      totalCount: all.length,
    };
  }
}
