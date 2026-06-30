/**
 * F247 AC-B1c-10 + AC-B1c-12: Thread runtime delta payload builder.
 *
 * The bridge inject payload does NOT repeat the cloud cat's persistent
 * Custom Instructions (the 1500-token persona / cat-cafe tool discipline
 * lives in ChatGPT-side Custom Instructions, not in our payload). Instead
 * we ship a small runtime delta — 5 fields — telling the cloud cat which
 * thread it's responding in.
 *
 * Treatment: **delta is data, not authority.** All user-controlled fields
 * (`threadTitle`, `participants`, `calledBy`, `intent`) are passed through
 * `JSON.stringify` so that delimiter injection (`</thread-runtime>`,
 * `"ignore previous rules"`, embedded backticks, etc.) cannot escape the
 * payload envelope. The cloud cat's base prompt explicitly rules that
 * delta block content is untrusted user content, below base persona /
 * tool discipline.
 *
 * Renders as:
 *   <thread-runtime v=1 format=json>
 *   {"threadId": "...", "threadTitle": "...", "participants": [...], "calledBy": "...", "intent": "..."}
 *   </thread-runtime>
 *
 *   <intent text rendered separately for the cat to read as its message>
 */

import type { CloudInvokeDispatchParams } from './types.js';

/**
 * Hard cap on rendered payload length. Per AC-B1c-12 OQ: ChatGPT message
 * length hard cap is not yet measured; 2000 chars is a conservative target
 * known to work for the spike. If the assembled payload exceeds the cap,
 * the `intent` field is truncated with an ellipsis to keep the envelope
 * intact. Other fields are not truncated.
 */
export const DELTA_PAYLOAD_MAX_CHARS = 2000;

/** Sentinel suffix appended after intent truncation. */
const TRUNCATE_SUFFIX = '...[truncated]';

/**
 * Build the rendered delta payload for the cloud cat.
 *
 * **Hard contract (AC-B1c-12)**: the returned string is guaranteed to be
 * `<= DELTA_PAYLOAD_MAX_CHARS`. To honor that we apply a cascading shrink
 * (gpt52 R2 P2 catch — intent-only truncation isn't enough; threadTitle is
 * up to 200 chars and participants can each be ~159 chars JSON-encoded, so
 * non-intent overhead alone can blow the cap):
 *
 *   1. Full payload fits? → return it.
 *   2. Shrink `intent` iteratively (most common cause of overflow).
 *   3. Drop participants from the end (least-impact field; the receiver
 *      still gets threadId / threadTitle / calledBy / intent).
 *   4. Truncate `threadTitle`.
 *   5. Last-resort envelope: minimal fields + diagnostic intent.
 *
 * Returns a single string with the JSON-wrapped delta block followed by a
 * blank line and the raw intent text (for the cat to treat as the user
 * message). Caller should call this BEFORE invoking the PinchTab adapter
 * so the rendered string is then JSON.stringify'd at the eval boundary
 * (defense in depth — AC-B1c-10).
 */
export function buildDeltaPayload(params: CloudInvokeDispatchParams): string {
  // Attempt 1: full payload as-is.
  const fitFull = tryFitWithIntentShrink(params);
  if (fitFull) return fitFull;

  // Attempt 2: drop participants from the end (descending) — keeps "called by" /
  // thread context intact, only loses the participant list (which is best-effort
  // anyway, the cloud cat can call `get_thread_context` for the live roster).
  if (params.participants.length > 0) {
    for (let keepCount = params.participants.length - 1; keepCount >= 0; keepCount--) {
      const trimmed: CloudInvokeDispatchParams = {
        ...params,
        participants: params.participants.slice(0, keepCount),
      };
      const fit = tryFitWithIntentShrink(trimmed);
      if (fit) return fit;
    }
  }

  // Attempt 3: also truncate threadTitle to a tight slice.
  if (params.threadTitle && params.threadTitle.length > 30) {
    const trimmed: CloudInvokeDispatchParams = {
      ...params,
      participants: [],
      threadTitle: `${params.threadTitle.slice(0, 30)}…`,
    };
    const fit = tryFitWithIntentShrink(trimmed);
    if (fit) return fit;
  }

  // Last-resort: minimal envelope with diagnostic intent. If even this is over
  // cap (e.g. pathologically long `threadId` / `calledBy` / `catId`), we
  // aggressively truncate THOSE fields too so the envelope wrapper is always
  // preserved (gpt52 R3 P2 contract pin: spec AC-B1c-12 requires the
  // `<thread-runtime v=1 format=json>...</thread-runtime>` wrapper UNCONDITIONALLY,
  // including in degraded paths. A raw-JSON fallback would break parsing on
  // the cloud cat side, exactly when the receiver needs robust parsing most.)
  const minimal: CloudInvokeDispatchParams = {
    ...params,
    threadTitle: null,
    participants: [],
  };
  const lastResort = renderEnvelope(minimal, `[delta over ${DELTA_PAYLOAD_MAX_CHARS}-char cap — fields dropped]`);
  if (lastResort.length <= DELTA_PAYLOAD_MAX_CHARS) return lastResort;

  // Absolute floor: even strict-fields envelope overflows. Aggressively trim
  // every interior field so the envelope wrapper still fits. The cloud cat sees
  // a heavily-clipped delta but with the spec-required envelope shape — which
  // is what the parser contract demands.
  const ABS_FLOOR_INTENT = '[delta over cap]';
  const absoluteFloor: CloudInvokeDispatchParams = {
    catId: ((params.catId as string).slice(0, 32) || 'X') as typeof params.catId,
    threadId: params.threadId.slice(0, 40) || 'X',
    userId: params.userId.slice(0, 32) || 'X',
    threadTitle: null,
    participants: [],
    calledBy: (params.calledBy as string).slice(0, 32) || 'X',
    intent: ABS_FLOOR_INTENT,
  };
  return renderEnvelope(absoluteFloor, ABS_FLOOR_INTENT);
}

