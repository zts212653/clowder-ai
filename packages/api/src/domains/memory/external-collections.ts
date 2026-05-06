import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CollectionManifest } from './collection-types.js';
import { validateManifestInput } from './collection-types.js';

const COLLECTIONS_FILE = 'library/collections.json';

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

export function resolveCollectionStorePath(dataDir: string, collectionId: string): string {
  const safeId = collectionId.replace(/:/g, '-');
  return join(dataDir, 'library', safeId, 'evidence.sqlite');
}
