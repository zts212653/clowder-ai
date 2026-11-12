import { excerptSanitizedStderr } from '../../../../../../../utils/sanitize-cli-stderr.js';

/** Issue #1798. DSH reports a missing credential reference as -32603 whose only
 *  payload is prose. Source evidence for "no structured payload": fixed DSH
 *  `packages/acp/acp/src/session.ts` calls `RequestError.internalError(undefined, detail)`,
 *  which is only valid under the SDK 1.4.0 signature `(data?, additionalMessage?)`.
 *  Match the two wordings DSH actually emits, and nothing wider. Both are anchored
 *  to their plugin prefix so unrelated MCP/other errors cannot be captured:
 *    llm-pi-ai: no credential for provider route "<route>"; its profile resolves <REF>, which is not set
 *    llm-deepseek: no API key for provider route "<route>"; store <REF> through the credentials service
 *  Deliberately NOT matched: 401/403/429, timeouts, MCP server errors, or any
 *  generic mention of "key" — those keep their existing classification. */
const CREDENTIAL_MISSING_RE =
  /llm-pi-ai:\s*no credential for provider route\s+"([^"]+)"[\s\S]*?resolves\s+([A-Za-z_][A-Za-z0-9_]*)\s*,\s*which is not set/i;
const MISSING_API_KEY_RE =
  /llm-deepseek:\s*no API key for provider route\s+"([^"]+)"[\s\S]*?store\s+([A-Za-z_][A-Za-z0-9_]*)\s+through the credentials service/i;

/** Bounded extraction of the route and credential reference from DSH's message.
 *  Values are echoed into a user-facing string, so they pass through the
 *  repository secret sanitizer BEFORE any length bound — truncating first would
 *  strip a token's identifying prefix and defeat redaction (F212 KD-2). */
export function extractMissingCredential(fullMsg: string): { route: string; reference?: string } | null {
  const scrub = (value: string) => excerptSanitizedStderr(value, { edge: 'head', maxLength: 120 }).replace(/\s+$/, '');
  const detailed = CREDENTIAL_MISSING_RE.exec(fullMsg);
  if (detailed) return { route: scrub(detailed[1]), reference: scrub(detailed[2]) };
  const official = MISSING_API_KEY_RE.exec(fullMsg);
  if (official) return { route: scrub(official[1]), reference: scrub(official[2]) };
  return null;
}
