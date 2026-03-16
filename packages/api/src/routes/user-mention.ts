/**
 * F057-C2: Detect owner (@user / @铲屎官 / configured) mention at line start.
 *
 * Same convention as cat @mentions: line-start only, code blocks stripped.
 * OQ-1 + R2-P2: Token boundary — reject ASCII letter/digit/underscore continuation
 * (e.g. @user123, @username) but allow CJK text (e.g. @user请看, @铲屎官请看).
 *
 * F067 owner-config: patterns read from cat-config.json owner.mentionPatterns,
 * with @user/@铲屎官 always included as backward-compat defaults.
 */

import { getOwnerMentionPatterns } from '../config/cat-config-loader.js';

/** Reject if followed by ASCII word character (letter/digit/underscore) */
const CONTINUATION_RE = /^[a-zA-Z0-9_]/;

export function detectUserMention(text: string): boolean {
  const patterns = getOwnerMentionPatterns();
  // Strip fenced code blocks
  const stripped = text.replace(/```[\s\S]*?```/g, '');
  const lines = stripped.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trimStart().toLowerCase();
    for (const pattern of patterns) {
      if (trimmed.startsWith(pattern)) {
        const rest = trimmed.slice(pattern.length);
        if (!CONTINUATION_RE.test(rest)) return true;
      }
    }
  }
  return false;
}
