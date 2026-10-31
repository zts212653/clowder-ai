export const TEMPLATE_VARIANT_TOMBSTONES_KEY = 'templateVariantTombstones';

export interface TemplateVariantTombstoneInput {
  breedId: string;
  variantId: string;
  catId: string;
}

interface TemplateVariantTombstoneRecord extends TemplateVariantTombstoneInput {
  deletedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function tombstoneKey({ breedId, variantId, catId }: TemplateVariantTombstoneInput): string {
  return `${breedId}\u001f${variantId}\u001f${catId}`;
}

function readTombstoneRecords(catalog: Record<string, unknown>): Record<string, unknown> {
  const records = catalog[TEMPLATE_VARIANT_TOMBSTONES_KEY];
  return isRecord(records) ? records : {};
}

export function isTemplateVariantTombstoned(
  catalog: Record<string, unknown>,
  input: TemplateVariantTombstoneInput,
): boolean {
  return Object.hasOwn(readTombstoneRecords(catalog), tombstoneKey(input));
}

export function addTemplateVariantTombstone(
  catalog: Record<string, unknown>,
  input: TemplateVariantTombstoneInput,
): void {
  const records = readTombstoneRecords(catalog);
  const key = tombstoneKey(input);
  const existing = records[key];
  records[key] = isRecord(existing)
    ? existing
    : ({
        ...input,
        deletedAt: new Date().toISOString(),
      } satisfies TemplateVariantTombstoneRecord);
  catalog[TEMPLATE_VARIANT_TOMBSTONES_KEY] = records;
}

export function collectTemplateVariantTombstoneCatIds(catalog: Record<string, unknown>): Set<string> {
  const catIds = new Set<string>();
  for (const value of Object.values(readTombstoneRecords(catalog))) {
    if (!isRecord(value)) continue;
    if (typeof value.catId === 'string') catIds.add(value.catId);
  }
  return catIds;
}
