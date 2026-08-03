// F152 Phase A: CatCafeScanner — extracted from IndexBuilder (KD-5)
// Scans cat-cafe docs/ structure: KIND_DIRS + archive + top-level .md + fallback

import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  discoverFiles,
  GENERATED_DOC_DIRS,
  inferKindFromPath,
  KIND_DIRS,
} from '@cat-cafe/shared/scanner-discovery-pure';
import {
  extractAnchor,
  extractEvidenceStatus,
  extractFeatureIdKeywords,
  extractFrontmatter,
  extractSectionKeywords,
  extractSummary,
  extractSupersededBy,
  extractTitle,
  inferKind,
  isPublicTasteVignettePath,
  mergeKeywords,
  parseSvgAssetToEvidence,
} from './CatCafeScannerParsing.js';
import type { RepoScanner, ScannedEvidence } from './interfaces.js';
import { buildMarkdownDocumentPassages } from './MarkdownPassageIndexer.js';
import {
  buildTasteDecisionPassage,
  parseApprovedTasteVignette,
  type TasteDecisionPayload,
} from './taste/TasteMemoryReader.js';

export { KIND_DIRS };
export {
  extractAnchor,
  extractEvidenceStatus,
  extractFeatureIdKeywords,
  extractFrontmatter,
  extractSupersededBy,
  extractSupersedes,
  isFeatureDocPath,
} from './CatCafeScannerParsing.js';

export class CatCafeScanner implements RepoScanner {
  private exclude?: string[];
  constructor(exclude?: string[]) {
    this.exclude = exclude;
  }

  addExcludePatterns(patterns: string[]): void {
    this.exclude = [...(this.exclude ?? []), ...patterns];
  }

  discover(projectRoot: string): ScannedEvidence[] {
    const results: ScannedEvidence[] = [];

    // E8: Split lessons-learned.md into per-lesson entries
    for (const item of splitLessonsLearned(projectRoot)) {
      results.push({
        item,
        provenance: { tier: 'authoritative', source: 'lessons-learned.md' },
        rawContent: '',
        passages: [],
      });
    }

    // Discover all .md files, filtering out excluded child collection paths (AC-H1)
    for (const file of discoverFiles(projectRoot)) {
      if (this.isExcluded(file.path, projectRoot)) continue;
      const evidence = this.parseFileToEvidence(file.path, projectRoot);
      if (evidence) results.push(evidence);
    }

    return results;
  }

  private isExcluded(filePath: string, projectRoot: string): boolean {
    const rel = relative(projectRoot, filePath);
    if (rel.split(/[\\/]+/).some((segment) => GENERATED_DOC_DIRS.has(segment))) return true;
    if (!this.exclude?.length) return false;
    return this.exclude.some((pattern) => matchGlob(pattern, rel));
  }

  /** Parse a single file — used by IndexBuilder.incrementalUpdate() */
  parseSingle(filePath: string, projectRoot: string): ScannedEvidence | null {
    if (this.isExcluded(filePath, projectRoot)) return null;
    return this.parseFileToEvidence(filePath, projectRoot);
  }

  private parseFileToEvidence(filePath: string, projectRoot: string): ScannedEvidence | null {
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }

    if (filePath.endsWith('.svg')) {
      return parseSvgAssetToEvidence(filePath, projectRoot, content);
    }

    const frontmatter = extractFrontmatter(content);
    const sourcePath = relative(projectRoot, filePath);
    const tasteMaterialization = materializePublicTasteVignette(sourcePath, content);
    if (tasteMaterialization === null) return null;
    const anchor =
      (frontmatter ? extractAnchor(frontmatter, sourcePath) : null) ?? `doc:${sourcePath.replace(/\.md$/, '')}`;

    const kind = frontmatter ? inferKind(frontmatter, filePath) : inferKindFromPath(filePath);
    const title = tasteMaterialization?.title ?? extractTitle(content);
    const summary = tasteMaterialization?.summary ?? extractSummary(content);
    const status = extractEvidenceStatus(frontmatter);
    const supersededBy = extractSupersededBy(frontmatter);

