/**
 * F070: Governance Registry — dispatch audit trail
 *
 * Tracks which external projects have been bootstrapped,
 * their governance pack versions, and sync timestamps.
 * Stored at `.cat-cafe/governance-registry.json` in the Clowder AI root.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import type { BootstrapReport, GovernanceHealthSummary, GovernancePackMeta } from '@cat-cafe/shared';
import { pathsEqual } from '../../utils/project-path.js';
import { GOVERNANCE_PACK_VERSION } from './governance-pack.js';

const REGISTRY_DIR = '.cat-cafe';
const REGISTRY_FILENAME = 'governance-registry.json';

interface RegistryEntry extends GovernancePackMeta {
  /** Absolute path to the external project */
  projectPath: string;
  /** F302: last confirmed install ledger; target repos do not store this state. */
  lastBootstrapReport?: BootstrapReport;
  /** F302: last confirmed cleanup ledger. */
  lastCleanupReport?: BootstrapReport;
}

interface RegistryData {
  entries: RegistryEntry[];
}

function safePath(root: string, ...segments: string[]): string {
  const rootResolved = resolve(root);
  const normalized = resolve(rootResolved, ...segments);
  const rel = relative(rootResolved, normalized);
  if (rel.startsWith(`..${sep}`) || rel === '..') {
    throw new Error(`Path escapes project root: ${normalized}`);
  }
  return normalized;
}

export class GovernanceRegistry {
  constructor(private readonly catCafeRoot: string) {}

  private get filePath(): string {
    return safePath(this.catCafeRoot, REGISTRY_DIR, REGISTRY_FILENAME);
  }

  async read(): Promise<RegistryData> {
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const data = JSON.parse(raw) as RegistryData;
      if (!Array.isArray(data.entries)) return { entries: [] };
      return data;
    } catch {
      return { entries: [] };
    }
  }

  private async write(data: RegistryData): Promise<void> {
    const dir = safePath(this.catCafeRoot, REGISTRY_DIR);
    await mkdir(dir, { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  }

  async register(projectPath: string, meta: GovernancePackMeta): Promise<void> {
    const data = await this.read();
    const existing = data.entries.findIndex((e) => pathsEqual(e.projectPath, projectPath));
    const entry: RegistryEntry = { ...(existing >= 0 ? data.entries[existing] : {}), ...meta, projectPath };
    if (existing >= 0) {
      data.entries[existing] = entry;
    } else {
      data.entries.push(entry);
    }
    await this.write(data);
  }

  async recordBootstrap(projectPath: string, meta: GovernancePackMeta, report: BootstrapReport): Promise<void> {
    await this.register(projectPath, meta);
    const data = await this.read();
    const entry = data.entries.find((candidate) => pathsEqual(candidate.projectPath, projectPath));
    if (!entry) throw new Error(`Governance registry entry missing after register: ${projectPath}`);
    entry.lastBootstrapReport = report;
    await this.write(data);
  }

  async recordCleanup(projectPath: string, meta: GovernancePackMeta, report: BootstrapReport): Promise<void> {
    const data = await this.read();
    let entry = data.entries.find((candidate) => pathsEqual(candidate.projectPath, projectPath));
    if (!entry) {
      entry = { ...meta, projectPath };
      data.entries.push(entry);
    }
    entry.lastCleanupReport = report;
    await this.write(data);
  }

  async get(projectPath: string): Promise<RegistryEntry | undefined> {
    const data = await this.read();
    return data.entries.find((e) => pathsEqual(e.projectPath, projectPath));
  }

  async listAll(): Promise<readonly RegistryEntry[]> {
    const data = await this.read();
    return data.entries;
  }

  /** A request-local health snapshot: read and parse the registry once. */
  async listHealth(currentVersion?: string): Promise<GovernanceHealthSummary[]> {
    const { entries } = await this.read();
    const firstByPath = new Map<string, RegistryEntry>();
    for (const entry of entries) {
      if (!firstByPath.has(entry.projectPath)) firstByPath.set(entry.projectPath, entry);
    }
    return entries.map((entry) => {
      // Keep get()'s first-match semantics for legacy duplicates and Windows paths.
      const first =
        process.platform === 'win32'
          ? entries.find((candidate) => pathsEqual(candidate.projectPath, entry.projectPath))
          : firstByPath.get(entry.projectPath);
      return projectGovernanceHealth(entry.projectPath, first, currentVersion ?? GOVERNANCE_PACK_VERSION);
    });
  }

  async checkHealth(projectPath: string, currentVersion?: string): Promise<GovernanceHealthSummary> {
    return projectGovernanceHealth(projectPath, await this.get(projectPath), currentVersion ?? GOVERNANCE_PACK_VERSION);
  }
}

function projectGovernanceHealth(
  projectPath: string,
  entry: RegistryEntry | undefined,
  currentVersion: string,
): GovernanceHealthSummary {
  if (!entry) {
    return {
      projectPath,
      status: 'never-synced',
      packVersion: null,
      lastSyncedAt: null,
      findings: [],
    };
  }
  return {
    projectPath,
    status: entry.packVersion === currentVersion ? 'healthy' : 'stale',
    packVersion: entry.packVersion,
    lastSyncedAt: entry.syncedAt,
    findings: [],
  };
}
