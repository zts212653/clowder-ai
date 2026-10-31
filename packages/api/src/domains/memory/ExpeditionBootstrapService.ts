import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type { IndexStateManager } from './IndexStateManager.js';

export interface ProjectSummary {
  projectName: string;
  techStack: string[];
  dirStructure: string[];
  coreModules: string[];
  docsList: Array<{ path: string; tier: 'authoritative' | 'derived' | 'soft_clue' }>;
  tierCoverage: Record<string, number>;
  kindCoverage: Record<string, number>;
}

export interface BootstrapProgress {
  phase: 'scanning' | 'extracting' | 'indexing' | 'summarizing';
  phaseIndex: number;
  totalPhases: 4;
  docsProcessed: number;
  docsTotal: number;
  elapsedMs: number;
}

export interface BootstrapResult {
  status: 'ready' | 'skipped' | 'failed';
  summary?: ProjectSummary;
  docsIndexed?: number;
  durationMs: number;
  error?: string;
}

export interface BootstrapOptions {
  onProgress?: (progress: BootstrapProgress) => void;
  maxFiles?: number;
  maxBytes?: number;
  timeoutMs?: number;
}

interface BootstrapDeps {
  rebuildIndex: (projectPath: string) => Promise<{ docsIndexed: number; durationMs: number }>;
  getFingerprint: (projectPath: string) => string;
  /** Query evidence store for real tier stats (architectural alignment with F102). Falls back to structural summary classification when absent. */
  getTierCoverage?: (projectPath: string) => Promise<Record<string, number>>;
  /** Query evidence store for kind-based coverage (F102 content type dimension). */
  getKindCoverage?: (projectPath: string) => Promise<Record<string, number>>;
}

const SECRETS_PATTERNS = [/^\.env/, /\.key$/, /\.pem$/, /^credentials/i, /^secrets$/];
const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.cache', 'coverage']);

export class ExpeditionBootstrapService {
  constructor(
    private stateManager: IndexStateManager,
    private deps: BootstrapDeps,
  ) {}

  async bootstrap(projectPath: string, options: BootstrapOptions = {}): Promise<BootstrapResult> {
    const startTime = Date.now();
    const elapsed = () => Date.now() - startTime;
    const fp = this.deps.getFingerprint(projectPath);

    if (!this.stateManager.shouldBootstrap(projectPath, fp)) {
      return { status: 'skipped', durationMs: elapsed() };
    }

    this.stateManager.startBuilding(projectPath, fp);

    try {
      const emit = (phase: BootstrapProgress['phase'], idx: number, processed = 0, total = 0) =>
        options.onProgress?.({
          phase,
          phaseIndex: idx,
          totalPhases: 4,
          docsProcessed: processed,
          docsTotal: total,
          elapsedMs: elapsed(),
        });

      emit('scanning', 0);
      emit('extracting', 1);
      const summary = buildStructuralSummary(projectPath, options);

      emit('indexing', 2, 0, summary.docsList.length);
      const { docsIndexed } = await this.deps.rebuildIndex(projectPath);

      // Overlay real tier stats from evidence store when available (F102 alignment)
      // Both tierCoverage and docsIndexed must come from the same source to stay consistent
      let finalDocsIndexed = docsIndexed;
      if (this.deps.getTierCoverage) {
        const storeTiers = await this.deps.getTierCoverage(projectPath);
        if (Object.keys(storeTiers).length > 0) {
          summary.tierCoverage = storeTiers;
          finalDocsIndexed = Object.values(storeTiers).reduce((a, b) => a + b, 0);
        }
      }

      // Overlay kind-based coverage from evidence store (F102 content type dimension)
      if (this.deps.getKindCoverage) {
        const storeKinds = await this.deps.getKindCoverage(projectPath);
        if (Object.keys(storeKinds).length > 0) {
          summary.kindCoverage = storeKinds;
        }
      }

      emit('summarizing', 3, finalDocsIndexed, summary.docsList.length);
      this.stateManager.markReady(projectPath, finalDocsIndexed, JSON.stringify(summary));

      return { status: 'ready', summary, docsIndexed: finalDocsIndexed, durationMs: elapsed() };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.stateManager.markFailed(projectPath, errorMsg);
      return { status: 'failed', durationMs: elapsed(), error: errorMsg };
    }
  }
}

