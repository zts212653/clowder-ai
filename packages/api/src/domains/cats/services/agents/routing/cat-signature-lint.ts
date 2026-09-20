/**
 * F257 修复清单 #4 — message-signature structural lint (O2→O1), detection layer.
 *
 * The trailing `[昵称/模型🐾]` signature is an L0 identity contract enforced only
 * by prompt text (O2 观测层): governance-l0 「用自己的身份签名 `[昵称/模型🐾]`,
 * 签名必须含模型型号」. dev-7a882ba0: Fable 漏签靠 operator 人工发现 — zero
 * structural coverage. This module upgrades the convention to a regex-decidable
 * structural assertion (O1 结构强制): does an agent message end with a
 * contract-shaped `[nickname/model🐾]` signature?
 *
 * STRICTNESS (sol R1 P1-3). This is a COMPLIANCE lint, so it asserts the current
 * contract shape — nickname + '/' + model + 🐾 — and does NOT reuse
 * `isCatSignatureLine` from `cat-signature-strip.ts`. That matcher is a
 * routing-STRIP matcher, permissive BY DESIGN (it also accepts pawed-slashless
 * `[Spark🐾]` and legacy un-pawed `[砚砚/GPT-5.5]` so historical routing suffixes
 * still get stripped). Reusing it as a compliance predicate produced false
 * negatives — model-less / paw-less signatures counted as compliant. The two
 * matchers are kept separate: strip = permissive (routing), lint = strict
 * (compliance). Scope split: presence-only (contract SHAPE present) — matching
 * the signature to the POSTING cat (identity-correctness) stays deferred.
 *
 * SCOPE — two-phase (F257 owner vision-guardian review 2026-07-20; AC 完成 ≠
 * feature 完成). This module + the persistence seams are the **detection layer**
 * (O1 structural detection, message-level observable). The harness **ledger
 * closure** — auto-emitting a deviation on miss, attributed to
 * `obj-identity-integrity` (automating the manual `report_harness_signal` that
 * recorded dev-7a882ba0) — is DEFERRED to after #3 (objective registry). Why
 * deferred: the ledger reads DeviationEventLog / GuardRejectionEventLog / eval
 * verdicts, NOT `message.extra`; a correct deviation needs a *registered*
 * objective (else it reintroduces the free-string-objective archaeology #3
 * fixes) + the segment/condition attribution infra of the #2/#3 data root.
 * `extra.signatureLint` is the interim detection observable — NOT the ledger
 * closure; do not read extra-only as "#4 complete".
 */

/**
 * Strict compliance matcher for the current signature contract `[昵称/模型🐾]`:
 * '[' + nickname + '/' + model + 🐾 + ']'. The FIRST slash delimits
 * nickname/model; the model MAY be provider-qualified — i.e. contain further
 * slashes (e.g. opencode's live `defaultModel: "codex-for-me/gpt-5.4"`), so the
 * model class does NOT exclude '/'. Both captured components must be NON-BLANK
 * after trim. Rejects `[Spark🐾]` (no model), `[砚砚/GPT-5.5]` (no paw), and
 * `[ /model🐾]` / `[nick/ 🐾]` (blank component) — forms the permissive strip
 * matcher tolerates or a naive single-slash regex would mis-handle (sol R4 P1).
 */
const STRICT_SIGNATURE_LINE_RE = /^\s*\[([^[\]\n/]+)\/([^[\]\n]+)🐾\]\s*$/u;

function isContractSignatureLine(line: string): boolean {
  const m = STRICT_SIGNATURE_LINE_RE.exec(line);
  if (!m) return false;
  // nickname (m[1], before first slash) and model (m[2], may be provider-qualified)
  // must both be non-blank after trim — the regex classes admit whitespace-only.
  return (m[1]?.trim().length ?? 0) > 0 && (m[2]?.trim().length ?? 0) > 0;
}

export interface SignatureLintResult {
  /** true iff the last non-blank line is a contract-shaped `[nickname/model🐾]` signature. */
  signed: boolean;
  /** the matched signature line (trimmed) when signed; null otherwise. */
  signatureLine: string | null;
}

const UNSIGNED: SignatureLintResult = { signed: false, signatureLine: null };

/**
 * Structurally lint whether `text` ends with a trailing contract-shaped
 * signature.
 *
 * Walks from the last line backwards skipping blank lines; the first non-blank
 * line decides. A signature that is NOT trailing (content follows it) does not
 * count — the L0 convention is that the signature is the final line.
 */
export function lintCatSignature(text: string): SignatureLintResult {
  if (!text) return UNSIGNED;
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue; // skip trailing blank lines
    return isContractSignatureLine(line) ? { signed: true, signatureLine: line.trim() } : UNSIGNED;
  }
  return UNSIGNED; // all-blank / empty
}

/**
 * Post-seam projection: the observe-only `extra.signatureLint` fragment for a
 * message. Empty for blank/whitespace content — pure-media posts carry no text
 * signature, so they get no lint verdict and stay out of the sign-rate
 * denominator. Spread into the message `extra` bag at every text-bearing
 * cat-final persistence seam (callback post + serial/parallel stream final).
 */
export function signatureLintExtra(text: string): { signatureLint?: { signed: boolean } } {
  if (!text.trim()) return {};
  return { signatureLint: { signed: lintCatSignature(text).signed } };
}

/**
 * Forward an already-computed lint verdict when a stored message's `extra` is
 * re-projected onto a broadcast / read-model payload (mirrors the web-side
 * `pickSignatureLint`). Kept as a 1-line forwarder so the (already large)
 * broadcast closures add no branch-complexity and the 4 broadcast sites stay
 * consistent (sol R4 P2).
 */
export function pickSignatureLint(extra: { signatureLint?: { signed: boolean } } | null | undefined): {
  signatureLint?: { signed: boolean };
} {
  return extra?.signatureLint ? { signatureLint: extra.signatureLint } : {};
}