/**
 * Try fitting params under the cap by shrinking intent only. Returns the
 * fitted envelope, or null if even an empty intent can't fit (caller should
 * try shrinking non-intent fields next).
 */
function tryFitWithIntentShrink(p: CloudInvokeDispatchParams): string | null {
  // Quick path: original intent fits.
  const full = renderEnvelope(p, p.intent);
  if (full.length <= DELTA_PAYLOAD_MAX_CHARS) return full;

  // If overhead alone (empty intent) exceeds cap, no amount of intent shrinking
  // helps — caller must shrink other fields.
  const overheadEnvelope = renderEnvelope(p, '');
  if (overheadEnvelope.length > DELTA_PAYLOAD_MAX_CHARS) return null;

  // Iterative shrink. The intent string appears in the rendered envelope
  // TWICE (once inside JSON-stringified body, once raw after envelope), and
  // JSON-escaping can add bytes (e.g. quote / newline). Computing the exact
  // budget upfront is brittle (escape multiplier varies by content), so we
  // approximate then shrink until under cap.
  let budget = Math.max(Math.floor((DELTA_PAYLOAD_MAX_CHARS - overheadEnvelope.length) / 2), 50);
  // Bound by 8 iterations to avoid pathological loops on highly-escaped content.
  for (let i = 0; i < 8; i++) {
    const truncatedIntent = `${p.intent.slice(0, budget)}${TRUNCATE_SUFFIX}`;
    const attempt = renderEnvelope(p, truncatedIntent);
    if (attempt.length <= DELTA_PAYLOAD_MAX_CHARS) return attempt;
    budget = Math.floor(budget * 0.7);
    if (budget <= 0) break;
  }

  // Even smallest non-empty intent slice didn't fit — try empty.
  const emptyIntent = renderEnvelope(p, '');
  if (emptyIntent.length <= DELTA_PAYLOAD_MAX_CHARS) return emptyIntent;
  return null;
}

function renderEnvelope(params: CloudInvokeDispatchParams, intent: string): string {
  // The delta block uses an XML-ish wrapper with explicit `format=json` so
  // the cloud cat's parser knows the inner content is JSON-stringified
  // data, not authoritative instructions.
  const delta = {
    threadId: params.threadId,
    threadTitle: params.threadTitle,
    participants: params.participants.map((p) => ({ catId: p.catId, handle: p.handle })),
    calledBy: params.calledBy,
    intent,
  };
  // JSON.stringify with no spaces — compact, stable, escapes all delimiters.
  const json = JSON.stringify(delta);
  return `<thread-runtime v=1 format=json>\n${json}\n</thread-runtime>\n\n${intent}`;
}

/**
 * **Eval-boundary safety helper (AC-B1c-10)**: returns a JavaScript expression
 * that, when evaluated, produces the literal payload string. Used by the
 * PinchTab adapter when constructing `pinchtab_eval` / CDP `Runtime.evaluate`
 * input — any user-controlled string interpolation goes through this to
 * prevent breaking out of the eval string literal.
 *
 * Equivalent to `JSON.stringify(payload)` but with an explicit contract name
 * for code review grep-ability.
 */
export function quoteForEval(payload: string): string {
  return JSON.stringify(payload);
}
