import type { WorkContextRecord, WorkReference } from '@cat-cafe/shared';
import { MediaOwnerError } from '../../video-studio/content-owner/media-errors.js';
import { workContextCacheKey } from '../works/context-store.js';
import type { WorkPrincipal } from '../works/types.js';
import type { WorkVideoContextService } from '../works/video-context.js';

/** One bounded read request, one principal. Parsed metadata never implies authorization. */
export class CanonReadScope {
  readonly records = new Map<string, WorkContextRecord>();
  private readonly reads = new Map<string, Promise<WorkContextRecord | null>>();
  constructor(
    private readonly contexts: WorkVideoContextService,
    private readonly principal: WorkPrincipal,
    verified: WorkContextRecord,
  ) {
    if (verified.ownerUserId !== principal.userId) throw new MediaOwnerError('access_denied');
    const key = workContextCacheKey(principal.userId, verified.reference, verified.metadataRevision);
    this.records.set(key, verified);
    this.reads.set(key, Promise.resolve(verified));
  }
  read(reference: WorkReference, principal: WorkPrincipal, revision: number) {
    if (principal !== this.principal) throw new MediaOwnerError('access_denied');
    const key = workContextCacheKey(principal.userId, reference, revision);
    const existing = this.reads.get(key);
    if (existing) return existing;
    const parsed = this.records.get(key);
    const request = parsed
      ? this.contexts.revalidate(parsed, principal).then(() => parsed)
      : this.contexts.read(reference, principal, revision).then((record) => {
          if (record) this.records.set(key, record);
          return record;
        });
    this.reads.set(key, request);
    return request;
  }
  async revalidate() {
    for (const result of await Promise.allSettled(this.reads.values())) {
      if (result.status === 'fulfilled' && result.value) await this.contexts.revalidate(result.value, this.principal);
    }
  }
}
