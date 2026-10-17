import { createHash } from 'node:crypto';
import { type CatVariant, catRegistry } from '@cat-cafe/shared';
import { createRuntimeCat, type RuntimeCatInput, readRuntimeCatCatalog } from './runtime-cat-catalog.js';

type Receipt = NonNullable<CatVariant['creationReceipt']>;
export class MemberCreateConflict extends Error {}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
const hash = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');

/** Headers express intent; only this server-derived, catalog-persisted receipt proves ownership. */
export function memberCreationReceipt(
  operator: string,
  journey: unknown,
  key: unknown,
  body: unknown,
): Receipt | undefined {
  if (journey === undefined && key === undefined) return undefined;
  if (
    typeof journey !== 'string' ||
    typeof key !== 'string' ||
    journey.length > 128 ||
    key.length > 8192 ||
    !key.startsWith(`onboarding:${journey}:cat:`)
  )
    throw new MemberCreateConflict('Invalid member creation request identity');
  return { requestHash: hash([operator, journey, key]), payloadHash: hash(body) };
}
function reserve(base: string, occupied: Set<string>, limit: number): string {
  let candidate = base;
  for (let n = 2; occupied.has(candidate.toLowerCase()); n++) {
    const suffix = `-${n}`;
    candidate = `${base.slice(0, limit - suffix.length).replace(/-+$/, '')}${suffix}`;
  }
  return candidate;
}
const alias = (value: string) => `@${value.trim().replace(/^@/, '').toLowerCase()}`;

/** Must run inside the catalog mutation/file lock. Member + receipt share one atomic rename. */
export function createOwnedRuntimeCat(
  projectRoot: string,
  input: RuntimeCatInput,
  receipt?: Receipt,
): { id: string; replayed: boolean } {
  const catalog = readRuntimeCatCatalog(projectRoot);
  const members = catalog.breeds.flatMap((b) => b.variants.map((v) => ({ id: v.catId ?? b.catId, variant: v })));
  const owned = receipt && members.find((m) => m.variant.creationReceipt?.requestHash === receipt.requestHash);
  if (owned) {
    if (owned.variant.creationReceipt?.payloadHash !== receipt.payloadHash)
      throw new MemberCreateConflict('This creation request already belongs to a different configuration');
    return { id: String(owned.id), replayed: true };
  }
  const registry = Object.values(catRegistry.getAllConfigs());
  const ids = new Set(
    [
      ...catalog.breeds.flatMap((b) => [b.id, ...b.variants.map((v) => v.catId ?? b.catId ?? '')]),
      ...registry.map((c) => c.id),
    ].map((id) => id.toLowerCase()),
  );
  if (!receipt && ids.has(input.catId.toLowerCase()))
    throw new MemberCreateConflict(
      `Member ID "${input.catId}" is occupied; choose another ID or explicitly edit that member`,
    );
  const id = receipt ? reserve(input.catId, ids, 40) : input.catId;
  const aliases = new Set(
    [
      ...catalog.breeds.flatMap((b) => [...b.mentionPatterns, ...b.variants.flatMap((v) => v.mentionPatterns ?? [])]),
      ...registry.flatMap((c) => c.mentionPatterns),
    ].map(alias),
  );
  const patterns = input.mentionPatterns.map((pattern) => {
    const normalized = alias(pattern);
    if (!receipt && aliases.has(normalized)) throw new MemberCreateConflict(`Alias "${pattern}" is occupied`);
    const unique = receipt ? reserve(normalized, aliases, 80) : normalized;
    aliases.add(unique);
    return unique;
  });
  createRuntimeCat(projectRoot, {
    ...input,
    catId: id,
    mentionPatterns: patterns,
    ...(receipt ? { creationReceipt: receipt } : {}),
  });
  return { id, replayed: false };
}
