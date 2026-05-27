/**
 * F212 Phase A — Sanitize raw CLI stderr / stream error text before exposing to users or logs.
 *
 * Order matters: structured blobs (JWT/PEM) before token regex, specific tokens before generic,
 * known path redactions before high-entropy fallback (temp HOME paths can look token-like),
 * high-entropy fallback last.
 *
 * KD-2 contract: this function does NOT truncate. Callers truncate AFTER calling sanitize.
 * That way mid-token truncation cannot bypass the blacklist (AC-A3).
 */

import { getPathPatterns, SANITIZER_PATTERNS } from './cli-error-patterns.js';

/**
 * Rough Shannon-style entropy estimate (unique chars over total).
 * High-entropy threshold tuned empirically: a 32-char string with ≥50% unique chars
 * is very likely a token, not English prose.
 */
function looksHighEntropy(s: string): boolean {
  if (s.length < 32) return false;
  const unique = new Set(s).size;
  return unique / s.length >= 0.5 && unique >= 16;
}

export function sanitizeCliStderr(input: string): string {
  if (!input) return '';

  // 1. NFKC normalize (defeat fullwidth/homograph token bypass — e.g. U+FF53 ｓ → ASCII s)
  let out = input.normalize('NFKC');

  // 2. Control sequences (clean output noise, not security-critical but improves readability)
  out = out.replace(SANITIZER_PATTERNS.ansiCsi, '');
  out = out.replace(SANITIZER_PATTERNS.osc, '');

  // 3. Structured secret blobs (JWT/PEM — must come before piecewise token regex)
  out = out.replace(SANITIZER_PATTERNS.jwt, '[JWT_REDACTED]');
  out = out.replace(SANITIZER_PATTERNS.pem, '[PEM_REDACTED]');

  // 4. Cookie headers (before URL query — `Set-Cookie: foo=bar; ...` could contain `=` mistaken as KV)
  out = out.replace(SANITIZER_PATTERNS.cookieHeader, (_match, name: string) => `${name}: [COOKIE_REDACTED]`);

  // 5. URL query strings
  out = out.replace(SANITIZER_PATTERNS.urlQuery, '$1[QUERY_REDACTED]');

  // 6. Provider tokens (specific first to avoid generic pattern eating prefix)
  out = out.replace(SANITIZER_PATTERNS.openaiAnthropic, '[TOKEN_REDACTED]');
  out = out.replace(SANITIZER_PATTERNS.githubPat, '[TOKEN_REDACTED]');
  out = out.replace(SANITIZER_PATTERNS.githubClassic, '[TOKEN_REDACTED]');
  out = out.replace(SANITIZER_PATTERNS.npmToken, '[TOKEN_REDACTED]');
  out = out.replace(SANITIZER_PATTERNS.googleAIza, '[TOKEN_REDACTED]');
  out = out.replace(SANITIZER_PATTERNS.bearer, 'Bearer [TOKEN_REDACTED]');

  // 7. Generic key=value pattern: `"api_key": "xxx"`, `token=xxx`, `password: xxx`
  //    Preserve the key name + delimiter, redact the value.
  out = out.replace(
    SANITIZER_PATTERNS.genericTokenKv,
    (_full, key: string, delim: string) => `${key}${delim}[TOKEN_REDACTED]`,
  );

  // 8. Paths before high-entropy fallback. Test sandboxes often use random HOME
  //    segments; if entropy runs first, HOME paths become opaque [REDACTED]
  //    instead of the user-friendly ~/ form.
  const paths = getPathPatterns();
  if (paths.homeUnix) out = out.replace(paths.homeUnix, '~');
  if (paths.userProfileWin) out = out.replace(paths.userProfileWin, '~');
  out = out.replace(SANITIZER_PATTERNS.winUserPath, '~');
  out = out.replace(SANITIZER_PATTERNS.tmpPath, '/tmp/[REDACTED]');

  // 9. High-entropy fallback (last-resort for anything that survived above)
  out = out.replace(SANITIZER_PATTERNS.highEntropy, (m: string) => (looksHighEntropy(m) ? '[REDACTED]' : m));

  return out;
}
