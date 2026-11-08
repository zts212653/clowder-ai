import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CollectionManifest } from './collection-types.js';
import { validateManifestInput } from './collection-types.js';

const COLLECTIONS_FILE = 'library/collections.json';

/** Read one saved record before deciding whether a collection is new or can be restored. */
export function getExternalCollection(dataDir: string, collectionId: string): CollectionManifest | undefined {
  const filePath = join(dataDir, COLLECTIONS_FILE);
  if (!existsSync(filePath)) return undefined;
  const raw: unknown = JSON.parse(readFileSync(filePath, 'utf-8'));
  if (!Array.isArray(raw)) throw new Error('external_collections_manifest_invalid');
  const matches = raw.filter(
    (entry: unknown): entry is CollectionManifest =>
      typeof entry === 'object' && entry !== null && 'id' in entry && entry.id === collectionId,
  );
  if (matches.length > 1) throw new Error('external_collection_manifest_duplicate');
  const manifest = matches[0];
  if (manifest) validateManifestInput(manifest);
  return manifest;
}

export function loadExternalCollections(dataDir: string): CollectionManifest[] {
  const filePath = join(dataDir, COLLECTIONS_FILE);
  if (!existsSync(filePath)) return [];
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as CollectionManifest[];
    return raw.filter((m) => {
      try {
        validateManifestInput(m);
        return true;
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

export function saveExternalCollection(dataDir: string, manifest: CollectionManifest): void {
  const dirPath = join(dataDir, 'library');
  mkdirSync(dirPath, { recursive: true });
  const filePath = join(dirPath, 'collections.json');
  const existing = existsSync(filePath) ? (JSON.parse(readFileSync(filePath, 'utf-8')) as CollectionManifest[]) : [];
  existing.push(manifest);
  writeFileSync(filePath, JSON.stringify(existing, null, 2));
}

export function updateExternalCollection(dataDir: string, id: string, updates: Partial<CollectionManifest>): void {
  const filePath = join(dataDir, COLLECTIONS_FILE);
  const existing = existsSync(filePath) ? (JSON.parse(readFileSync(filePath, 'utf-8')) as CollectionManifest[]) : [];
  const idx = existing.findIndex((m) => m.id === id);
  if (idx === -1) throw new Error(`Collection "${id}" not found in collections.json`);
  existing[idx] = { ...existing[idx], ...updates, updatedAt: new Date().toISOString() };
  writeFileSync(filePath, JSON.stringify(existing, null, 2));
}

export function resolveCollectionStorePath(dataDir: string, collectionId: string): string {
  const safeId = collectionId.replace(/:/g, '-');
  return join(dataDir, 'library', safeId, 'evidence.sqlite');
}