    const topics = frontmatter?.topics;
    const sectionKeywords = extractSectionKeywords(content);
    const featureIdKeywords = extractFeatureIdKeywords(frontmatter, sourcePath);
    const keywords = mergeKeywords(
      [...(Array.isArray(topics) ? (topics as string[]) : []), ...featureIdKeywords],
      sectionKeywords,
    );
    const materializedKeywords = mergeKeywords([...keywords, ...(tasteMaterialization?.keywords ?? [])], []);

    return {
      item: {
        anchor,
        kind,
        status,
        title: title ?? anchor,
        updatedAt: new Date().toISOString(),
        sourcePath,
        ...(summary ? { summary } : {}),
        ...(materializedKeywords.length > 0 ? { keywords: materializedKeywords } : {}),
        ...(supersededBy ? { supersededBy } : {}),
      },
      provenance: { tier: 'authoritative', source: sourcePath },
      rawContent: content,
      passages: tasteMaterialization?.passages ?? buildMarkdownDocumentPassages(content),
    };
  }
}

interface TasteEvidenceMaterialization {
  title: string;
  summary: string;
  keywords: string[];
  passages: string[];
}

function materializePublicTasteVignette(
  sourcePath: string,
  content: string,
): TasteEvidenceMaterialization | null | undefined {
  if (!isPublicTasteVignettePath(sourcePath)) return undefined;
  const payload = parseApprovedTasteVignette(content, 'public');
  if (!payload) return null;
  return {
    title: `Taste vignette: ${payload.tags[0] ?? sourcePath}`,
    summary: truncateSummary(payload.scene),
    keywords: tasteEvidenceKeywords(payload),
    passages: [buildTasteDecisionPassage(payload)],
  };
}

function tasteEvidenceKeywords(payload: TasteDecisionPayload): string[] {
  return [...payload.tags, ...(payload.dimension ? [payload.dimension] : [])];
}

function truncateSummary(scene: string): string {
  return scene.length > 300 ? `${scene.slice(0, 297)}...` : scene;
}

// ── Lessons-learned splitter ────────────────────────────────────────

function splitLessonsLearned(docsRoot: string) {
  const filePath = join(docsRoot, 'lessons-learned.md');
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  type LessonItem = ScannedEvidence['item'];
  const results: LessonItem[] = [];
  const sections = content.split(/^### /m).slice(1);

  for (const section of sections) {
    const titleMatch = section.match(/^(LL-\d+):\s*(.+)/);
    if (!titleMatch) continue;

    const llId = titleMatch[1];
    const title = `${llId}: ${titleMatch[2].trim()}`;
    const body = section.slice(section.indexOf('\n') + 1).trim();
    const summary = body.length > 300 ? `${body.slice(0, 297)}...` : body;
    const keywords: string[] = [];
    const kwMatch = body.match(/关联：(.+)/);
    if (kwMatch) {
      keywords.push(
        ...kwMatch[1]
          .split(/[|,]/)
          .map((s) => s.trim())
          .filter(Boolean),
      );
    }

    results.push({
      anchor: llId,
      kind: 'lesson',
      status: 'active',
      title,
      summary,
      keywords: keywords.length > 0 ? keywords : undefined,
      sourcePath: 'lessons-learned.md',
      updatedAt: new Date().toISOString(),
    });
  }
  return results;
}

function matchGlob(pattern: string, path: string): boolean {
  const regex = pattern
    .replace(/\*\*\//g, '§GLOBSTAR_SLASH§')
    .replace(/\*\*/g, '§GLOBSTAR§')
    .replace(/\*/g, '§STAR§')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/§GLOBSTAR_SLASH§/g, '(.+/)?')
    .replace(/§GLOBSTAR§/g, '.*')
    .replace(/§STAR§/g, '[^/]*');
  return new RegExp(`^${regex}$`).test(path);
}
