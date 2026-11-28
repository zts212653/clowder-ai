import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { CatCafeConfig } from '@cat-cafe/shared';
import { projectRoleCatalog } from '@clowder-ai/agent-access/roles/role-catalog-projection';
import { inheritFullyBlockedMcpCapabilitiesForNewCatsSync } from './capabilities/capability-orchestrator.js';
import { writeFileAtomic } from './write-file-atomic.js';

export { repairLegacyNativeToolIdentities } from '@clowder-ai/agent-access/roles/role-catalog-projection';

export function resolveCatCatalogPath(projectRoot: string): string {
  return resolve(projectRoot, '.cat-cafe', 'cat-catalog.json');
}

/** Reads the stored bytes for conditional commits, including the missing-file state. */
export function readStoredCatCatalog(projectRoot: string): Buffer | null {
  try {
    return readFileSync(resolveCatCatalogPath(projectRoot));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return null;
  }
}

export function readRoleCatalogTemplate(templatePath: string): CatCafeConfig | null {
  try {
    return JSON.parse(readFileSync(templatePath, 'utf8')) as CatCafeConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return null;
  }
}

export interface CatCatalogReadOptions {
  /** Former compatibility flag. Catalog readers always leave the file untouched. */
  persistMigrations?: boolean;
  runtimeRolesOnly?: boolean;
}

export function readCatCatalogRaw(projectRoot: string, _options: CatCatalogReadOptions = {}): string | null {
  const stored = readStoredCatCatalog(projectRoot);
  if (stored === null) return null;
  const source = stored.toString('utf8');
  try {
    return projectRoleCatalog(source, readRoleCatalogTemplate(join(projectRoot, 'cat-template.json')), false).source;
  } catch {
    // Delegate invalid catalog errors to the loader with the original input.
    return source;
  }
}

export function readCatCatalog(projectRoot: string): CatCafeConfig | null {
  const raw = readCatCatalogRaw(projectRoot);
  return raw === null ? null : (JSON.parse(raw) as CatCafeConfig);
}

export function readRoleCatalogSnapshot(projectRoot: string, templatePath: string, purpose: 'read' | 'write') {
  const stored = readStoredCatCatalog(projectRoot);
  const template = readRoleCatalogTemplate(templatePath);
  const source = stored?.toString('utf8') ?? null;
  const proposed = projectRoleCatalog(source, template, true);
  // Read access may publish compatibility additions once their inherited MCP blocks are in effect.
  if (
    purpose === 'read' &&
    inheritFullyBlockedMcpCapabilitiesForNewCatsSync(
      projectRoot,
      proposed.backfilledCatIds,
      proposed.existingCatIds,
      'preview',
    )
  ) {
    return { stored, ...projectRoleCatalog(source, template, false) };
  }
  return { stored, ...proposed };
}

export function readPublishedRoleCatalogSource(projectRoot: string, templatePath: string): string {
  return readRoleCatalogSnapshot(projectRoot, templatePath, 'read').source;
}

/** Explicit repair for legacy catalog maintenance. Product reads use the pure projection. */
export function bootstrapCatCatalog(projectRoot: string, templatePath: string): string {
  const catalogPath = resolveCatCatalogPath(projectRoot);
  const next = readRoleCatalogSnapshot(projectRoot, templatePath, 'write');
  if (next.stored?.toString('utf8') !== next.source) {
    mkdirSync(dirname(catalogPath), { recursive: true });
    inheritFullyBlockedMcpCapabilitiesForNewCatsSync(projectRoot, next.backfilledCatIds, next.existingCatIds);
    writeFileAtomic(catalogPath, next.source);
  }
  return catalogPath;
}

export function writeCatCatalog(projectRoot: string, catalog: CatCafeConfig): string {
  const catalogPath = resolveCatCatalogPath(projectRoot);
  mkdirSync(dirname(catalogPath), { recursive: true });
  writeFileAtomic(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  return catalogPath;
}
