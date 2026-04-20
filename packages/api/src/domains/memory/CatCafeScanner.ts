// F152 Phase A: CatCafeScanner — extracted from IndexBuilder (KD-5)
// Scans cat-cafe docs/ structure: KIND_DIRS + archive + top-level .md + fallback

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { EvidenceKind, RepoScanner, ScannedEvidence } from './interfaces.js';

export const KIND_DIRS: Record<string, EvidenceKind> = {
  features: 'feature',
  decisions: 'decision',
  plans: 'plan',
  lessons: 'lesson',
  discussions: 'discussion',
  research: 'research',
  phases: 'plan',
  reflections: 'lesson',
  methods: 'lesson',
  episodes: 'lesson',
  postmortems: 'lesson',
  guides: 'plan',
  stories: 'lesson',
};

export class CatCafeScanner implements RepoScanner {
  discover(projectRoot: string): ScannedEvidence[] {
    const results: ScannedEvidence[] = [];

    // E8: Split lessons-learned.md into per-lesson entries
    for (const item of splitLessonsLearned(projectRoot)) {
      results.push({
        item,
        provenance: { tier: 'authoritative', source: 'lessons-learned.md' },
        rawContent: '',
      });
    }

    // Discover all .md files
    for (const file of discoverFiles(projectRoot)) {
      const evidence = this.parseFileToEvidence(file.path, projectRoot);
      if (evidence) results.push(evidence);
    }

    return results;
  }

  /** Parse a single file — used by IndexBuilder.incrementalUpdate() */
  parseSingle(filePath: string, projectRoot: string): ScannedEvidence | null {
    return this.parseFileToEvidence(filePath, projectRoot);
  }

  private parseFileToEvidence(filePath: string, projectRoot: string): ScannedEvidence | null {
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }

    const frontmatter = extractFrontmatter(content);
    const anchor =
      (frontmatter ? extractAnchor(frontmatter) : null) ??
      `doc:${relative(projectRoot, filePath).replace(/\.md$/, '')}`;

    const kind = frontmatter ? inferKind(frontmatter, filePath) : inferKindFromPath(filePath);
    const title = extractTitle(content);
    const summary = extractSummary(content);
    const status = (frontmatter && typeof frontmatter.status === 'string' ? frontmatter.status : 'active') as
      | 'active'
      | 'done'
      | 'archived';

    const topics = frontmatter?.topics;
    const sectionKeywords = extractSectionKeywords(content);
    const keywords = mergeKeywords(Array.isArray(topics) ? (topics as string[]) : [], sectionKeywords);
    const sourcePath = relative(projectRoot, filePath);

    return {
      item: {
        anchor,
        kind,
        status,
        title: title ?? anchor,
        updatedAt: new Date().toISOString(),
        sourcePath,
        ...(summary ? { summary } : {}),
        ...(keywords.length > 0 ? { keywords } : {}),
      },
      provenance: { tier: 'authoritative', source: sourcePath },
      rawContent: content,
    };
  }
}

// ── File discovery ──────────────────────────────────────────────────

