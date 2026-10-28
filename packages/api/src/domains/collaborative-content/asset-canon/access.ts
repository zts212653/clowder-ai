import type { AssetCanonItem, AssetCanonRecord, AssetFileState, VideoProjectAssetVersion } from '@cat-cafe/shared';
import { MediaOwnerError } from '../../video-studio/content-owner/media-errors.js';
import { WorkspaceSecurityError } from '../../workspace/workspace-security.js';
import type { WorkPrincipal } from '../works/types.js';
import type { WorkVideoContextService } from '../works/video-context.js';
import { assertAssetWriter } from './mutations.js';
import type { CanonReadScope } from './read-scope.js';
import type { AssetCanonStore } from './store.js';

export interface CanonAccessPorts {
  store: AssetCanonStore;
  contexts: WorkVideoContextService;
  authorize(principal: WorkPrincipal): Promise<void>;
  authorizeRoot(version: VideoProjectAssetVersion, principal: WorkPrincipal): Promise<void>;
  authorizeWork(
    reference: { contentRef: string; ownerRevision: number },
    principal: WorkPrincipal,
    permission: 'read' | 'write',
  ): Promise<void>;
  inspect(
    version: VideoProjectAssetVersion,
    principal: WorkPrincipal,
  ): Promise<{ locator: VideoProjectAssetVersion['locator']; sha256: string; byteLength: number }>;
  assertMember(catId: string, principal: WorkPrincipal): Promise<void>;
}

export class CanonAssetAccess {
  constructor(readonly deps: CanonAccessPorts) {}
  async authorize(record: AssetCanonRecord, principal: WorkPrincipal, write = false, reads?: CanonReadScope) {
    await this.deps.authorize(principal);
    if (record.ownerUserId !== principal.userId) throw new MediaOwnerError('access_denied');
    await this.deps.authorizeRoot(record.version, principal);
    if (record.source.kind === 'work') {
      const source = record.source;
      const context =
        reads && !write
          ? await reads.read(source.reference, principal, source.metadataRevision)
          : await this.deps.contexts.read(source.reference, principal, source.metadataRevision);
      const row = context?.context.assets.find((a) => a.asset.id === source.assetId);
      const version = row?.asset.versions.find((v) => v.id === row.versionId);
      if (
        !version ||
        version.sha256 !== record.version.sha256 ||
        version.locator.rootId !== record.version.locator.rootId ||
        version.locator.path !== record.version.locator.path
      )
        throw new MediaOwnerError('access_denied');
    }
    if (write) assertAssetWriter(record, principal);
  }
  async state(record: AssetCanonRecord, principal: WorkPrincipal): Promise<AssetFileState> {
    try {
      const file = await this.deps.inspect(record.version, principal);
      return file.sha256 === record.version.sha256 &&
        file.byteLength === record.version.byteLength &&
        file.locator.path === record.version.locator.path &&
        file.locator.rootId === record.version.locator.rootId
        ? 'available'
        : 'source_changed';
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : '';
      if (error instanceof WorkspaceSecurityError) return 'access_denied';
      if (code === 'ENOENT' || code === 'not_found' || code === 'NOT_FOUND') return 'source_missing';
      if (
        ['EACCES', 'EPERM', 'access_denied', 'ACCESS_DENIED', 'FORBIDDEN', 'PATH_TRAVERSAL', 'SYMLINK_ESCAPE'].includes(
          code,
        )
      )
        return 'access_denied';
      throw error;
    }
  }
  async item(
    record: AssetCanonRecord,
    principal: WorkPrincipal,
    options: { allowUnavailable?: boolean; reads?: CanonReadScope } = {},
  ): Promise<AssetCanonItem> {
    await this.authorize(record, principal, false, options.reads);
    const fileState = await this.state(record, principal);
    if (fileState === 'access_denied' && !options.allowUnavailable) throw new MediaOwnerError('access_denied');
    let canWrite = false;
    try {
      assertAssetWriter(record, principal);
      canWrite = fileState === 'available';
    } catch {
      /* read-only author */
    }
    let safeRecord = record;
    if (record.supersededBy) {
      const target = this.deps.store.get(principal.userId, record.supersededBy.indexedVersionRef);
      try {
        if (!target) throw new MediaOwnerError('access_denied');
        await this.authorize(target, principal, false, options.reads);
        if ((await this.state(target, principal)) === 'access_denied') throw new MediaOwnerError('access_denied');
      } catch (error) {
        if (!(error instanceof MediaOwnerError && error.code === 'access_denied')) throw error;
        safeRecord = { ...record, supersededBy: null };
      }
    }
    await this.authorize(record, principal, false, options.reads);
    return {
      record: safeRecord,
      fileState,
      canWrite,
      bindings: this.deps.store
        .bindings(principal.userId)
        .filter((b) => b.indexedVersionRef === record.indexedVersionRef),
    };
  }
}
