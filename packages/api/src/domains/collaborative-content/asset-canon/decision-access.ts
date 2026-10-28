import type { AssetUpdateDecision } from '@cat-cafe/shared';
import { MediaOwnerError } from '../../video-studio/content-owner/media-errors.js';
import type { WorkPrincipal } from '../works/types.js';
import type { CanonAssetAccess } from './access.js';
import { requireCanonAsset } from './mutations.js';

/** A receipt retains history, not the right to reveal a replacement whose source was revoked. */
export async function authorizeAssetDecision(
  access: CanonAssetAccess,
  decision: AssetUpdateDecision,
  principal: WorkPrincipal,
) {
  const evidence = decision.evidence;
  if (
    !evidence ||
    typeof evidence !== 'object' ||
    !('versionRefs' in evidence) ||
    !Array.isArray(evidence.versionRefs) ||
    !evidence.versionRefs.every((ref) => typeof ref === 'string')
  )
    throw new MediaOwnerError('access_denied');
  for (const ref of evidence.versionRefs) {
    const record = requireCanonAsset(access.deps.store, principal.userId, ref);
    await access.authorize(record, principal);
  }
}