function discoverFiles(docsRoot: string): Array<{ path: string; kind: EvidenceKind }> {
  const results: Array<{ path: string; kind: EvidenceKind }> = [];
  const discoveredPaths = new Set<string>();

  const scanDir = (dirPath: string, kind: EvidenceKind, depth = 0) => {
    if (depth > 10) return;
    try {
      for (const entry of readdirSync(dirPath)) {
        const fullPath = join(dirPath, entry);
        try {
          const lst = lstatSync(fullPath);
          if (lst.isSymbolicLink()) continue;
          if (lst.isFile() && entry.endsWith('.md')) {
            results.push({ path: fullPath, kind });
            discoveredPaths.add(fullPath);
          } else if (lst.isDirectory()) {
            scanDir(fullPath, kind, depth + 1);
          }
        } catch {
          // skip inaccessible entries
        }
      }
    } catch {
      // Directory doesn't exist — skip
    }
  };

  // Primary KIND_DIRS scan
  for (const [dir, kind] of Object.entries(KIND_DIRS)) {
    scanDir(join(docsRoot, dir), kind);
  }

  // Archive directories
  const archiveRoot = join(docsRoot, 'archive');
  try {
    for (const dateDir of readdirSync(archiveRoot)) {
      const datePath = join(archiveRoot, dateDir);
      try {
        if (!statSync(datePath).isDirectory()) continue;
        for (const [dir, kind] of Object.entries(KIND_DIRS)) {
          scanDir(join(datePath, dir), kind);
        }
      } catch {
        // skip
      }
    }
  } catch {
    // archive doesn't exist — skip
  }

  // Top-level .md files
  try {
    for (const entry of readdirSync(docsRoot)) {
      if (!entry.endsWith('.md')) continue;
      const fullPath = join(docsRoot, entry);
      try {
        if (statSync(fullPath).isFile()) {
          results.push({ path: fullPath, kind: 'plan' as EvidenceKind });
          discoveredPaths.add(fullPath);
        }
      } catch {
        // skip
      }
    }
  } catch {
    // skip
  }

  // Fallback: non-standard directories
  const FALLBACK_EXCLUDE = new Set(['node_modules', '.git', 'archive', 'mailbox', ...Object.keys(KIND_DIRS)]);
  const scanFallback = (dirPath: string, depth = 0) => {
    if (depth > 10) return;
    try {
      for (const entry of readdirSync(dirPath)) {
        if (FALLBACK_EXCLUDE.has(entry)) continue;
        const fullPath = join(dirPath, entry);
        try {
          const lst = lstatSync(fullPath);
          if (lst.isSymbolicLink()) continue;
          if (lst.isFile() && entry.endsWith('.md') && !discoveredPaths.has(fullPath)) {
            results.push({ path: fullPath, kind: inferKindFromPath(fullPath) });
          } else if (lst.isDirectory()) {
            scanFallback(fullPath, depth + 1);
          }
        } catch {
          // skip
        }
      }
    } catch {
      // skip
    }
  };
  scanFallback(docsRoot);

  return results;
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

// ── Frontmatter parsing ─────────────────────────────────────────────

export function extractFrontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match?.[1]) return null;

  const yaml = match[1];
  const result: Record<string, unknown> = {};

  for (const line of yaml.split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1]!;
    const rawVal = kv[2]!;
    const arrMatch = rawVal.match(/^\[(.+)]$/);
    if (arrMatch) {
      result[key] = arrMatch[1]?.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
    } else {
      result[key] = rawVal.trim();
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

export function extractAnchor(fm: Record<string, unknown>): string | null {
  const anchor = fm.anchor;
  if (typeof anchor === 'string') return anchor;
  const featureIds = fm.feature_ids;
  if (Array.isArray(featureIds) && featureIds.length > 0) return featureIds[0] as string;
  const decisionId = fm.decision_id;
  if (typeof decisionId === 'string') return decisionId;
  const planId = fm.plan_id;
  if (typeof planId === 'string') return planId;
  return null;
}

function inferKind(fm: Record<string, unknown>, filePath: string): EvidenceKind {
  const docKind = fm.doc_kind;
  if (docKind === 'decision' || filePath.includes('/decisions/')) return 'decision';
  if (
    docKind === 'plan' ||
    filePath.includes('/plans/') ||
    filePath.includes('/phases/') ||
    filePath.includes('/guides/')
  )
    return 'plan';
  if (
    docKind === 'lesson' ||
    filePath.includes('/lessons/') ||
    filePath.includes('/reflections/') ||
    filePath.includes('/postmortems/') ||
    filePath.includes('/stories/')
  )
    return 'lesson';
  if (docKind === 'discussion' || filePath.includes('/discussions/')) return 'discussion';
  if (docKind === 'research' || filePath.includes('/research/')) return 'research';
  if (docKind === 'spec' || filePath.includes('/features/')) return 'feature';
  return 'plan';
}

export function inferKindFromPath(filePath: string): EvidenceKind {
  for (const [dir, kind] of Object.entries(KIND_DIRS)) {
    if (filePath.includes(`/${dir}/`)) return kind;
  }
  return 'plan';
}

function extractTitle(content: string): string | null {
  const match = content.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() ?? null;
}

function extractSummary(content: string): string | null {
  const afterTitle = content.replace(/^---[\s\S]*?---\s*/, '').replace(/^#.*$/m, '');
  const paragraphs = afterTitle.split(/\n\n+/).filter((p) => {
    const t = p.trim();
    if (!t) return false;
    if (t.startsWith('#') || t.startsWith('>') || t.startsWith('|') || t.startsWith('```')) return false;
    return true;
  });
  const first = paragraphs[0];
  if (!first) return null;
  const trimmed = first.trim().replace(/\n/g, ' ');
  return trimmed.length > 300 ? `${trimmed.slice(0, 297)}...` : trimmed;
}

function extractSectionKeywords(content: string): string[] {
  const keywords: string[] = [];
  let activeFence: { char: '`' | '~'; length: number } | null = null;

  for (const line of content.split(/\r?\n/)) {
    const fenceMatch = line.match(/^\s{0,3}([`~]{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      const suffix = line.slice(fenceMatch[0].length);
      const char = marker[0] as '`' | '~';
      const length = marker.length;
      if (activeFence == null) {
        activeFence = { char, length };
        continue;
      }
      if (activeFence.char === char && length >= activeFence.length && suffix.trim() === '') {
        activeFence = null;
        continue;
      }
    }

    if (activeFence != null) continue;

    const heading = line.match(/^##+\s+(.+)$/)?.[1]?.trim();
    if (!heading) continue;
    if (heading.length > 80) continue;
    keywords.push(heading);
  }
  return keywords;
}

function mergeKeywords(primary: string[], secondary: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const raw of [...primary, ...secondary]) {
    const value = raw.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(value);
  }
  return merged;
}
