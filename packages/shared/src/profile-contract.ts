/**
 * F231 profile addressing contract shared by the API compiler/repository and MCP clients.
 * Physical data-root resolution stays Node-side; this module only owns safe logical segments.
 */

export const CURRENT_RELATIONSHIP_PROFILE_URI = 'cat-cafe-profile://relationship/current' as const;
/** Phase E: canonical URI for the owner-wide shared corpus. */
export const CURRENT_CORPUS_PROFILE_URI = 'cat-cafe-profile://corpus/current' as const;
export const CURRENT_CAPSULE_PROFILE_URI = 'cat-cafe-profile://capsule/current' as const;
export const PROFILE_CAPSULE_RELATIVE_PATH = 'capsule.md' as const;
export const LEGACY_PROFILE_CAPSULE_RELATIVE_PATH = 'operator-capsule.md' as const;

/** A canonical file, including an empty file or tombstone, always shadows the old name. */
export function profileCapsuleReadRelativePath(exists: (relativePath: string) => boolean): string {
  return exists(PROFILE_CAPSULE_RELATIVE_PATH) ? PROFILE_CAPSULE_RELATIVE_PATH : LEGACY_PROFILE_CAPSULE_RELATIVE_PATH;
}
export const PROFILE_MEMORY_TOMBSTONE_PREFIX = '{"catCafeProfileTombstone":1,';
export const DEFAULT_PROFILE_USER_ID = 'default-user';
export const USER_CAPSULE_CHAR_LIMIT = 300;

/** Phase E: fixed relative path for the shared corpus file inside profiles/<userId>/. */
export const PROFILE_CORPUS_RELATIVE_PATH = 'corpus/shared-facts.md' as const;

/** Phase E: returns the fixed corpus relative path (pure function for symmetry with relationshipPrimerRelativePath). */
export function profileCorpusRelativePath(): string {
  return PROFILE_CORPUS_RELATIVE_PATH;
}

/**
 * Phase E: profileRevisionOf lives in ./profile-revision.ts (server-only, node:crypto).
 * Extracted because memory-cue.ts → this file is in the barrel's transitive closure,
 * and collective-client bundles for platform:'browser' which can't resolve node:crypto.
 * Import from '@cat-cafe/shared/profile-revision' for INV-4 canonical revision function.
 */

const PROFILE_PATH_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_PROFILE_USER_ID_LENGTH = 512;

export function assertProfilePathSegment(label: string, value: string): string {
  if (!PROFILE_PATH_SEGMENT_RE.test(value)) {
    throw new Error(
      `Invalid ${label} "${value}". Expected 1-128 characters matching ${PROFILE_PATH_SEGMENT_RE.source}`,
    );
  }
  return value;
}

export function profileUserRelativePath(userId: string): string {
  if (userId.length === 0 || userId.length > MAX_PROFILE_USER_ID_LENGTH) {
    throw new Error(`Invalid userId length ${userId.length}; expected 1-${MAX_PROFILE_USER_ID_LENGTH} characters`);
  }
  const encoded =
    PROFILE_PATH_SEGMENT_RE.test(userId) && userId !== '.' && userId !== '..' ? userId : encodeURIComponent(userId);
  if (!encoded || encoded === '.' || encoded === '..' || encoded.includes('/')) {
    throw new Error(`Invalid userId "${userId}" for profile path encoding`);
  }
  return `profiles/${encoded}`;
}

export function relationshipPrimerRelativePath(relationshipKey: string): string {
  return `relationship/${assertProfilePathSegment('relationshipKey', relationshipKey)}-primer.md`;
}

export function relationshipKeyFromPrimerRelativePath(targetPath: string): string {
  const normalized = targetPath.replaceAll('\\', '/');
  const match = /^relationship\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})-primer\.md$/.exec(normalized);
  if (!match) throw new Error(`Invalid relationship primer target "${targetPath}"`);
  return assertProfilePathSegment('relationshipKey', match[1]);
}

/**
 * Canonical F231 rendering for the capsule bytes embedded in L0.
 *
 * Keeping this pure transform in the profile contract lets durable evidence
 * bind the exact rendered profile segment, instead of accidentally binding a
 * newer on-disk profile body after compilation has already happened.
 */
export function splitUserCapsule(raw: string): { prefix: string; body: string } {
  if (raw.startsWith(PROFILE_MEMORY_TOMBSTONE_PREFIX)) return { prefix: '', body: '' };
  const lines = raw.trim().split('\n');
  let bodyStart: number;
  if (lines[0]?.trim() === '---') {
    const closingFence = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    bodyStart = closingFence < 0 ? 1 : closingFence + 1;
  } else {
    const metadataFence = lines.findIndex((line) => line.trim() === '---');
    bodyStart = metadataFence < 0 ? 0 : metadataFence + 1;
  }
  return {
    prefix: bodyStart ? `${lines.slice(0, bodyStart).join('\n')}\n` : '',
    body: lines.slice(bodyStart).join('\n').trim(),
  };
}

export function userCapsuleCharacterCount(body: string): number {
  return [...body.replace(/\s/g, '')].length;
}

export function renderUserCapsuleSection(raw: string): string {
  const { body } = splitUserCapsule(raw);
  if (!body) return '';
  const charCount = userCapsuleCharacterCount(body);
  if (charCount > USER_CAPSULE_CHAR_LIMIT) {
    throw new Error(
      `USER_CAPSULE exceeds ${USER_CAPSULE_CHAR_LIMIT}-character limit: ${charCount} characters. ` +
        `Capsule must be ≤${USER_CAPSULE_CHAR_LIMIT} chars (KD-7). Trim content or move overflow to primer.`,
    );
  }
  return `## 主人画像\n\n${body}`;
}
