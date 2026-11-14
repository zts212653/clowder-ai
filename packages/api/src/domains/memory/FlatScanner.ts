// F186 Phase B: Level 0 scanner — indexes any markdown directory without structure assumptions

import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { matchGlob } from './CatCafeScanner.js';
import type { RepoScanner, ScannedEvidence } from './interfaces.js';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '__pycache__',
  '.tox',
  'target',
  'vendor',
  '.claude',
  '.obsidian',
  '.worktrees',
  '.vscode',
  '.idea',
  'coverage',
  '.cache',
  '.turbo',
  'tmp',
  '.tmp',
  '.output',
  'venv',
  '.venv',
  'env',
  '.env',
]);

const MAX_DEPTH = 10;

export class FlatScanner implements RepoScanner {
  constructor(
    protected readonly collectionId: string,
    protected readonly exclude?: string[],
  ) {}

  discover(root: string): ScannedEvidence[] {
    const results: ScannedEvidence[] = [];
    this.walkDir(root, root, results, 0);
    return results;
  }

  parseSingle(filePath: string, root: string): ScannedEvidence | null {
    const boundRoot = resolve(root);
    const file = resolve(filePath);
    const rel = relative(boundRoot, file);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
    try {
      // Match walkDir: neither a linked file nor a linked ancestor belongs to this scan.
      if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) return null;
      for (let dir = dirname(file); relative(boundRoot, dir) !== ''; dir = dirname(dir)) {
        if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return null;
        if (isGitRepositoryRoot(dir)) return null;
      }
    } catch {
      // Stale or unreadable paths must not abort the remaining incremental batch.
      return null;
    }
    return this.parseFile(filePath, root);
  }

  protected walkDir(dir: string, root: string, results: ScannedEvidence[], depth: number): void {
    if (depth > MAX_DEPTH) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      try {
        const stat = lstatSync(fullPath);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
          if (SKIP_DIRS.has(entry)) continue;
          if (this.isExcluded(relative(root, fullPath))) continue;
          // Nested repositories own separate collections. The explicitly bound root is still scanned.
          if (isGitRepositoryRoot(fullPath)) continue;
          this.walkDir(fullPath, root, results, depth + 1);
        } else if (stat.isFile() && entry.endsWith('.md')) {
          if (this.isExcluded(relative(root, fullPath))) continue;
          const evidence = this.parseFile(fullPath, root);
          if (evidence) results.push(evidence);
        }
      } catch {
        /* skip inaccessible */
      }
    }
  }

  protected parseFile(filePath: string, root: string): ScannedEvidence | null {
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }

    const rel = relative(root, filePath);
    const stem = basename(filePath, '.md');
    const anchor = `${this.collectionId}:doc/${rel.replace(/\.md$/, '')}`;
    const title = extractTitle(content) ?? stem;
    const summary = extractSummary(content);
    const keywords = extractSectionKeywords(content);

    return {
      item: {
        anchor,
        kind: 'research',
        status: 'active',
        title,
        sourcePath: rel,
        updatedAt: new Date().toISOString(),
        ...(summary ? { summary } : {}),
        ...(keywords.length > 0 ? { keywords } : {}),
      },
      provenance: { tier: 'derived', source: rel },
      rawContent: content,
      passages: [],
    };
  }

  private isExcluded(relPath: string): boolean {
    if (!this.exclude?.length) return false;
    return this.exclude.some((pattern) => matchGlob(pattern, relPath));
  }
}

function isGitRepositoryRoot(dir: string): boolean {
  const gitPath = join(dir, '.git');
  const stat = lstatSync(gitPath, { throwIfNoEntry: false });
  if (stat?.isDirectory()) return true;
  // A symlink or an arbitrary file named .git is not proof of a repository boundary.
  if (!stat?.isFile()) return false;
  const marker = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(readFileSync(gitPath, 'utf-8'));
  return Boolean(marker?.[1].trim());
}

function extractTitle(content: string): string | null {
  return content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null;
}

function extractSummary(content: string): string | null {
  const afterTitle = content.replace(/^---[\s\S]*?---\s*/, '').replace(/^#.*$/m, '');
  const paragraphs = afterTitle.split(/\n\n+/).filter((p) => {
    const t = p.trim();
    return t && !t.startsWith('#') && !t.startsWith('>') && !t.startsWith('|') && !t.startsWith('```');
  });
  const first = paragraphs[0]?.trim().replace(/\n/g, ' ');
  if (!first) return null;
  return first.length > 300 ? `${first.slice(0, 297)}...` : first;
}

function extractSectionKeywords(content: string): string[] {
  const keywords: string[] = [];
  let inFence = false;
  for (const line of content.split(/\r?\n/)) {
    if (/^\s{0,3}[`~]{3,}/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = line.match(/^##+\s+(.+)$/)?.[1]?.trim();
    if (heading && heading.length <= 80) keywords.push(heading);
  }
  return keywords;
}
