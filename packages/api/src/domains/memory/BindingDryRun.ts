import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { SecretFinding } from './SecretScanner.js';
import { SecretScanner } from './SecretScanner.js';

const AUTO_EXCLUDE_DIRS = new Set([
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
]);

export interface DryRunReport {
  root: string;
  totalFiles: number;
  markdownFiles: number;
  excludedDirs: number;
  excludedFiles: number;
  authorityHits: Record<string, number>;
  secretFindings: number;
  secretDetails: SecretFinding[];
  safe: boolean;
}

export class BindingDryRun {
  static run(root: string, options?: { exclude?: unknown; authorityCeiling?: string }): DryRunReport {
    const rawExclude = options?.exclude;
    if (rawExclude !== undefined) {
      if (!Array.isArray(rawExclude) || !rawExclude.every((e) => typeof e === 'string')) {
        throw new Error('exclude must be a string array');
      }
    }
    const exclude: string[] = (rawExclude as string[] | undefined) ?? [];
    const authorityCeiling = options?.authorityCeiling ?? 'validated';
    let totalFiles = 0;
    let markdownFiles = 0;
    let excludedDirs = 0;
    let excludedFiles = 0;
    const mdFiles: Array<{ path: string; content: string }> = [];

    const walk = (dir: string, depth: number) => {
      if (depth > 10) return;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry);
        try {
          const stat = lstatSync(full);
          if (stat.isSymbolicLink()) continue;
          if (stat.isDirectory()) {
            if (AUTO_EXCLUDE_DIRS.has(entry)) {
              excludedDirs++;
              continue;
            }
            const rel = relative(root, full);
            if (isExcluded(rel, exclude)) {
              excludedDirs++;
              continue;
            }
            walk(full, depth + 1);
          } else if (stat.isFile()) {
            const rel = relative(root, full);
            if (isExcluded(rel, exclude)) {
              excludedFiles++;
              continue;
            }
            totalFiles++;
            if (entry.endsWith('.md')) {
              markdownFiles++;
              const content = readFileSync(full, 'utf-8');
              mdFiles.push({ path: rel, content });
            }
          }
        } catch {
          /* skip inaccessible */
        }
      }
    };

    walk(root, 0);
    const { findings } = SecretScanner.scanBatch(mdFiles);

    return {
      root,
      totalFiles,
      markdownFiles,
      excludedDirs,
      excludedFiles,
      authorityHits: markdownFiles > 0 ? { [authorityCeiling]: markdownFiles } : {},
      secretFindings: findings.length,
      secretDetails: findings,
      safe: findings.length === 0,
    };
  }
}

function isExcluded(relPath: string, patterns: string[]): boolean {
  if (!patterns.length) return false;
  return patterns.some((p) => matchGlob(p, relPath));
}

function matchGlob(pattern: string, path: string): boolean {
  const regex = pattern
    .replace(/\*\*\//g, '§GS§')
    .replace(/\*\*/g, '§G§')
    .replace(/\*/g, '§S§')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/§GS§/g, '(.+/)?')
    .replace(/§G§/g, '.*')
    .replace(/§S§/g, '[^/]*');
  return new RegExp(`^${regex}$`).test(path);
}
