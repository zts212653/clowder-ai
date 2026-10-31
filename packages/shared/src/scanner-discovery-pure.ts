import { lstatSync, readdirSync, type Stats, statSync } from 'node:fs';
import { join } from 'node:path';

export type ScannerEvidenceKind =
  | 'feature'
  | 'decision'
  | 'plan'
  | 'lesson'
  | 'discussion'
  | 'research'
  | 'architecture';

export interface DiscoveredScannerFile {
  path: string;
  kind: ScannerEvidenceKind;
}

export const KIND_DIRS: Record<string, ScannerEvidenceKind> = {
  features: 'feature',
  decisions: 'decision',
  architecture: 'architecture',
  plans: 'plan',
  lessons: 'lesson',
  discussions: 'discussion',
  research: 'research',
  study: 'research',
  'competitor-research': 'research',
  phases: 'plan',
  reflections: 'lesson',
  methods: 'lesson',
  episodes: 'lesson',
  postmortems: 'lesson',
  guides: 'plan',
  stories: 'lesson',
  'harness-feedback': 'lesson',
};

export const GENERATED_DOC_DIRS: ReadonlySet<string> = new Set(['exported-threads']);
const MAX_SCAN_DEPTH = 10;

export function discoverFiles(docsRoot: string): DiscoveredScannerFile[] {
  const results: DiscoveredScannerFile[] = [];
  const discoveredPaths = new Set<string>();

  for (const [dir, kind] of Object.entries(KIND_DIRS)) {
    scanKindDir(join(docsRoot, dir), kind, results, discoveredPaths);
  }

  scanArchiveDirs(join(docsRoot, 'archive'), results, discoveredPaths);
  scanTopLevelMarkdownFiles(docsRoot, results, discoveredPaths);
  scanFallbackDir(docsRoot, results, discoveredPaths);

  return results;
}

function scanKindDir(
  dirPath: string,
  kind: ScannerEvidenceKind,
  results: DiscoveredScannerFile[],
  discoveredPaths: Set<string>,
  depth = 0,
): void {
  if (depth > MAX_SCAN_DEPTH) return;

  for (const entry of safeReadDir(dirPath)) {
    const fullPath = join(dirPath, entry);
    const lst = safeLstat(fullPath);
    if (!lst) continue;

    if (lst.isFile() && isIndexableSourceFile(entry)) {
      results.push({ path: fullPath, kind });
      discoveredPaths.add(fullPath);
      continue;
    }

    if (lst.isDirectory() && !GENERATED_DOC_DIRS.has(entry)) {
      scanKindDir(fullPath, kind, results, discoveredPaths, depth + 1);
    }
  }
}

function scanArchiveDirs(archiveRoot: string, results: DiscoveredScannerFile[], discoveredPaths: Set<string>): void {
  for (const dateDir of safeReadDir(archiveRoot)) {
    const datePath = join(archiveRoot, dateDir);
    if (!safeIsDirectory(datePath)) continue;

    for (const [dir, kind] of Object.entries(KIND_DIRS)) {
      scanKindDir(join(datePath, dir), kind, results, discoveredPaths);
    }
  }
}

function scanTopLevelMarkdownFiles(
  docsRoot: string,
  results: DiscoveredScannerFile[],
  discoveredPaths: Set<string>,
): void {
  for (const entry of safeReadDir(docsRoot)) {
    if (!entry.endsWith('.md')) continue;
    const fullPath = join(docsRoot, entry);
    if (!safeIsFile(fullPath)) continue;

    results.push({ path: fullPath, kind: 'plan' });
    discoveredPaths.add(fullPath);
  }
}

function scanFallbackDir(
  dirPath: string,
  results: DiscoveredScannerFile[],
  discoveredPaths: Set<string>,
  depth = 0,
): void {
  if (depth > MAX_SCAN_DEPTH) return;

  const fallbackExclude = new Set(['node_modules', '.git', 'archive', 'mailbox', ...Object.keys(KIND_DIRS)]);
  for (const entry of safeReadDir(dirPath)) {
    if (fallbackExclude.has(entry) || GENERATED_DOC_DIRS.has(entry)) continue;
    const fullPath = join(dirPath, entry);
    const lst = safeLstat(fullPath);
    if (!lst) continue;

    if (lst.isFile() && isIndexableSourceFile(entry) && !discoveredPaths.has(fullPath)) {
      results.push({ path: fullPath, kind: inferKindFromPath(fullPath) });
      continue;
    }

    if (lst.isDirectory()) {
      scanFallbackDir(fullPath, results, discoveredPaths, depth + 1);
    }
  }
}

function safeReadDir(dirPath: string): string[] {
  try {
    return readdirSync(dirPath);
  } catch {
    return [];
  }
}

function safeLstat(path: string): Stats | null {
  try {
    const lst = lstatSync(path);
    return lst.isSymbolicLink() ? null : lst;
  } catch {
    return null;
  }
}

function safeIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function safeIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function isIndexableSourceFile(filename: string): boolean {
  return filename.endsWith('.md') || filename.endsWith('.svg');
}

export function inferKindFromPath(filePath: string): ScannerEvidenceKind {
  for (const [dir, kind] of Object.entries(KIND_DIRS)) {
    if (filePath.includes(`/${dir}/`)) return kind;
  }
  return 'plan';
}
