import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AntigravityCatalogEntry } from './adapters/antigravity-adapter.js';
import type { ClaudeCatalogEntry } from './adapters/claude-adapter.js';
import type { CodexCatalogEntry } from './adapters/codex-adapter.js';
import type { OpenClawCatalogEntry } from './adapters/openclaw-adapter.js';

const thisDir = dirname(fileURLToPath(import.meta.url));
const catalogDir = join(thisDir, 'catalog-data');

async function loadJSON<T>(filename: string): Promise<T[]> {
  const raw = await readFile(join(catalogDir, filename), 'utf-8');
  return JSON.parse(raw) as T[];
}

export function loadClaudeCatalog(): Promise<ClaudeCatalogEntry[]> {
  return loadJSON<ClaudeCatalogEntry>('claude.json');
}

export function loadCodexCatalog(): Promise<CodexCatalogEntry[]> {
  return loadJSON<CodexCatalogEntry>('codex.json');
}

export function loadOpenClawCatalog(): Promise<OpenClawCatalogEntry[]> {
  return loadJSON<OpenClawCatalogEntry>('openclaw.json');
}

export function loadAntigravityCatalog(): Promise<AntigravityCatalogEntry[]> {
  return loadJSON<AntigravityCatalogEntry>('antigravity.json');
}
