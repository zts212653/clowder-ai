import type { MessageElement } from '@clowder-ai/plugin-contract';
import { MessagingError } from './contract/host-types.js';
import type { MediaEntitlementLedger } from './media-entitlements.js';
import type { FileMessagingMediaLedger } from './media-ledger.js';

const DENIED_MESSAGE = 'Media access denied';

/** Same import-owner or active-entitlement rule for send and append. */
export class MediaReferenceAuthority {
  constructor(
    private readonly deps: {
      readonly ledger: Pick<FileMessagingMediaLedger, 'isImportOwner'>;
      readonly entitlements: Pick<MediaEntitlementLedger, 'isEntitled'>;
    },
  ) {}

  async assertCanReference(instanceId: string, elements: readonly MessageElement[]): Promise<void> {
    for (const element of elements) {
      if (element.kind !== 'media_ref') continue;
      const reference = element.payload.reference;
      if (!reference.startsWith('hmr_')) continue;
      let authorized = false;
      try {
        authorized =
          (await this.deps.ledger.isImportOwner(reference, instanceId)) ||
          (await this.deps.entitlements.isEntitled(instanceId, reference));
      } catch {
        // Unknown IDs, corrupt records, and unavailable audit storage are indistinguishable.
      }
      if (!authorized) throw new MessagingError('MEDIA_ACCESS_DENIED', DENIED_MESSAGE);
    }
  }
}
