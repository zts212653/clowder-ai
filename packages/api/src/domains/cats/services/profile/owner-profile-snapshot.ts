import {
  CURRENT_CORPUS_PROFILE_URI,
  CURRENT_RELATIONSHIP_PROFILE_URI,
  renderUserCapsuleSection,
} from '@cat-cafe/shared/profile-contract';
import { installOwnerUserId } from '../../../../config/install-owner.js';
import { profilePointerEmitted } from '../../../../infrastructure/telemetry/instruments.js';
import type { OwnerProfileSnapshot } from '../context/SystemPromptBuilder.js';
import { FileProfileRepository } from './ProfileRepository.js';

/**
 * Resolve the owner's F231 profile once per session, for the S14 session segment.
 *
 * The routes call this and hand the result to `buildStaticIdentity`, so every carrier
 * delivers the same bytes and durable evidence can bind exactly what was delivered.
 * The pipeline itself stays pure: it never reads these files.
 *
 * Owner selection matches what the retired L0 compiler used
 * (`CAT_CAFE_USER_ID ?? DEFAULT_PROFILE_USER_ID`), now routed through the install's one
 * owner identity so a configured trust anchor is honored too.
 *
 * Pointers are existence-gated and never carry content (INV-6): a session says the
 * relationship trajectory exists and how to read it, not what it says.
 */
export function resolveOwnerProfileSnapshot(options: {
  catId: string;
  repository?: FileProfileRepository;
  env?: NodeJS.ProcessEnv;
}): OwnerProfileSnapshot | null {
  const env = options.env ?? process.env;
  const userId = installOwnerUserId(env);
  const repository = options.repository ?? new FileProfileRepository();

  const capsule = repository.readCapsule(userId);
  const capsuleSection = capsule ? renderUserCapsuleSection(capsule.content) : '';

  const pointerLines: string[] = [];
  // Identity resolution is fail-closed, exactly as the retired L0 compiler and
  // `FileProfileRepository.scope()` are. Production always has a relationship key
  // (`cat-config-loader.ts` fills it from the breed id), so a missing one means the
  // catalog invariant is broken — not that this cat merely has no primer. Degrading
  // to "no pointer" would hide that. Going through the repository also keeps its
  // injected `relationshipKeyForCat` seam authoritative instead of re-reading the
  // global registry behind its back.
  const primer = repository.readPrimer(repository.scope(userId, options.catId));
  if (primer) {
    pointerLines.push(`关系轨迹: ${CURRENT_RELATIONSHIP_PROFILE_URI}（cat_cafe_read_profile 按需读）`);
    profilePointerEmitted.add(1, { 'profile.layer': 'primer' });
  }
  // Phase E: the corpus is owner-wide, so it is not scoped to this cat. Same
  // existence gate and same per-layer counter the retired L0 compiler emitted.
  if (repository.readCorpus(userId)) {
    pointerLines.push(`共享事实: ${CURRENT_CORPUS_PROFILE_URI}（cat_cafe_read_profile layer=corpus 按需读）`);
    profilePointerEmitted.add(1, { 'profile.layer': 'corpus' });
  }

  if (!capsuleSection && pointerLines.length === 0) return null;
  return { userId, ...(capsuleSection ? { capsuleSection } : {}), pointerLines };
}
