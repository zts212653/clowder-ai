/**
 * F231 profile addressing contract shared by the API compiler/repository and MCP clients.
 * Physical data-root resolution stays Node-side; this module only owns safe logical segments.
 */

export const CURRENT_RELATIONSHIP_PROFILE_URI = 'cat-cafe-profile://relationship/current' as const;
export const DEFAULT_PROFILE_USER_ID = 'default-user';

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
