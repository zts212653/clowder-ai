/**
 * F167 harness — strip trailing cat signature paragraphs before final-routing-slot
 * extraction. Shared by verdict-detect (AC-C7) and void-hold-detect (Phase I,
 * AC-I1~I3 + 2026-06-20 verdict): both detectors are slot-scoped, and both
 * have to ignore the trailing `[昵称/模型🐾]` block per L0 identity rule so the
 * slot picker doesn't terminate on the signature line.
 *
 * Extracted from `verdict-detect.ts` (originally landed in PR #2314 R6 P1
 * after cloud round-4 + 砚砚 narrowing). Re-using a single source-of-truth
 * regex + walker avoids the "fix in one place, miss the other" failure mode
 * (cloud P2 on PR #2440 was a parallel example of partial-migration risk).
 *
 * Cat signature shapes:
 *   - Pawed slashed:   `[昵称/变体🐾]`  — e.g. `[宪宪/Opus-46🐾]`, `[砚砚/GPT-5.5🐾]`
 *   - Pawed slashless: `[昵称🐾]`        — e.g. `[Spark🐾]`, `[烁烁🐾]`
 *   - Legacy un-pawed slashed: `[昵称/变体]` — e.g. `[砚砚/GPT-5.5]` /
 *     `[宪宪/Opus-46]` / `[宪宪/Sonnet]` / `[砚砚/Codex]` / `[烁烁/Gemini-25]`.
 *     Canonical un-pawed variants documented in
 *     `cat-cafe-skills/refs/commit-signatures.md`; all real cat nicknames are
 *     CJK (Chinese) characters: 宪宪 / 砚砚 / 烁烁.
 *
 * NOT a signature:
 *   - `[Phase B]` / `[note]` / `[LGTM]` — body tokens (no paw, no slash).
 *   - `[packages/api/src/foo.ts]` / `[src/index.ts]` / `[node_modules/foo/bar]`
 *     — bracketed file-path references. Multi-slash paths excluded by the
 *     "exactly one slash" rule; single-slash paths excluded when the bracket
 *     content ends in a known source/asset/doc file extension.
 *   - `[packages/api]` / `[docs/features]` — bare directory refs (single
 *     slash, no model name on RHS). 砚砚 R3 P2 boundary.
 *   - `[PR/2442]` / `[issue/123]` / `[F167/Phase2]` / `[release/v2]` — common
 *     terminal references where RHS is a digit/version but NOT a model name.
 *     砚砚 R5 P2 boundary.
 *   - `[openai/GPT-5.5]` / `[anthropic/Claude]` / `[google/Gemini-25]` /
 *     `[docs/Sonnet]` / `[models/Opus-4.7]` / `[api/Codex]` / `[apache/Spark]`
 *     — provider/path-on-LHS refs where RHS happens to match a model name.
 *     砚砚 R6 P2 boundary — earlier rule "RHS allowlist alone" was too loose;
 *     LHS positive-identification now also required.
 *   - `[模型/GPT-5.5]` / `[文档/Sonnet]` / `[供应商/Claude]` / `[路径/Opus-4.7]` /
 *     `[章节/Pro]` / `[发布/Gemini-25]` / `[工具/Codex]` — Chinese semantic
 *     labels on LHS where RHS happens to match a model name. 砚砚 R7 P2
 *     boundary — broad CJK regex `^[一-鿿]+$` admitted any Chinese word as
 *     a "cat nickname", recreating the C2/verdict FP class. LHS is now a
 *     precise allowlist sourced directly from commit-signatures.md.
 *
 * Decision rule (function form so the layered checks stay readable):
 *   1. Pawed (ends in `🐾`) → signature.
 *   2. Slashless without paw → not a signature (body token).
 *   3. Multi-slash content → not a signature (deep path).
 *   4. Single-slash + file-extension tail → not a signature (path).
 *   5. Single-slash + LHS in precise cat-nickname allowlist (`宪宪`, `砚砚`,
 *      `烁烁` — sourced from commit-signatures.md) AND RHS matches model-name
 *      allowlist (capital-first `Opus`, `Sonnet`, `Codex`, `GPT`, `Spark`,
 *      `Gemini`, `Claude`, `Fable`, `Haiku`, `Pro` + optional `.`/`-` version
 *      tail) → legacy un-pawed signature. Two-sided precise allowlist keeps
 *      both signature shape AND broad-shape FPs out.
 *   6. Otherwise → not a signature.
 *
 * Provenance ladder:
 *   - R3 P2 (砚砚): rule 5 = single-slash + digit-in-RHS
 *   - R4 P2 (cloud): rule 5 split into 5a (digit) + 5b (allowlist)
 *   - R5 P2 (砚砚): 5a was too loose (admitted `[PR/2442]` etc.) → drop 5a,
 *     keep 5b allowlist
 *   - R6 P2 (砚砚): RHS allowlist alone leaked `[openai/GPT-5.5]` etc. → add
 *     LHS CJK positive identification, both sides must qualify
 *   - R7 P2 (砚砚): broad CJK admitted `[模型/GPT-5.5]` etc. (any Chinese
 *     semantic label) → pin LHS to precise cat-nickname allowlist from
 *     commit-signatures.md. When new cats join with un-pawed slashed
 *     signatures, update the source-of-truth doc AND this allowlist together.
 */

const PAW_SIGNATURE_LINE_RE = /^\s*\[[^[\]\n]+🐾\]\s*$/u;
const SINGLE_SLASH_LINE_RE = /^\s*\[([^[\]\n]+)\]\s*$/u;

