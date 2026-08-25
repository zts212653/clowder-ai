/**
 * F231 profile addressing contract shared by the API compiler/repository and MCP clients.
 * Physical data-root resolution stays Node-side; this module only owns safe logical segments.
 */

export const CURRENT_RELATIONSHIP_PROFILE_URI = 'cat-cafe-profile://relationship/current' as const;
export const DEFAULT_PROFILE_USER_ID = 'default-user';
export const USER_CAPSULE_CHAR_LIMIT = 300;

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
export function renderUserCapsuleSection(raw: string): string {
  const lines = raw.trim().split('\n');
  let body: string;
  if (lines[0]?.trim() === '---') {
    const closingFence = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    body = (closingFence < 0 ? lines.slice(1) : lines.slice(closingFence + 1)).join('\n').trim();
  } else {
    const metadataFence = lines.findIndex((line) => line.trim() === '---');
    body = (metadataFence < 0 ? raw : lines.slice(metadataFence + 1).join('\n')).trim();
  }
  if (!body) return '';
  const charCount = [...body.replace(/\s/g, '')].length;
  if (charCount > USER_CAPSULE_CHAR_LIMIT) {
    throw new Error(
      `USER_CAPSULE exceeds ${USER_CAPSULE_CHAR_LIMIT}-character limit: ${charCount} characters. ` +
        `Capsule must be ≤${USER_CAPSULE_CHAR_LIMIT} chars (KD-7). Trim content or move overflow to primer.`,
    );
  }
  return `## 主人画像\n\n${body}`;
}
