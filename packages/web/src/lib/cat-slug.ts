/**
 * F056 catId → CSS variable helper.
 *
 * catSlug() returns catId directly — the runtime catId (e.g. "opus", "codex")
 * is already the CSS key. CatHueInjector generates --color-{catId}-* tokens
 * dynamically for all cats.
 *
 * Safety: catSlug() validates that the ID is CSS-safe (alphanumeric + hyphen +
 * underscore). This must match CatHueInjector's guard — if CatHueInjector
 * skips an ID, catSlug() must not return it (the reference would point to a
 * non-existent token). Unsafe IDs fall back to 'cocreator' so they still
 * get valid styling instead of broken var() references.
 */

const CSS_SAFE_ID = /^[a-zA-Z0-9_-]+$/;

/** Return the CSS key for a catId. Validates safety for CSS var interpolation. */
export function catSlug(catId: string | undefined): string {
  if (!catId) return 'cocreator';
  if (!CSS_SAFE_ID.test(catId)) return 'cocreator';
  return catId;
}

/** Build `var(--color-{catId}-{tier})` for a cat color. Default tier is primary. */
export function catColorVar(
  catId: string | undefined,
  tier: 'bubble' | 'surface' | 'text' | 'ring' | 'primary' | 'light' | 'dark' | 'bg' = 'primary',
): string {
  return `var(--color-${catSlug(catId)}-${tier})`;
}

/** Build `color-mix(...)` for a cat color with alpha. Routes through the cat
 * token, so opacity overlays still follow Tuner-controlled gradient. */
export function catColorMix(
  catId: string | undefined,
  alpha: number,
  tier: 'primary' | 'surface' | 'bubble' = 'primary',
): string {
  const pct = Math.round(alpha * 100);
  return `color-mix(in srgb, ${catColorVar(catId, tier)} ${pct}%, transparent)`;
}