// Conservative extension list. Picked because:
//   - Cover the common source/asset/doc extensions used in this repo's bracketed
//     path references (.ts / .mjs / .md / .json / .yaml / .yml / .js / .tsx).
//   - Exclude single-character / digit tails like `.5` or `.7` that model names
//     use (`GPT-5.5`, `Opus-4.7`) — those would not be in this list, so they
//     still pass the signature check.
//   - Doesn't try to enumerate every possible file extension — better to false
//     negative on an unusual file path (treat it as signature, strip it) than
//     to false positive on a model name (treat signature as path, leave it).
const FILE_EXTENSION_TAIL_RE =
  /\.(?:ts|mjs|js|md|json|yaml|yml|tsx|jsx|cjs|mts|cts|py|sh|css|html|svg|png|jpg|jpeg|gif|webp|toml|sql|go|rs|kt|java|cpp|hpp|c|h)$/i;

// LHS allowlist — precise cat nickname set sourced directly from
// `cat-cafe-skills/refs/commit-signatures.md`. Three documented un-pawed
// slashed signature nicknames as of PR #2442:
//   - 宪宪 (布偶猫/Ragdoll)              — U+5BAA U+5BAA
//   - 砚砚 (缅因猫/Maine Coon, codex/gpt) — U+781A U+781A
//   - 烁烁 (暹罗猫/Siamese)              — U+70C1 U+70C1
//
// Earlier rounds tried broad-shape regexes (`/^[一-鿿]+$/u` for any CJK,
// `^Capital-first allowlist$` for any model-name LHS) and both classes
// leaked FPs — Chinese semantic labels like `模型` / `文档` / `供应商`
// got admitted as "cat nicknames" (砚砚 R7 P2). Precise allowlist is the
// only structurally stable boundary: anything not literally in this set
// is not a cat nickname.
//
// When a new cat joins with an un-pawed slashed signature shape, update
// BOTH `commit-signatures.md` AND this regex together. Pawed signatures
// (`[新猫🐾]` / `[新猫/Model🐾]`) flow through rule 1 and never need
// allowlist updates.
const KNOWN_CAT_NICKNAME_LHS_RE = /^(?:宪宪|砚砚|烁烁)$/u;

// RHS allowlist — single-slash un-pawed signatures must end in one of these
// known model name prefixes (capital-first), optionally followed by a `.`/`-`
// version tail. Source-of-truth: `cat-cafe-skills/refs/commit-signatures.md`
// model variant list.
const KNOWN_MODEL_NAME_RHS_RE = /^(?:Opus|Sonnet|Codex|GPT|Spark|Gemini|Claude|Fable|Haiku|Pro)(?:[-.][\w.-]+)?$/;

/**
 * Public regex retained for compatibility with downstream tests / probes; it
 * captures the most common case (pawed signatures) without the legacy
 * un-pawed branch. Logic-bearing callers should use `isCatSignatureLine`.
 */
export const CAT_SIGNATURE_LINE_RE = PAW_SIGNATURE_LINE_RE;

/**
 * For a single-slash bracket content, returns the (lhs, rhs) split when the
 * bracket plausibly represents a legacy un-pawed signature — i.e. exactly one
 * slash and no file-extension tail. Returns null when the structure
 * disqualifies (multi-slash or extension path). Centralizing the structural
 * checks here keeps `isCatSignatureLine` simple (Biome cognitive complexity).
 */
function extractLegacySignatureSides(inner: string): { lhs: string; rhs: string } | null {
  let slashIdx = -1;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] !== '/') continue;
    if (slashIdx !== -1) return null; // multi-slash → not a signature (rule 3)
    slashIdx = i;
  }
  if (slashIdx === -1) return null; // slashless without paw → not a signature
  if (FILE_EXTENSION_TAIL_RE.test(inner)) return null; // rule 4
  return { lhs: inner.slice(0, slashIdx), rhs: inner.slice(slashIdx + 1) };
}

/**
 * Returns true iff the line is recognized as a trailing cat signature per the
 * decision rule documented in the module header. See the rule list for the
 * layered checks; structural disqualification is delegated to
 * `extractLegacySignatureSides` to keep cognitive complexity low.
 */
export function isCatSignatureLine(line: string): boolean {
  if (PAW_SIGNATURE_LINE_RE.test(line)) return true; // rule 1
  const singleSlashMatch = SINGLE_SLASH_LINE_RE.exec(line);
  if (!singleSlashMatch) return false;
  const inner = singleSlashMatch[1] ?? '';
  const sides = extractLegacySignatureSides(inner);
  if (sides === null) return false;
  // Rule 5: both LHS (cat nickname, CJK) AND RHS (model name, allowlist + tail)
  // must positive-identify. One-sided check leaks provider/path FPs.
  return KNOWN_CAT_NICKNAME_LHS_RE.test(sides.lhs) && KNOWN_MODEL_NAME_RHS_RE.test(sides.rhs);
}

/**
 * Strip trailing cat-signature paragraphs (and blank lines) so the slot picker
 * lands on the last *content* paragraph. Body brackets that happen to look
 * signature-shaped are preserved — only TRAILING lines that satisfy
 * `isCatSignatureLine` are stripped.
 *
 * Iterates from the last line backwards: blank lines and signature lines are
 * dropped; the first non-empty, non-signature line stops the walk.
 */
export function stripTrailingCatSignatures(text: string): string {
  if (!text) return text;
  const lines = text.split(/\r?\n/);
  let lastContentIdx = lines.length - 1;
  while (lastContentIdx >= 0) {
    const line = lines[lastContentIdx] ?? '';
    if (line.trim() === '' || isCatSignatureLine(line)) {
      lastContentIdx--;
      continue;
    }
    break;
  }
  if (lastContentIdx < 0) return '';
  return lines.slice(0, lastContentIdx + 1).join('\n');
}
