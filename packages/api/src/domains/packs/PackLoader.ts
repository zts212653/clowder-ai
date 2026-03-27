/**
 * F129 PackLoader — Git Clone + Validate + Install
 * High-level orchestrator: source → validate → store.
 *
 * AC-A4: cafe pack add <git-url>
 * AC-A5: cafe pack list / remove
 */

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { PackManifest } from '@cat-cafe/shared';
import { PackManifestSchema } from '@cat-cafe/shared';
import { parse } from 'yaml';
import type { PackSecurityGuard, SecurityResult } from './PackSecurityGuard.js';
import type { PackStore } from './PackStore.js';

export class PackLoader {
  constructor(
    private readonly store: PackStore,
    private readonly guard: PackSecurityGuard,
  ) {}

  /**
   * Install a pack from local directory path.
   * Phase A: local paths only. Git URL support deferred to Phase B.
   * Pipeline: resolve → security validate → store.install
   */
  async add(source: string): Promise<PackManifest> {
    // Phase A: reject git URLs (attack surface reduction)
    const isGitUrl = source.startsWith('http://') || source.startsWith('https://') || source.endsWith('.git');
    if (isGitUrl) {
      throw new Error('Git URL sources are not supported in Phase A. Use a local directory path.');
    }

    let sourceDir: string;
    try {
      const s = await stat(source);
      if (!s.isDirectory()) throw new Error('Not a directory');
    } catch {
      throw new Error(`Source path not found or not a directory: ${source}`);
    }
    sourceDir = source;

    // Security validation
    const result = await this.guard.validate(sourceDir);
    if (!result.ok) {
      throw new PackSecurityError(result);
    }

    // Read manifest for pack name
    const manifest = await readManifest(sourceDir);

    // Store
    await this.store.install(manifest.name, sourceDir);
    return manifest;
  }

  /** List installed packs */
  async list(): Promise<PackManifest[]> {
    return this.store.list();
  }

  /** Remove an installed pack */
  async remove(name: string): Promise<boolean> {
    return this.store.remove(name);
  }
}

/** Read and validate pack.yaml from a directory */
async function readManifest(dir: string): Promise<PackManifest> {
  const raw = await readFile(join(dir, 'pack.yaml'), 'utf-8');
  const parsed = parse(raw) as unknown;
  const result = PackManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid pack.yaml: ${result.error.issues.map((i) => i.message).join('; ')}`);
  }
  return result.data;
}

export class PackSecurityError extends Error {
  constructor(public readonly result: SecurityResult) {
    super(`Pack security validation failed:\n${result.reasons.map((r) => `  - ${r}`).join('\n')}`);
    this.name = 'PackSecurityError';
  }
}
