// F209 Phase B.1: explicit entity seeds + one-way roster retrieval anchors.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CatCafeConfig, CatConfig } from '@cat-cafe/shared';
import { loadCatConfig, toAllCatConfigs } from '../../config/cat-config-loader.js';
import { normalizeEntityAlias } from './EntityRegistry.js';
import type { EntityProvenance, EntityRecord, EntityType } from './interfaces.js';

const DEFAULT_ENTITY_SEED_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../..',
  'config/entity-seeds.json',
);

const ENTITY_TYPES = new Set<EntityType>(['person', 'cat', 'feature', 'concept', 'external']);

interface EntitySeedFile {
  version: 1;
  entities: EntityRecord[];
}

export interface EntitySeedOptions {
  explicitSeedPath?: string;
  includeRoster?: boolean;
  catConfig?: CatCafeConfig;
}

export function getDefaultEntitySeedPath(): string {
  return DEFAULT_ENTITY_SEED_PATH;
}

export function loadEntitySeeds(options: EntitySeedOptions = {}): EntityRecord[] {
  const explicit = loadExplicitEntitySeeds(options.explicitSeedPath ?? DEFAULT_ENTITY_SEED_PATH);
  const explicitIds = new Set(explicit.map((entity) => entity.entityId));
  const roster =
    options.includeRoster === false
      ? []
      : buildRosterEntitySeeds(options.catConfig ?? loadCatConfig()).filter(
          (entity) => !explicitIds.has(entity.entityId),
        );
  return [...explicit, ...roster];
}

export function loadExplicitEntitySeeds(seedPath: string): EntityRecord[] {
  const resolvedPath = resolve(seedPath);
  if (!existsSync(resolvedPath)) return [];

  const parsed = JSON.parse(readFileSync(resolvedPath, 'utf-8')) as unknown;
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.entities)) {
    throw new Error(`Invalid entity seed file ${resolvedPath}: expected { version: 1, entities: [...] }`);
  }

  const seedFile: EntitySeedFile = {
    version: 1,
    entities: parsed.entities as EntityRecord[],
  };
  return seedFile.entities.map((entity, index) => validateEntitySeed(entity, resolvedPath, index));
}

// F260 Phase A T4: filter out dev/test cats that pollute the entity registry.
// Pattern matches catId strings that look like test fixtures or auto-generated dev entries.
const DEV_TEST_CAT_PATTERN = /[-_](test|dev|staging|sandbox)\b|^cat-[a-z0-9]{6,8}$/i;

export function buildRosterEntitySeeds(config: CatCafeConfig): EntityRecord[] {
  const cats = toAllCatConfigs(config);
  const entries = Object.entries(cats).filter(([catId]) => !DEV_TEST_CAT_PATTERN.test(catId));
  const sharedNicknames = findSharedNicknameNorms(entries);
  return entries.map(([catId, cat]) => ({
    entityId: `cat:${catId}`,
    type: 'cat',
    canonicalName: buildCatCanonicalName(catId, cat, sharedNicknames),
    aliases: buildCatAliases(catId, cat, sharedNicknames),
    provenance: [
      {
        source: 'F032 roster',
        anchor: 'cat-template.json',
        note: 'One-way roster to F209 entity registry retrieval anchor; never written back to roster.',
        date: '2026-05-23',
      },
    ],
    updatedAt: new Date().toISOString(),
  }));
}

