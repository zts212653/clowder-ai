import { basename, isAbsolute, relative, resolve } from 'node:path';

/**
 * Allowlist-resolve a user-supplied basename against an allowed directory.
 *
 * Rejects: empty / "." / ".." / path-separators / post-resolve escape.
 * Returns resolved absolute path on success.
 *
 * Shared between:
 * - manual-trigger/generate-now.ts (operator triggers eval cat to regenerate verdict)
 * - publish-verdict/publish-verdict.ts (eval cat publishes verdict via MCP)
 *
 * Both surfaces accept basenames inside harnessFeedbackRoot/{snapshots,attributions}/
 * and must reject path-traversal identically.
 */
export function resolveSafeRawPath(
  allowedDir: string,
  name: string,
): { ok: true; path: string } | { ok: false; reason: string } {
  if (!name || name === '.' || name === '..') {
    return { ok: false, reason: 'must be non-empty filename, not "." or ".."' };
  }
  if (basename(name) !== name) {
    return { ok: false, reason: 'must be simple basename (no path separators)' };
  }
  const absoluteAllowed = resolve(allowedDir);
  const resolved = resolve(absoluteAllowed, name);
  const rel = relative(absoluteAllowed, resolved);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, reason: 'resolved path escapes allowlist directory' };
  }
  return { ok: true, path: resolved };
}
