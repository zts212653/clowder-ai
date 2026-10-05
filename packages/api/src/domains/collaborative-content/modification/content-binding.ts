import type { ContentModificationRequest } from '@cat-cafe/shared';
import type { MediaReviewPrincipal } from '../../video-studio/content-owner/published-media-access.js';
import type { WorkspaceContentSourceService } from '../../workspace/workspace-content-source.js';
import type { ContentModificationRecord } from './journal.js';
import type { ModificationContentPort } from './service.js';

/** Dispatches on the actual source owner's type, never a browser-supplied MIME or file title. */
export class ModificationContentBinding implements ModificationContentPort {
  constructor(
    private readonly deps: {
      source: WorkspaceContentSourceService;
      media: ModificationContentPort;
      text: ModificationContentPort;
    },
  ) {}
  async inspect(payload: ContentModificationRequest, principal: MediaReviewPrincipal, resuming: boolean) {
    return (await this.owner(payload, principal)).inspect(payload, principal, resuming);
  }
  async prepare(record: ContentModificationRecord, principal: MediaReviewPrincipal) {
    return (await this.owner(record.payload, principal)).prepare(record, principal);
  }
  async validatePrepared(record: ContentModificationRecord, principal: MediaReviewPrincipal) {
    return this.preparedOwner(record).validatePrepared(record, principal);
  }
  async prepareCommit(record: ContentModificationRecord, principal: MediaReviewPrincipal) {
    return this.preparedOwner(record).prepareCommit(record, principal);
  }
  private preparedOwner(record: ContentModificationRecord) {
    return record.progress.prepared?.kind === 'text' ? this.deps.text : this.deps.media;
  }
  private async owner(payload: ContentModificationRequest, principal: MediaReviewPrincipal) {
    if (payload.source.kind !== 'workspace') return this.deps.media;
    const source = await this.deps.source.describe({ principal, locator: payload.source.locator });
    return source.kind === 'text' ? this.deps.text : this.deps.media;
  }
}
