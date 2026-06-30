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

function templateVariantKey({ breedId, variantId, catId }: TemplateVariantBackfillInput): string {
  return `${breedId}\u001f${variantId}\u001f${catId}`;
}

const TEMPLATE_VARIANT_BACKFILL_ALLOWLIST = new Set([
  templateVariantKey({
    breedId: 'bengal',
    variantId: 'agy-opus',
    catId: 'agy-opus',
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
