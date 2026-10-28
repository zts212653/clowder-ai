import type { AssetCanonRecord, CharacterAssetBinding, MemberVisualAssets } from '@cat-cafe/shared';
import { MediaOwnerError } from '../../video-studio/content-owner/media-errors.js';
import type { WorkPrincipal } from '../works/types.js';
import { characterBindingRef } from './identity.js';
import type { AssetCanonService } from './service.js';
import type { CanonReceipt } from './store.js';

export class MemberCanonService {
  constructor(
    readonly canon: AssetCanonService,
    readonly ownerUserId: string,
  ) {}
  binding(catId: string) {
    return this.canon.deps.store.binding(
      this.ownerUserId,
      characterBindingRef(this.ownerUserId, { role: 'member-avatar', catId }),
    );
  }
  requireHuman(principal: WorkPrincipal | null): WorkPrincipal {
    if (
      !principal ||
      principal.userId !== this.ownerUserId ||
      principal.actor.kind !== 'human' ||
      principal.invocationId
    )
      throw new MediaOwnerError('access_denied');
    return principal;
  }
  async project(
    catId: string,
    principal: WorkPrincipal | null,
  ): Promise<{ avatar?: string; visualAssets: MemberVisualAssets }> {
    const binding = this.binding(catId);
    if (!binding) return { visualAssets: { state: 'unlinked', bindingRevision: 0 } };
    const avatar = `/api/cats/${encodeURIComponent(catId)}/avatar?bindingRevision=${binding.bindingRevision}`;
    const base = {
      avatar,
      visualAssets: {
        state: 'unavailable' as const,
        bindingRef: binding.bindingRef,
        bindingRevision: binding.bindingRevision,
      },
    };
    if (!principal || principal.userId !== this.ownerUserId) return base;
    if (!binding.indexedVersionRef) return { avatar, visualAssets: { ...base.visualAssets, state: 'cleared' } };
    try {
      const record = this.canon.deps.store.get(this.ownerUserId, binding.indexedVersionRef);
      if (!record) return base;
      const item = await this.canon.access.item(record, principal);
      return {
        avatar,
        visualAssets: {
          ...base.visualAssets,
          state: item.fileState === 'available' ? 'selected' : 'unavailable',
          indexedVersionRef: record.indexedVersionRef,
        },
      };
    } catch (error) {
      if (error instanceof MediaOwnerError && error.code === 'access_denied') return base;
      throw error;
    }
  }
  async select(
    catId: string,
    input: {
      operationId: string;
      reason: string;
      expectedBindingRevision: number;
      mode: 'set' | 'clear';
      indexedVersionRef?: string;
      expectedAssetRevision?: number;
    },
    principal: WorkPrincipal,
  ) {
    this.requireHuman(principal);
    await this.canon.deps.assertMember(catId, principal);
    return this.canon.run(
      {
        action: 'bind-character-asset',
        operationId: input.operationId,
        reason: input.reason,
        mode: input.mode,
        expectedBindingRevision: input.expectedBindingRevision,
        indexedVersionRef: input.indexedVersionRef,
        expectedAssetRevision: input.expectedAssetRevision,
        slot: { role: 'member-avatar', catId },
        evidenceRefs: [`human-selection:member-settings/${catId}/${input.operationId}`],
      },
      principal,
    );
  }
  async history(catId: string, principal: WorkPrincipal, after = 0) {
    this.requireHuman(principal);
    await this.canon.deps.assertMember(catId, principal);
    const binding = this.binding(catId);
    if (!binding) return [];
    const results: CharacterAssetBinding[] = [];
    for (const event of this.canon.deps.store.history(this.ownerUserId, binding.bindingRef, after, 50)) {
      if (!event.binding) continue;
      if (event.binding.indexedVersionRef) {
        const record = this.canon.deps.store.get(this.ownerUserId, event.binding.indexedVersionRef);
        if (!record) continue;
        try {
          await this.canon.access.authorize(record, principal);
        } catch {
          continue;
        }
      }
      results.push(event.binding);
    }
    return results;
  }
  async upload(
    catId: string,
    input: { operationId: string; reason: string; expectedBindingRevision: number },
    asset: { name: string; version: AssetCanonRecord['version'] },
    principal: WorkPrincipal,
  ) {
    this.requireHuman(principal);
    await this.canon.deps.assertMember(catId, principal);
    const indexed = (await this.canon.run(
      {
        action: 'index-asset',
        operationId: `${input.operationId}:index`,
        name: asset.name,
        kind: 'image',
        version: asset.version,
        applicability: [
          {
            subjectRef: { kind: 'member', catId },
            representation: 'member-avatar',
            styleKey: 'member-settings',
            role: 'avatar',
          },
        ],
        evidenceRefs: [`human-upload:${input.operationId}`],
      },
      principal,
    )) as CanonReceipt;
    const record = indexed.assets[0]!;
    const marked = (await this.canon.run(
      {
        action: 'set-asset-status',
        operationId: `${input.operationId}:canonical`,
        indexedVersionRef: record.indexedVersionRef,
        expectedRevision: record.revision,
        status: 'canonical',
        reason: input.reason,
        evidenceRefs: [`human-upload:${input.operationId}`],
      },
      principal,
    )) as CanonReceipt;
    const receipt = await this.select(
      catId,
      {
        ...input,
        mode: 'set',
        indexedVersionRef: record.indexedVersionRef,
        expectedAssetRevision: marked.assets[0]!.revision,
      },
      principal,
    );
    return { status: 'saved', indexed, marked, receipt };
  }
}
