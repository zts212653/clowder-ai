import type { AssetCanonMutation, VideoProjectAssetVersion } from '@cat-cafe/shared';
import { MediaOwnerError } from '../../video-studio/content-owner/media-errors.js';
import type { WorkPrincipal } from '../works/types.js';
import { indexedVersionRef } from './identity.js';
import { requireCanonAsset } from './mutations.js';
import type { AssetCanonService } from './service.js';
import { AssetCanonConflictError } from './store.js';
import { indexUsedAsset } from './used.js';

export async function runCanonMutation(
  service: AssetCanonService,
  command: Exclude<AssetCanonMutation, { action: 'decide-asset-update' }>,
  principal: WorkPrincipal,
) {
  const { store } = service.deps;
  if (command.action === 'bind-character-asset' && (principal.actor.kind !== 'human' || principal.invocationId))
    throw new MediaOwnerError('access_denied');
  if ('context' in command && command.context) {
    await service.metadata(command.context, principal);
    await service.deps.authorizeWork(command.context.reference, principal, 'write');
  }
  const refs = new Set<string>();
  const bindingTargets = new Set<string>();
  if ('indexedVersionRef' in command && command.indexedVersionRef) refs.add(command.indexedVersionRef);
  if (command.action === 'supersede-asset') {
    refs.add(command.fromVersionRef);
    refs.add(command.toVersionRef);
  }
  if ('bindings' in command) {
    for (const disposition of command.bindings) {
      if (principal.actor.kind !== 'human') throw new MediaOwnerError('access_denied');
      if (disposition.indexedVersionRef) {
        refs.add(disposition.indexedVersionRef);
        bindingTargets.add(disposition.indexedVersionRef);
      }
      const binding = store.binding(principal.userId, disposition.bindingRef);
      if (!binding) throw new MediaOwnerError('access_denied');
      if (binding.indexedVersionRef) refs.add(binding.indexedVersionRef);
      const catId =
        binding.slot.role === 'member-avatar'
          ? binding.slot.catId
          : binding.slot.subjectRef.kind === 'member'
            ? binding.slot.subjectRef.catId
            : binding.memberCatId;
      if (catId) await service.deps.assertMember(catId, principal);
    }
  }
  for (const ref of refs) {
    const record = requireCanonAsset(store, principal.userId, ref);
    await service.access.authorize(record, principal, command.action !== 'bind-character-asset');
    if ((await service.access.state(record, principal)) === 'access_denied') throw new MediaOwnerError('access_denied');
  }
  const replay = store.replay(command, principal);
  if (replay) {
    for (const record of replay.assets) {
      await service.access.authorize(record, principal);
      if ((await service.access.state(record, principal)) === 'access_denied')
        throw new MediaOwnerError('access_denied');
    }
    return replay;
  }
  let normalizedVersion: VideoProjectAssetVersion | undefined;
  if (command.action === 'index-asset') {
    const inspected = await service.deps.inspect(command.version, principal);
    if (inspected.sha256 !== command.version.sha256 || inspected.byteLength !== command.version.byteLength)
      throw new AssetCanonConflictError('Source changed before indexing');
    // Canonical locator identity is minted by F063, never by an alias supplied by the caller.
    normalizedVersion = { ...command.version, locator: inspected.locator };
    const existing = store.get(principal.userId, indexedVersionRef(principal.userId, normalizedVersion));
    if (existing) await service.access.authorize(existing, principal);
    else {
      const origin = service.deps.contextStore.assetOrigin(principal.userId, normalizedVersion);
      if (origin) {
        await service.deps.contexts.read(origin.metadata.reference, principal, origin.metadata.metadataRevision);
        indexUsedAsset(service.access, service.deps.contextStore, origin.metadata, origin.index, principal.threadId);
      }
    }
  }
  if (command.action === 'bind-character-asset') {
    const catId =
      command.slot.role === 'member-avatar'
        ? command.slot.catId
        : command.slot.subjectRef.kind === 'member'
          ? command.slot.subjectRef.catId
          : command.memberCatId;
    if (catId) await service.deps.assertMember(catId, principal);
  }
  for (const ref of refs) {
    const record = requireCanonAsset(store, principal.userId, ref);
    if (
      (bindingTargets.has(ref) ||
        command.action === 'bind-character-asset' ||
        (command.action === 'set-asset-status' && command.status === 'canonical') ||
        (command.action === 'supersede-asset' && command.mode === 'replace' && ref === command.toVersionRef)) &&
      (await service.access.state(record, principal)) !== 'available'
    )
      throw new AssetCanonConflictError('Current canonical requires verified available source');
    await service.access.authorize(record, principal, command.action !== 'bind-character-asset');
  }
  await service.deps.authorize(principal);
  return store.mutate(command, principal, normalizedVersion);
}
