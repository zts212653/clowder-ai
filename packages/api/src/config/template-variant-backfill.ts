export interface TemplateVariantBackfillInput {
  breedId: string;
  variantId: string;
  catId: string;
  mentionPatterns?: readonly string[];
}

export interface TemplateVariantBackfillOccupancy {
  catIds?: ReadonlySet<string>;
  mentionAliases?: ReadonlySet<string>;
}

export interface TemplateBreedBackfillInput {
  breedId: string;
  catId: string;
  catIds?: readonly string[];
  mentionPatterns?: readonly string[];
}

function templateVariantKey({ breedId, variantId, catId }: TemplateVariantBackfillInput): string {
  return `${breedId}\u001f${variantId}\u001f${catId}`;
}

function templateBreedKey({ breedId, catId }: Pick<TemplateBreedBackfillInput, 'breedId' | 'catId'>): string {
  return `${breedId}\u001f${catId}`;
}

const TEMPLATE_VARIANT_BACKFILL_ALLOWLIST = new Set([
  templateVariantKey({
    breedId: 'bengal',
    variantId: 'agy-opus',
    catId: 'agy-opus',
  }),
  templateVariantKey({
    breedId: 'dragon-li',
    variantId: 'glm52-default',
    catId: 'glm52',
  }),
  templateVariantKey({
    breedId: 'maine-coon',
    variantId: 'codex-sol',
    catId: 'codex-sol',
  }),
]);

const TEMPLATE_BREED_BACKFILL_ALLOWLIST = new Set([
  templateBreedKey({
    breedId: 'dragon-li',
    catId: 'glm52',
  }),
]);

export function isTemplateVariantBackfillAllowed(
  input: TemplateVariantBackfillInput,
  occupancy: TemplateVariantBackfillOccupancy = {},
): boolean {
  if (occupancy.catIds?.has(input.catId)) return false;
  if (hasOccupiedMentionAlias(input.mentionPatterns ?? [], occupancy.mentionAliases)) return false;
  return TEMPLATE_VARIANT_BACKFILL_ALLOWLIST.has(templateVariantKey(input));
}

export function isTemplateBreedBackfillAllowed(
  input: TemplateBreedBackfillInput,
  occupancy: TemplateVariantBackfillOccupancy = {},
): boolean {
  const catIds = input.catIds ?? [input.catId];
  if (occupancy.catIds) {
    for (const catId of catIds) {
      if (occupancy.catIds.has(catId)) return false;
    }
  }
  if (hasOccupiedMentionAlias(input.mentionPatterns ?? [], occupancy.mentionAliases)) return false;
  return TEMPLATE_BREED_BACKFILL_ALLOWLIST.has(templateBreedKey(input));
}

export function normalizeMentionAlias(pattern: string): string {
  return pattern.trim().toLowerCase();
}

export function hasOccupiedMentionAlias(
  mentionPatterns: readonly string[],
  occupiedMentionAliases: ReadonlySet<string> = new Set(),
): boolean {
  for (const pattern of mentionPatterns) {
    const normalized = normalizeMentionAlias(pattern);
    if (normalized && occupiedMentionAliases.has(normalized)) return true;
  }
  return false;
}
