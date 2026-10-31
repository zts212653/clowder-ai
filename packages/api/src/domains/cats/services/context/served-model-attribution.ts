/**
 * F319 Phase F: served-model attribution for cat-facing speaker labels.
 *
 * The `model_reroute` warning is a live UI event only; it is never persisted and
 * system messages are filtered out of prompt history. The durable fact is the
 * message's own `metadata.servedModel` (what the upstream declared it ran) next to
 * `metadata.model` (what we asked for). Every place that tells a cat "who said this"
 * appends this marker so a cat relying on e.g. an architecture review knows which
 * model actually wrote it.
 *
 * Unobserved (`servedModel` absent) and unknown requested model stay silent: an
 * honest unknown is not evidence of substitution (F319 R4).
 */

import { servedModelMatchesRequest } from '../agents/providers/codex-served-model.js';
import type { StoredMessage } from '../stores/ports/MessageStore.js';

type AttributableMessage = Pick<StoredMessage, 'catId' | 'metadata'>;

/** Upper bound for the served-model id inside a prompt speaker header (real slugs are ~20 chars). */
const SERVED_MODEL_DISPLAY_MAX = 64;
/** Anything outside a model-slug alphabet (incl. `[`/`]`, newlines, control chars) is replaced. */
const NON_SLUG_CHARS = /[^A-Za-z0-9._:/@+-]+/g;

/**
 * `servedModel` is an upstream-supplied string (`response.model`) that lands inside a cat's
 * prompt speaker header `[time speaker]`. Restrict it to a model-slug alphabet and a bounded
 * length so it can never close the header or start a forged line (sol R1 P1).
 */
function sanitizeServedModelForPrompt(raw: string): string {
  const slug = raw.replace(NON_SLUG_CHARS, '?');
  return slug.length > SERVED_MODEL_DISPLAY_MAX ? `${slug.slice(0, SERVED_MODEL_DISPLAY_MAX - 1)}…` : slug;
}

/** Returns ` ⚠上游实际应答=<servedModel>` when the upstream served a different model, else ''. */
export function servedModelMarker(msg: AttributableMessage): string {
  if (msg.catId === null) return '';
  const requested = msg.metadata?.model?.trim();
  const served = msg.metadata?.servedModel?.trim();
  if (!requested || !served) return '';
  // Compare on the raw values; only the rendered form is sanitized.
  if (servedModelMatchesRequest(requested, served)) return '';
  return ` ⚠上游实际应答=${sanitizeServedModelForPrompt(served)}`;
}
