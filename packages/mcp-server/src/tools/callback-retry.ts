/**
 * Callback HTTP retry helpers
 */

const DEFAULT_RETRY_DELAYS_MS = [1000, 2000, 4000];

export interface CallbackPostFailure {
  error: string;
  retryable: boolean;
}

export type CallbackPostResult = { ok: true; data: unknown } | { ok: false; failure: CallbackPostFailure };

export function getRetryDelaysMs(): number[] {
  const raw = process.env['CAT_CAFE_CALLBACK_RETRY_DELAYS_MS'];
  if (!raw) return DEFAULT_RETRY_DELAYS_MS;
  const parsed = raw
    .split(',')
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value) && value >= 0);
  return parsed.length > 0 ? parsed : DEFAULT_RETRY_DELAYS_MS;
}

function shouldRetryStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * F174 Phase A: pull `reason` out of a callback_auth_failed JSON body and
 * format it as ` [reason=X]` for inclusion in the error message. Returns
 * empty string on any parse failure or unexpected shape — caller should
 * not depend on the marker existing.
 *
 * Exported so non-retry HTTP helpers (e.g. callback-tools.ts callbackGet)
 * can produce the same reason-tagged error format.
 */
export function extractReasonTag(text: string): string {
  try {
    const parsed = JSON.parse(text);
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.error === 'callback_auth_failed' &&
      typeof parsed.reason === 'string'
    ) {
      return ` [reason=${parsed.reason}]`;
    }
  } catch {
    /* not JSON — old API or other 401 shape, no reason tag */
  }
  return '';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function postJsonWithRetry(
  url: string,
  payload: string,
  retryDelaysMs: number[],
  extraHeaders?: Record<string, string>,
): Promise<CallbackPostResult> {
  let lastError = 'Callback failed';
  let retryable = true;

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...extraHeaders },
        body: payload,
      });

      if (response.ok) {
        return { ok: true, data: await response.json() };
      }

      const text = await response.text();
      // F174 Phase A: extract structured `reason` from 401 callback_auth_failed body
      // and tag it into the error message ([reason=X]) so downstream routing can
      // branch on a typed marker instead of regex-matching prose.
      const reasonTag = response.status === 401 ? extractReasonTag(text) : '';
      lastError = `Callback failed (${response.status})${reasonTag}: ${text}`;
      retryable = shouldRetryStatus(response.status);
      if (!retryable || attempt >= retryDelaysMs.length) {
        return { ok: false, failure: { error: lastError, retryable } };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lastError = `Callback request failed: ${message}`;
      retryable = true;
      if (attempt >= retryDelaysMs.length) {
        return { ok: false, failure: { error: lastError, retryable } };
      }
    }

    await sleep(retryDelaysMs[attempt]!);
  }

  return { ok: false, failure: { error: lastError, retryable } };
}