function validateEntitySeed(entity: EntityRecord, seedPath: string, index: number): EntityRecord {
  if (!isRecord(entity)) {
    throw new Error(`Invalid entity seed ${seedPath}#${index}: expected object`);
  }
  if (typeof entity.entityId !== 'string' || entity.entityId.trim().length === 0) {
    throw new Error(`Invalid entity seed ${seedPath}#${index}: entityId is required`);
  }
  if (!ENTITY_TYPES.has(entity.type)) {
    throw new Error(`Invalid entity seed ${seedPath}#${index}: unsupported type ${String(entity.type)}`);
  }
  if (typeof entity.canonicalName !== 'string' || entity.canonicalName.trim().length === 0) {
    throw new Error(`Invalid entity seed ${seedPath}#${index}: canonicalName is required`);
  }
  if (!Array.isArray(entity.aliases) || entity.aliases.filter((alias) => alias.trim().length > 0).length === 0) {
    throw new Error(`Invalid entity seed ${seedPath}#${index}: aliases must be non-empty`);
  }
  if (!Array.isArray(entity.provenance) || entity.provenance.length === 0) {
    throw new Error(`Invalid entity seed ${seedPath}#${index}: provenance is required`);
  }
  if (typeof entity.updatedAt !== 'string' || entity.updatedAt.trim().length === 0) {
    throw new Error(`Invalid entity seed ${seedPath}#${index}: updatedAt is required`);
  }

  return {
    entityId: entity.entityId.trim(),
    type: entity.type,
    canonicalName: entity.canonicalName.trim(),
    aliases: uniqueNonEmpty(entity.aliases),
    provenance: entity.provenance.map((p, pIndex) => validateProvenance(p, seedPath, index, pIndex)),
    ...(entity.createdAt ? { createdAt: entity.createdAt } : {}),
    // F260: preserve optional fields so explicit non-default seeds are not silently dropped
    // (codex review R2 P2: validateEntitySeed was stripping stance/visibilityScope/status).
    ...(entity.stance ? { stance: entity.stance } : {}),
    ...(entity.visibilityScope ? { visibilityScope: entity.visibilityScope } : {}),
    ...(entity.status ? { status: entity.status } : {}),
    updatedAt: entity.updatedAt,
  };
}

function validateProvenance(
  provenance: EntityProvenance,
  seedPath: string,
  entityIndex: number,
  provenanceIndex: number,
): EntityProvenance {
  if (!isRecord(provenance) || typeof provenance.source !== 'string' || provenance.source.trim().length === 0) {
    throw new Error(
      `Invalid entity seed ${seedPath}#${entityIndex}.provenance[${provenanceIndex}]: source is required`,
    );
  }
  return {
    source: provenance.source.trim(),
    ...(provenance.anchor ? { anchor: provenance.anchor } : {}),
    ...(provenance.note ? { note: provenance.note } : {}),
    ...(provenance.date ? { date: provenance.date } : {}),
  };
}

function buildCatAliases(catId: string, cat: CatConfig, sharedNicknames: Set<string>): string[] {
  const bareMentionAliases = cat.mentionPatterns.map((pattern) => pattern.replace(/^@+/, ''));
  const aliases = [
    catId,
    `@${catId}`,
    catSpecificAlias(cat.name, cat, sharedNicknames),
    catSpecificAlias(cat.displayName, cat, sharedNicknames),
    catSpecificAlias(cat.nickname, cat, sharedNicknames),
    ...cat.mentionPatterns,
    ...bareMentionAliases.map((alias) => catSpecificAlias(alias, cat, sharedNicknames)),
  ];
  return uniqueNonEmpty(aliases);
}

function buildCatCanonicalName(catId: string, cat: CatConfig, sharedNicknames: Set<string>): string {
  return (
    catSpecificAlias(cat.name, cat, sharedNicknames) ?? catSpecificAlias(cat.displayName, cat, sharedNicknames) ?? catId
  );
}

function catSpecificAlias(value: string | undefined, cat: CatConfig, sharedNicknames: Set<string>): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed === cat.breedId || trimmed === cat.breedDisplayName || trimmed === cat.variantLabel) return undefined;
  if (sharedNicknames.has(normalizeEntityAlias(trimmed))) return undefined;
  return trimmed;
}

function findSharedNicknameNorms(entries: Array<[string, CatConfig]>): Set<string> {
  const counts = new Map<string, number>();
  for (const [, cat] of entries) {
    const nickname = cat.nickname?.trim();
    if (!nickname) continue;
    const norm = normalizeEntityAlias(nickname);
    counts.set(norm, (counts.get(norm) ?? 0) + 1);
  }
  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([norm]) => norm));
}

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * F260 Phase A INV-5: Check if an entity has proposal provenance.
 *
 * Entities created via the propose_entity approval flow carry
 * provenance with source='proposal'. These must be skipped during
 * seed reload to prevent approved proposals from being overwritten
 * by default seed data on server restart.
 */
export function shouldSkipProposalEntity(entity: EntityRecord): boolean {
  return entity.provenance.some((p) => p.source === 'proposal');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
