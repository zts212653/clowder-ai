// F186 Phase B: Level 0 scanner — indexes any markdown directory without structure assumptions

import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type { RepoScanner, ScannedEvidence } from './interfaces.js';
import { toPosixPath } from './path-utils.js';

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
          if (this.isExcluded(toPosixPath(relative(root, fullPath)))) continue;
          // A nested repository (`.git` directory, or a worktree/submodule-style `gitdir:` file) owns
          // its own collection; descending into it would duplicate its documents into this one.
          // Existence of a `.git` name alone is not proof of that boundary — a stray file (or a
          // symlink to arbitrary content) used to drop the whole subtree silently. A plain
          // `worktrees/` directory holds ordinary documents and must still be indexed.
          if (isGitRepositoryRoot(fullPath)) continue;
          this.walkDir(fullPath, root, results, depth + 1);
        } else if (stat.isFile() && entry.endsWith('.md')) {
          if (this.isExcluded(toPosixPath(relative(root, fullPath)))) continue;
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

    const rel = toPosixPath(relative(root, filePath));
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

/**
 * True when `dirPath` is a real repository boundary: `.git` as a directory, or `.git` as a *file*
 * whose content is a worktree/submodule `gitdir:` marker. Mere existence of the `.git` name is not
 * proof — treating a stray file (or a symlink to arbitrary content) as a boundary silently dropped
 * the whole subtree from the index.
 */
function isGitRepositoryRoot(dirPath: string): boolean {
  const gitPath = join(dirPath, '.git');
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(gitPath);
  } catch {
    return false;
  }
  if (stat.isDirectory()) return true;
  if (!stat.isFile()) return false;
  try {
    return /^\s*gitdir:\s*\S+/m.test(readFileSync(gitPath, 'utf-8').slice(0, 512));
  } catch {
    return false;
  }
}

export function matchGlob(pattern: string, path: string): boolean {
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
