/**
 * F235 KD-4: Community Issue Sanitizer — deny-list + fail-closed post-check.
 *
 * Defense-in-depth layer (NOT a complete declassifier). Primary safety comes
 * from the source adapter only emitting structured, safe fields — no raw
 * conversation text enters the public draft. This sanitizer is a secondary
 * safety net that catches known dangerous patterns in user-editable fields
 * (title, body markdown).
 *
 * Pure function. Scans title and body for known internal patterns, redacts
 * them with [redacted]. Post-check re-scans after redaction: if any pattern
 * survives, `passed = false` (fail-closed).
 *
 * Known patterns (deny-list — not exhaustive by design):
 *   threadId, userId, catId, invocationId, cardMessageId, Redis keys,
 *   callback tokens, session IDs, absolute paths, API keys, draft IDs,
 *   frustration issue IDs.
 *
 * Server re-sanitizes on publish (third defense layer: user edits could
 * re-introduce internal info).
 */

export interface SanitizeResult {
  readonly title: string;
  readonly bodyMarkdown: string;
  readonly redactedFields: readonly string[];
  readonly passed: boolean;
}

interface ForbiddenPattern {
  readonly regex: RegExp;
  readonly field: string;
}

/**
 * Ordered list of forbidden patterns. Each regex uses the `g` flag
 * so all occurrences are replaced in a single pass.
 */
const FORBIDDEN_PATTERNS: readonly ForbiddenPattern[] = [
  // Thread IDs
  { regex: /\bthread_[a-z0-9]+\b/gi, field: 'threadId' },
  // User IDs (prefixed + literal default-user)
  { regex: /\busr_[a-z0-9]+\b/gi, field: 'userId' },
  { regex: /\bdefault-user\b/gi, field: 'userId' },
  // Session IDs
  { regex: /\bsession_[a-z0-9]+\b/gi, field: 'sessionId' },
  // Frustration issue IDs
  { regex: /\bfi_[a-z0-9]+\b/gi, field: 'issueId' },
  // Community issue draft IDs
  { regex: /\bcid_[a-z0-9]+\b/gi, field: 'draftId' },
  // Message IDs
  { regex: /\bmsg_[a-z0-9]+\b/gi, field: 'messageId' },
  // Cat IDs (catId=xxx or catId: xxx assignments)
  { regex: /\bcatId[=:]\s*[a-z0-9][\w-]*/gi, field: 'catId' },
  // Invocation IDs (numeric timestamps used as invocation IDs)
  { regex: /\binvocationId[=:]\s*\d{13,19}\b/gi, field: 'invocationId' },
  // Timestamp-based invocation IDs (NNNNNNNNNNNNNNNN-NNNNNN-hex format)
  { regex: /\b\d{13,19}-\d{4,6}-[a-f0-9]{6,12}\b/gi, field: 'invocationId' },
  // Debug references
  { regex: /\bdebugRef[=:]\s*[a-z0-9][\w-]*/gi, field: 'debugRef' },
  // Redis key patterns
  { regex: /\b(?:frustration-issue|community-issue-draft|community-issue):[^\s,)}\]]+/gi, field: 'redisKey' },
  // Absolute paths (Unix — broad coverage of common filesystem roots)
  {
    regex:
      /\/(?:Users|home|tmp|var|opt|usr|etc|root|workspace|srv|mnt|run|proc|sys|nix|snap|lib|lib64|boot|media|build|dist)\/[^\s,)}\]'"]+/gi,
    field: 'absolutePath',
  },
  // Absolute paths (Windows drive letters: C:\Users\..., D:\Projects\...)
  { regex: /[A-Z]:\\[^\s,)}\]'"]+/g, field: 'absolutePath' },
  // UNC paths (\\server\share\...)
  { regex: /\\\\[^\s,)}\]'"]+/g, field: 'absolutePath' },
  // GitHub PAT tokens
  { regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, field: 'apiKey' },
  { regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, field: 'apiKey' },
  // Anthropic / OpenAI style keys (including hyphenated: sk-ant-xxx, sk-proj-xxx)
  { regex: /\bsk-[A-Za-z0-9_-]{20,}/g, field: 'apiKey' },
  // AWS access key IDs (audit-found gap)
  { regex: /\bAKIA[A-Z0-9]{16}\b/g, field: 'apiKey' },
  // JWT-like callback tokens (base64.base64 pattern)
  { regex: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, field: 'callbackToken' },
  // UUID-format callback credentials (e.g. callbackToken=<uuid>, token=<uuid>,
  // or standalone UUIDs — internal identifiers that shouldn't appear in public issues)
  { regex: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, field: 'callbackToken' },
];

function redactText(text: string, hits: Set<string>): string {
  let result = text;
  for (const pattern of FORBIDDEN_PATTERNS) {
    // Create a fresh regex each time (stateful `g` flag)
    const re = new RegExp(pattern.regex.source, pattern.regex.flags);
    if (re.test(result)) {
      hits.add(pattern.field);
      result = result.replace(new RegExp(pattern.regex.source, pattern.regex.flags), '[redacted]');
    }
  }
  return result;
}

/**
 * Sanitize title and body for community publication.
 *
 * @returns SanitizeResult with redacted content and pass/fail status.
 *   `passed = true` means no forbidden patterns remain after redaction.
 *   `passed = false` means content still contains suspicious patterns
 *   (fail-closed: caller should reject the publish).
 */
export function sanitize(title: string, bodyMarkdown: string): SanitizeResult {
  const hits = new Set<string>();

  const sanitizedTitle = redactText(title, hits);
  const sanitizedBody = redactText(bodyMarkdown, hits);

  // Fail-closed: re-scan after redaction to catch anything missed
  const postCheck = new Set<string>();
  redactText(sanitizedTitle, postCheck);
  redactText(sanitizedBody, postCheck);
  // If post-check finds new hits, something slipped through the first pass
  // (shouldn't happen with current regex, but defense-in-depth)
  const passed = postCheck.size === 0;

  return {
    title: sanitizedTitle,
    bodyMarkdown: sanitizedBody,
    redactedFields: [...hits],
    passed,
  };
}