const TECH_DETECTORS: Array<{ file: string; tech: string }> = [
  { file: 'package.json', tech: 'node' },
  { file: 'tsconfig.json', tech: 'typescript' },
  { file: 'Cargo.toml', tech: 'rust' },
  { file: 'pyproject.toml', tech: 'python' },
  { file: 'go.mod', tech: 'go' },
  { file: 'Gemfile', tech: 'ruby' },
  { file: 'build.gradle', tech: 'java' },
  { file: 'pom.xml', tech: 'java' },
  { file: 'composer.json', tech: 'php' },
];

const DOC_PATTERNS: Array<{ pattern: RegExp; tier: 'authoritative' | 'derived' | 'soft_clue' }> = [
  { pattern: /(?:^|\/)README/i, tier: 'authoritative' },
  { pattern: /(?:^|\/)ARCHITECTURE/i, tier: 'authoritative' },
  { pattern: /(?:^|\/)CONTRIBUTING/i, tier: 'authoritative' },
  { pattern: /^docs\/.*\.md$/i, tier: 'authoritative' },
  { pattern: /(?:^|\/)CHANGELOG/i, tier: 'soft_clue' },
  { pattern: /\.md$/i, tier: 'derived' },
];

function isSecretFile(name: string): boolean {
  return SECRETS_PATTERNS.some((p) => p.test(name));
}

function isInsideProject(filePath: string, projectRoot: string): boolean {
  try {
    const real = realpathSync(filePath);
    const realRoot = realpathSync(projectRoot);
    return real.startsWith(realRoot + '/') || real === realRoot;
  } catch {
    return false;
  }
}

function classifyDoc(relativePath: string): 'authoritative' | 'derived' | 'soft_clue' | null {
  for (const { pattern, tier } of DOC_PATTERNS) {
    if (pattern.test(relativePath)) return tier;
  }
  return null;
}

function walkDocs(
  dir: string,
  projectRoot: string,
  budget: { remaining: number },
  depth = 0,
): Array<{ path: string; tier: 'authoritative' | 'derived' | 'soft_clue' }> {
  if (depth > 3 || budget.remaining <= 0) return [];
  const results: Array<{ path: string; tier: 'authoritative' | 'derived' | 'soft_clue' }> = [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (budget.remaining <= 0) break;
    if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;
    if (isSecretFile(entry)) continue;

    const full = join(dir, entry);
    if (!isInsideProject(full, projectRoot)) continue;

    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      results.push(...walkDocs(full, projectRoot, budget, depth + 1));
    } else if (stat.isFile()) {
      const relPath = relative(projectRoot, full);
      const tier = classifyDoc(relPath);
      if (tier) {
        results.push({ path: relPath, tier });
        budget.remaining--;
      }
    }
  }

  return results;
}

export function buildStructuralSummary(projectPath: string, options: { maxFiles?: number } = {}): ProjectSummary {
  const projectName = basename(projectPath);

  const techStack: string[] = [];
  for (const { file, tech } of TECH_DETECTORS) {
    if (existsSync(join(projectPath, file))) techStack.push(tech);
  }

  let entries: string[];
  try {
    entries = readdirSync(projectPath);
  } catch {
    entries = [];
  }

  const dirStructure = entries.filter((e) => {
    if (e.startsWith('.') || SKIP_DIRS.has(e)) return false;
    try {
      return statSync(join(projectPath, e)).isDirectory();
    } catch {
      return false;
    }
  });

  let coreModules: string[] = [];
  try {
    const pkgPath = join(projectPath, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (pkg.workspaces) {
        const wsPatterns = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces.packages || [];
        for (const pattern of wsPatterns) {
          const wsDir = pattern.replace(/\/\*$/, '');
          const wsPath = join(projectPath, wsDir);
          if (existsSync(wsPath)) {
            try {
              coreModules = readdirSync(wsPath).filter((e) => {
                try {
                  return statSync(join(wsPath, e)).isDirectory();
                } catch {
                  return false;
                }
              });
            } catch {
              // ignore
            }
          }
        }
      }
    }
  } catch {
    // ignore parse errors
  }

  const budget = { remaining: options.maxFiles ?? 500 };
  const docsList = walkDocs(projectPath, projectPath, budget);

  const tierCoverage: Record<string, number> = {};
  for (const doc of docsList) {
    tierCoverage[doc.tier] = (tierCoverage[doc.tier] || 0) + 1;
  }

  const kindCoverage: Record<string, number> = {};

  return { projectName, techStack, dirStructure, coreModules, docsList, tierCoverage, kindCoverage };
}
