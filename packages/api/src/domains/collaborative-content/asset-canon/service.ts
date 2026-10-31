import {
  type AssetCanonCommand,
  type AssetCanonItem,
  assetCanonCommandSchema,
  type WorkVideoContext,
} from '@cat-cafe/shared';
import { MediaOwnerError } from '../../video-studio/content-owner/media-errors.js';
import type { WorkContextStore } from '../works/context-store.js';
import type { WorkPrincipal } from '../works/types.js';
import { type CanonAccessPorts, CanonAssetAccess } from './access.js';
import { authorizeAssetDecision } from './decision-access.js';
import { canonDigest, characterBindingRef } from './identity.js';
import { currentCanon, requireCanonAsset } from './mutations.js';
import { assertCanonSelections, verifyCanonSelections } from './selections.js';
import { runCanonMutation } from './service-mutations.js';
import { checkAssetUpdates, decideAssetUpdate } from './service-updates.js';
import { AssetCanonConflictError } from './store.js';
import { otherUses, usedItems } from './used.js';

export class AssetCanonService {
  readonly access: CanonAssetAccess;
  constructor(readonly deps: CanonAccessPorts & { contextStore: WorkContextStore }) {
    this.access = new CanonAssetAccess(deps);
  }
  async run(raw: unknown, principal: WorkPrincipal): Promise<unknown> {
    const command = assetCanonCommandSchema.parse(raw);
    await this.deps.authorize(principal);
    if (command.action === 'list-assets') return this.list(command, principal);
    if (command.action === 'check-asset-updates') return checkAssetUpdates(this, command, principal);
    if (command.action === 'decide-asset-update') return decideAssetUpdate(this, command, principal);
    if (command.action === 'read-asset' || command.action === 'read-asset-history') {
      const record = requireCanonAsset(this.deps.store, principal.userId, command.indexedVersionRef);
      const item = await this.access.item(record, principal);
      if (command.action === 'read-asset') {
        if (
          command.expectedRevision !== undefined &&
          (record.revision !== command.expectedRevision || !currentCanon(record) || item.fileState !== 'available')
        )
          throw new AssetCanonConflictError('Canonical selection changed; inspect current selection');
        return {
          ...item,
          ...(await otherUses(this.access, this.deps.contextStore, record.indexedVersionRef, principal, command.after)),
          snapshot: this.deps.store.snapshot(principal.userId),
        };
      }
      const events = this.deps.store.history(principal.userId, record.indexedVersionRef, command.after, command.limit);
      const history = [];
      for (const event of events) {
        if (!event.record) continue;
        const historical = await this.access.item(event.record, principal);
        if (event.record.supersededBy && !historical.record.supersededBy) continue;
        history.push({ ...event, record: historical.record });
      }
      const decisions = command.reference
        ? this.deps.store.decisions(principal.userId, command.reference, record.indexedVersionRef)
        : [];
      if (command.reference) await this.deps.authorizeWork(command.reference, principal, 'read');
      const visibleDecisions = [];
      for (const decision of decisions) {
        try {
          await authorizeAssetDecision(this.access, decision, principal);
          visibleDecisions.push({ ...decision, evidence: undefined });
        } catch (error) {
          if (!(error instanceof MediaOwnerError && error.code === 'access_denied')) throw error;
        }
      }
      return {
        item,
        history,
        decisions: visibleDecisions,
        ...(events.length === command.limit ? { nextAfter: command.after + command.limit } : {}),
      };
    }
    return runCanonMutation(this, command, principal);
  }
  async metadata(
    command: { reference?: { contentRef: string; ownerRevision: number }; metadataRevision?: number },
    principal: WorkPrincipal,
  ) {
    if (!command.reference) throw new MediaOwnerError('invalid_media');
    const metadata = await this.deps.contexts.read(command.reference, principal, command.metadataRevision);
    if (!metadata) throw new MediaOwnerError('media_unavailable');
    return metadata;
  }
  private async list(command: Extract<AssetCanonCommand, { action: 'list-assets' }>, principal: WorkPrincipal) {
    const before = this.deps.store.snapshot(principal.userId);
    if (command.purpose === 'used') {
      const metadata = await this.metadata(command, principal);
      const snapshot = canonDigest([metadata.reference, metadata.metadataRevision, before]);
      if (command.snapshot && command.snapshot !== snapshot)
        throw new AssetCanonConflictError('Asset list snapshot changed');
      const items = await usedItems(
        this.access,
        this.deps.contextStore,
        metadata,
        principal,
        command.after,
        command.limit,
        command.verifyFiles,
      );
      if (before !== this.deps.store.snapshot(principal.userId))
        throw new AssetCanonConflictError('Asset list snapshot changed');
      return {
        items,
        metadataRevision: metadata.metadataRevision,
        snapshot,
        ...(command.after + command.limit < metadata.context.assets.length
          ? { nextAfter: command.after + command.limit }
          : {}),
      };
    }
    if (command.snapshot && command.snapshot !== before)
      throw new AssetCanonConflictError('Asset list snapshot changed');
    const binding = command.use
      ? this.deps.store.binding(principal.userId, characterBindingRef(principal.userId, command.use))
      : null;
    const candidates = command.use
      ? binding?.indexedVersionRef
        ? [requireCanonAsset(this.deps.store, principal.userId, binding.indexedVersionRef)]
        : []
      : this.deps.store.page(principal.userId, command.after, command.limit, {
          status: command.status ?? 'canonical',
          kind: command.kind,
          superseded: command.includeSuperseded,
          memberAvatarCatId: command.memberAvatarCatId,
        });
    const items: AssetCanonItem[] = [];
    for (const record of candidates) {
      try {
        const item = await this.access.item(record, principal);
        if (item.fileState === 'available') items.push(item);
      } catch (error) {
        if (!(error instanceof MediaOwnerError && error.code === 'access_denied')) throw error;
      }
    }
    if (before !== this.deps.store.snapshot(principal.userId))
      throw new AssetCanonConflictError('Asset list snapshot changed');
    const more = !command.use && candidates.length === command.limit;
    return {
      items,
      snapshot: before,
      ...(binding ? { binding: { bindingRef: binding.bindingRef, bindingRevision: binding.bindingRevision } } : {}),
      ...(more ? { nextAfter: command.after + command.limit } : {}),
      ...(!items.length
        ? { reason: more ? 'more_candidates' : command.use ? 'no_current_binding' : 'no_available_canonical' }
        : {}),
    };
  }
  verifySelections(context: WorkVideoContext, principal: WorkPrincipal, retained?: WorkVideoContext) {
    return verifyCanonSelections(this.access, context, principal, retained);
  }
  assertSelections(context: WorkVideoContext, owner: string, retained?: WorkVideoContext) {
    assertCanonSelections(this.deps.store, context, owner, retained);
  }
}
