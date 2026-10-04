import type { CollectiveConnector } from '@cat-cafe/collective-connector';
import { type CollectiveSourceIdentity, type CollectiveWorkMatter, collectiveWorkMatterSchema } from '@cat-cafe/shared';
import type { InvocationRecord } from '../../../cats/services/agents/invocation/InvocationRegistry.js';
import { collectiveContextError, opaqueRef, verifyRef } from '../collective-context-refs.js';

export interface CollectiveContinueWorkInput {
  readonly workRef: string;
  readonly kind: 'resume' | 'revision';
  readonly grantRef: string;
  readonly grantRevision: number;
  readonly requestKind: string;
}
interface SourceBinding {
  readonly source: CollectiveSourceIdentity;
  readonly sourceRef: string;
  readonly displayName: string;
}
const coordinatesSchema = collectiveWorkMatterSchema.pick({
  workId: true,
  revision: true,
  executionRevision: true,
  resultEventId: true,
  resultRevision: true,
});

function workCoordinates(matter: CollectiveWorkMatter) {
  const { workId, revision, executionRevision, resultEventId, resultRevision } = matter;
  return coordinatesSchema.parse({ workId, revision, executionRevision, resultEventId, resultRevision });
}
function encodeWorkRef(auth: InvocationRecord, sourceRef: string, matter: CollectiveWorkMatter) {
  const payload = Buffer.from(JSON.stringify(workCoordinates(matter))).toString('base64url');
  return `${payload}.${opaqueRef(auth, `work:${payload}`, sourceRef)}`;
}
function decodeWorkRef(auth: InvocationRecord, sourceRef: string, workRef: string) {
  if (workRef.length > 2000) throw collectiveContextError('RETURN_REF_INVALID', 'Invalid Work reference');
  const parts = workRef.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1])
    throw collectiveContextError('RETURN_REF_INVALID', 'Invalid Work reference');
  verifyRef(auth, parts[1], `work:${parts[0]}`, sourceRef);
  return coordinatesSchema.parse(JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')));
}

/** Only bounded public candidates enter the model. The reference is bound to this source and invocation. */
export async function currentWorkSourceContext(
  connector: Pick<CollectiveConnector, 'readWorkSourceContext'>,
  auth: InvocationRecord,
  binding: SourceBinding,
) {
  const current = await connector.readWorkSourceContext(binding.source);
  return {
    ...current,
    matters: current.matters.map((matter) => ({ ...matter, workRef: encodeWorkRef(auth, binding.sourceRef, matter) })),
  };
}

export async function continueWorkFromSource(
  connector: CollectiveConnector,
  auth: InvocationRecord,
  binding: SourceBinding,
  input: CollectiveContinueWorkInput,
) {
  const expected = decodeWorkRef(auth, binding.sourceRef, input.workRef);
  const current = await connector.readWorkSourceContext(binding.source);
  const matter = current.matters.find((candidate) => candidate.workId === expected.workId);
  if (!matter || JSON.stringify(workCoordinates(matter)) !== JSON.stringify(expected))
    throw collectiveContextError(
      'WORK_REVISION_CONFLICT',
      'The referenced Work changed; read its current source context',
    );
  if (current.relatedWorkIds.length === 1 && current.relatedWorkIds[0] !== matter.workId)
    throw collectiveContextError('WORK_SOURCE_AMBIGUOUS', 'This source references another matter');
  const work = await connector.continueWork(
    binding.source,
    {
      catId: auth.catId,
      agentId: auth.catId,
      displayName: binding.displayName,
      sessionRef: auth.invocationId,
    },
    {
      workId: matter.workId,
      expectedRevision: matter.revision,
      kind: input.kind,
      grantRef: input.grantRef,
      grantRevision: input.grantRevision,
      requestKind: input.requestKind,
      ...(input.kind === 'revision'
        ? { resultEventId: matter.resultEventId, resultRevision: matter.resultRevision }
        : {}),
    },
  );
  await connector.sync(binding.source.connectionId);
  return {
    workId: work.workId,
    assignmentEventId: work.assignmentEventId,
    executionAuthority: work.executionAuthority,
    accountableHumanId: work.accountableHumanId,
    lifecycle: work.lifecycle,
    disposition: 'accepted_pending_host_admission' as const,
  };
}
