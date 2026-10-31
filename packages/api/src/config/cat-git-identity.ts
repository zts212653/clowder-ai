/**
 * Per-cat git author identity (W1: cats are Agents with identity).
 *
 * Background: the runtime git config pins `user.name` to a single cat, so every
 * commit's structured author field collapses to that one name regardless of which
 * cat actually wrote it (`git blame` / `git log --author` can't tell them apart).
 * This module derives a per-cat author name from the cat's breed + real model,
 * injected as GIT_AUTHOR_NAME / GIT_COMMITTER_NAME (env overrides git config).
 *
 * Email is intentionally NOT set here — it inherits the existing git config (the
 * operator's GitHub noreply account) so contribution-graph attribution stays on one
 * account while the *name* distinguishes the cat. (operator directive 2026-05-28)
 *
 * Model is the SAME source as the identity injected into the system prompt:
 * `getCatModel(catId)` (env CAT_{CATID}_MODEL override > runtime catRegistry), NOT
 * catId and NOT a local `catConfig.defaultModel` copy. catId is a stable logical
 * handle that can lag the model (opus-45 runs claude-opus-4-8); the worktree catalog
 * is a dev copy that lags the runtime catalog. Using getCatModel keeps the git author
 * name consistent with "model=..." in the system-prompt identity line.
 * (operator 2026-05-28: "看 claude code / anthropic 给你的模型身份")
 */

/**
 * Cats whose catalog `family`/`breedId` is NOT a real breed slug and must be remapped.
 * opus-47 is modeled as its own breed (family: "opus-47") but is really a Ragdoll
 * trial variant. Keyed by catId so it is independent of the dirty value.
 */
const BREED_BY_CAT_ID_OVERRIDE: Readonly<Record<string, string>> = {
  'opus-47': 'ragdoll',
};

/** Model-family segments that read better fully uppercased than title-cased. */
const MODEL_ACRONYMS: ReadonlySet<string> = new Set(['gpt', 'glm', 'llm']);

/** kebab-case breed slug → PascalCase (ragdoll → Ragdoll, maine-coon → MaineCoon). */
function toPascalBreed(breedSlug: string): string {
  return breedSlug
    .split('-')
    .filter((seg) => seg.length > 0)
    .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
    .join('');
}

/** Capitalize one model segment: acronyms upper-cased, others title-cased; digits untouched. */
function capitalizeModelSegment(seg: string): string {
  if (seg.length === 0) return seg;
  if (MODEL_ACRONYMS.has(seg.toLowerCase())) return seg.toUpperCase();
  if (!/[a-zA-Z]/.test(seg)) return seg; // pure version segment like "4.8"
  return seg.charAt(0).toUpperCase() + seg.slice(1);
}

/**
 * Turn a raw model string into a compact human label.
 *   claude-opus-4-8        => Opus-4.8
 *   claude-sonnet-4-6      => Sonnet-4.6
 *   gpt-5.4                => GPT-5.4
 *   gpt-5.3-codex          => GPT-5.3-codex
 *   gemini-3.1-pro-preview => Gemini-3.1-pro-preview
 *   z-ai/glm-4.7           => GLM-4.7
 *   anthropic/claude-opus-4-6 => Opus-4.6
 */
export function prettifyModel(model: string): string {
  let s = model.trim();
  if (!s) return '';
  s = s.split('/').pop() ?? s; // drop provider/namespace path prefix
  s = s.replace(/-\d{8}$/, ''); // drop YYYYMMDD date suffix (e.g. -20251101)
  s = s.replace(/^(claude|anthropic)-/, ''); // drop vendor prefix word
  s = s.replace(/(\d)-(\d)/g, '$1.$2'); // version dashes between digits -> dots (4-8 -> 4.8)
  // Only the leading family segment is capitalized; trailing tags (codex, pro,
  // preview, spark...) keep their original casing to match how models are written.
  const segs = s.split('-');
  return [capitalizeModelSegment(segs[0] ?? ''), ...segs.slice(1)].join('-');
}

/**
 * Strip ONLY characters that genuinely corrupt a git author name: angle brackets
 * break the "Name <email>" format, and control characters (including newlines) break
 * the commit header line. Everything else is preserved — git author names legally hold
 * square brackets etc., so a model tag such as claude-opus-4-6[1m] survives intact
 * (砚砚 review P2, runtime-verified). Implemented char-by-char rather than a regex
 * carrying literal control bytes, so this source file stays plain ASCII text and never
 * degrades into a git binary blob (砚砚 re-review).
 */
function sanitizeIdentitySegment(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '<') continue;
    if (ch === '>') continue;
    if (code < 0x20 || code === 0x7f) continue;
    out += ch;
  }
  return out;
}

/**
 * Resolve a per-cat git author name: `{Breed}-{PrettyModel}`
 * (e.g. "Ragdoll-Opus-4.8", "MaineCoon-GPT-5.4").
 *
 * `breedId` is whatever CatConfig.breedId holds — ideally a cat-breed slug (ragdoll,
 * maine-coon), but the runtime roster also has provider-named breeds for newer cats
 * (kimi->moonshot, qwen->qwen, deepseek->deepseek, opencode-*). We PascalCase it as-is
 * and de-dup when the model label already leads with the same word, so we never emit
 * "Qwen-Qwen3.6-...". Normalizing those provider-breeds into real cat-breeds is a
 * catalog-data concern tracked separately — not this module's job. (砚砚 review P1)
 *
 * @param catId  stable logical handle (used only for the opus-47 breed override)
 * @param breedId breed/family slug from CatConfig.breedId
 * @param model  the REAL model from getCatModel(catId) — same source as system-prompt identity
 * Falls back to the catId when model/breed are unavailable.
 */
export function resolveCatGitAuthorName(catId: string, breedId: string | undefined, model: string | undefined): string {
  const safeCatId = sanitizeIdentitySegment(catId);
  const breedSlug = BREED_BY_CAT_ID_OVERRIDE[catId] ?? (breedId?.trim() || undefined);
  const breed = breedSlug ? toPascalBreed(breedSlug) : undefined;
  const modelPart = model?.trim() ? prettifyModel(model) : safeCatId;
  if (!breed) {
    return sanitizeIdentitySegment(modelPart);
  }
  // De-dup: provider-named breeds (qwen, deepseek) collide with the model label's leading
  // family segment, so drop the redundant prefix instead of "Qwen-Qwen3.6-max-preview".
  if (modelPart.toLowerCase().startsWith(breed.toLowerCase())) {
    return sanitizeIdentitySegment(modelPart);
  }
  return sanitizeIdentitySegment(`${breed}-${modelPart}`);
}

/**
 * Build the git identity env overrides for a cat's CLI subprocess.
 * Sets author + committer name only — email inherits git config by design.
 */
export function buildCatGitIdentityEnv(
  catId: string,
  breedId: string | undefined,
  model: string | undefined,
): { GIT_AUTHOR_NAME: string; GIT_COMMITTER_NAME: string } {
  const name = resolveCatGitAuthorName(catId, breedId, model);
  return { GIT_AUTHOR_NAME: name, GIT_COMMITTER_NAME: name };
}
