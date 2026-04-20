import { access, readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

export type EvidenceSourceType =
  | 'decision'
  | 'phase'
  | 'feature'
  | 'lesson'
  | 'research'
  | 'knowledge'
  | 'discussion'
  | 'commit';
export type EvidenceConfidence = 'high' | 'mid' | 'low';
export type EvidenceStatus = 'draft' | 'pending' | 'published' | 'archived';

export interface EvidenceResult {
  title: string;
  anchor: string;
  snippet: string;
  confidence: EvidenceConfidence;
  sourceType: EvidenceSourceType;
  /** F102 Batch 3: knowledge dimension origin — project or global */
  source?: 'project' | 'global';
  status?: EvidenceStatus;
  /** F163: boost source attribution — what F163 mechanisms affected this result's ranking */
  boostSource: BoostSource[];
  /** AC-I9: passage-level detail when depth=raw */
  passages?: Array<{
    passageId: string;
    content: string;
    speaker?: string;
    createdAt?: string;
    context?: Array<{
      passageId: string;
      content: string;
      speaker?: string;
      createdAt?: string;
    }>;
  }>;
}

/** F163: Boost source attribution (search-path reranking, not injection) */
export type BoostSource = 'authority_boost' | 'retrieval_rerank' | 'compression_summary' | 'legacy';

export function normalizeTags(input: string | string[] | undefined, defaultOrigin = 'origin:git'): string[] {
  const defaults = ['project:cat-cafe', defaultOrigin];
  if (input == null) return defaults;

  const tags = (Array.isArray(input) ? input : [input])
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (tags.length === 0) return defaults;

  // project:cat-cafe is always present (P0 governance constraint)
  if (!tags.includes('project:cat-cafe')) {
    tags.unshift('project:cat-cafe');
  }

  return tags;
}

export function shouldDegradeToDocs(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return (
      msg.includes('econnrefused') ||
      msg.includes('etimedout') ||
      msg.includes('timeout') ||
      msg.includes('aborted') ||
      msg.includes('network') ||
      msg.includes('fetch failed')
    );
  }

  return false;
}

/** Map an EvidenceKind (from index) to a display source type */
export function mapKindToSourceType(kind: string): EvidenceSourceType {
  switch (kind) {
    case 'decision':
      return 'decision';
    case 'plan':
      return 'phase';
    case 'feature':
      return 'feature';
    case 'lesson':
      return 'lesson';
    case 'research':
      return 'research';
    case 'pack-knowledge':
      return 'knowledge';
    case 'session':
    case 'thread':
    case 'discussion':
      return 'discussion';
    default:
      return 'commit';
  }
}

/** Map a file path to a source type */
export function classifySource(path: string): EvidenceSourceType {
  if (path.includes('decisions')) return 'decision';
  if (path.includes('phases')) return 'phase';
  if (path.includes('features')) return 'feature';
  if (
    path.includes('lessons') ||
    path.includes('reflections') ||
    path.includes('postmortems') ||
    path.includes('episodes')
  )
    return 'lesson';
  if (path.includes('research')) return 'research';
  if (path.includes('discussions')) return 'discussion';
  return 'commit';
}

/** Degraded search: grep docs/ for matching files */
export async function searchDocs(docsRoot: string, query: string, limit: number): Promise<EvidenceResult[]> {
  const results: EvidenceResult[] = [];
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return results;

  const dirs = ['decisions', 'phases', 'discussions'];
  for (const dir of dirs) {
    let files: string[];
    try {
      files = await readdir(join(docsRoot, dir));
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      if (results.length >= limit) break;

      const fullPath = join(docsRoot, dir, file);
      let content: string;
      try {
        content = await readFile(fullPath, 'utf-8');
      } catch {
        continue;
      }

      const lower = content.toLowerCase();
      const matched = terms.some((term) => lower.includes(term));
      if (!matched) continue;

      const relPath = `docs/${dir}/${file}`;
      const firstLine =
        content
          .split('\n')
          .find((line) => line.trim().startsWith('#'))
          ?.replace(/^#+\s*/, '') ?? file;
      const snippet = content.slice(0, 300);

      results.push({
        title: firstLine,
        anchor: relPath,
        snippet,
        confidence: 'low',
        sourceType: classifySource(relative('', relPath)),
        boostSource: ['legacy'],
      });
    }

    if (results.length >= limit) break;
  }

  return results.slice(0, limit);
}

/**
 * Validate anchors: downgrade confidence to 'low' if a docs/ file is missing.
 * Does not remove results — just reduces trust signal.
 */
export async function validateAnchors(results: EvidenceResult[], docsRoot: string): Promise<EvidenceResult[]> {
  const docsRootAbs = resolve(docsRoot);

  return Promise.all(
    results.map(async (result) => {
      if (!result.anchor.startsWith('docs/')) return result;
      const [anchorPath = ''] = result.anchor.split('#');
      const relativePath = anchorPath.slice('docs/'.length).replace(/^\/+/, '');
      const filePath = resolve(docsRootAbs, relativePath);
      const relativeToDocs = relative(docsRootAbs, filePath);

      if (!relativePath || relativeToDocs.startsWith('..') || isAbsolute(relativeToDocs)) {
        return { ...result, confidence: 'low' as EvidenceConfidence };
      }

      try {
        await access(filePath);
        return result;
      } catch {
        return { ...result, confidence: 'low' as EvidenceConfidence };
      }
    }),
  );
}
