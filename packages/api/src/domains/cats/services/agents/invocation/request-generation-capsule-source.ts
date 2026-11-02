import type { RequestGenerationEnvelopeV1, RequestGenerationSourceRef } from '@cat-cafe/shared';
import { renderUserCapsuleSection } from '@cat-cafe/shared/profile-contract';
import type { FileProfileRepository } from '../../profile/ProfileRepository.js';
import { encodeProfileSourceRef } from '../../session/transcript-index/request-generation-source-policy.js';
import type { PreparedProviderRequestV1 } from '../../types.js';

export type CapsuleSourceRepository = Pick<FileProfileRepository, 'readCapsule'>;

export function nativeOpeningCapsuleRevision(
  prepared: PreparedProviderRequestV1,
  continuity: RequestGenerationEnvelopeV1['continuity'],
  userId: string,
  repository?: CapsuleSourceRepository,
): string | undefined {
  if (continuity.mode !== 'cold') return undefined;
  const capsule = repository?.readCapsule(userId);
  if (!capsule) return undefined;
  const rendered = renderUserCapsuleSection(capsule.content);
  return rendered &&
    prepared.nativeInstructions.some(
      (instruction) =>
        (instruction.injectionDecision === 'native_l0_compiled' ||
          instruction.injectionDecision === 'native_l0_compiled_with_signature_boundary' ||
          instruction.injectionDecision === 'native_agent_file_compiled') &&
        instruction.body.includes(rendered),
    )
    ? capsule.revision
    : undefined;
}

/** Bind bytes emitted by the current capsule renderer; logical Profile pointers copy no body. */
export async function requestGenerationCapsuleSourceRefs(input: {
  body: string;
  userId: string;
  profileRepository?: CapsuleSourceRepository;
  digest: (value: string) => Promise<string>;
}): Promise<RequestGenerationSourceRef[]> {
  if (!input.body.includes('## 主人画像')) return [];
  let rendered = '';
  try {
    const capsule = input.profileRepository?.readCapsule(input.userId);
    rendered = capsule ? renderUserCapsuleSection(capsule.content) : '';
  } catch {
    /* Existing capsule bytes without a readable current owner stay unresolved. */
  }
  const digest = rendered && input.body.includes(rendered) ? await input.digest(rendered) : 'unresolved';
  return [{ owner: 'home_state', ref: encodeProfileSourceRef('capsule', digest) }];
}
