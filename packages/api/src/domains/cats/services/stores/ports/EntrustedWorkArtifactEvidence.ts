import { entrustedWorkV1Schema, type TaskItem } from '@cat-cafe/shared';
import { z } from 'zod';

const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const coordinate = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value.trim() === value && !/[\x00-\x1f\x7f]/u.test(value));
const inputSchema = z
  .object({
    expectedRevision: revision,
    executionAuthorityRevision: revision,
    ownerUserId: coordinate,
    ownerCatId: coordinate,
    threadId: coordinate,
    admissionRef: coordinate,
    artifactRef: entrustedWorkV1Schema.shape.artifactRefs.element,
  })
  .strict();

/** Internal Task-owner port, not a tool/SDK payload. The Host caller must verify the current
 * Registry execution and exact durable publication before CAS and again before returning a seal.
 * These coordinates constrain the write; they do not themselves prove publication authority. */
export type AttachEntrustedWorkArtifactInput = z.infer<typeof inputSchema>;
export type AttachEntrustedWorkArtifactResult =
  | { readonly kind: 'not_found' }
  | {
      readonly kind:
        | 'attached'
        | 'already_attached'
        | 'not_entrusted'
        | 'already_closed'
        | 'authority_conflict'
        | 'revision_conflict';
      readonly task: TaskItem;
    };

export function captureEntrustedWorkArtifactInput(input: AttachEntrustedWorkArtifactInput) {
  const result = inputSchema.parse(input);
  if (result.artifactRef !== input.artifactRef) throw new Error('Artifact ref must already be canonical');
  return Object.freeze(result);
}

/** Shared Memory/Redis mutation. Only refs, aggregate revision and updatedAt can change. */
export function prepareEntrustedWorkArtifactEvidence(
  task: TaskItem | null,
  input: AttachEntrustedWorkArtifactInput,
): AttachEntrustedWorkArtifactResult {
  if (!task) return { kind: 'not_found' };
  const work = task.entrustedWork;
  if (!work) return { kind: 'not_entrusted', task };
  if (work.closure.state !== 'open' || task.status === 'done') return { kind: 'already_closed', task };
  if (
    task.kind !== 'work' ||
    task.userId !== input.ownerUserId ||
    task.ownerCatId !== input.ownerCatId ||
    task.threadId !== input.threadId ||
    work.executionAuthorityRevision !== input.executionAuthorityRevision ||
    work.admission.basis !== 'authorized_source' ||
    work.admission.authorityRef !== input.admissionRef
  ) {
    return { kind: 'authority_conflict', task };
  }
  if (!Number.isSafeInteger(work.revision) || work.revision < 1) throw new Error('Invalid Task aggregate revision');
  // An exact already-registered ref can recover a lost response, only under the same current epoch.
  if (input.expectedRevision <= work.revision && work.artifactRefs.includes(input.artifactRef))
    return { kind: 'already_attached', task };
  if (input.expectedRevision !== work.revision) return { kind: 'revision_conflict', task };
  if (work.revision === Number.MAX_SAFE_INTEGER) throw new Error('Entrusted Task revision cannot advance');
  const entrustedWork = entrustedWorkV1Schema.parse({
    ...work,
    revision: work.revision + 1,
    artifactRefs: [...work.artifactRefs, input.artifactRef],
  });
  return { kind: 'attached', task: { ...task, entrustedWork, updatedAt: Date.now() } };
}
