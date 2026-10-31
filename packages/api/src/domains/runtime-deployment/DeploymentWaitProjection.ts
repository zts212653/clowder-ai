import {
  type DeploymentCandidateProjection,
  type DeploymentInclusionProofV1,
  type DeploymentObservationV1,
  type DeploymentWaitItemProjection,
  type DeploymentWaitListResponse,
  type DeploymentWaitMatchedEvidenceV1,
  type DeploymentWaitPredicate,
  deploymentOutcomeMatchesObservation,
  evaluateDeploymentWait,
  type TaskItem,
} from '@cat-cafe/shared';

interface DeploymentCandidateEvidence {
  readonly revision: string;
  readonly observedAt: number;
  readonly subjectRef?: string;
  readonly proveInclusion: (targetRevision: string) => Promise<DeploymentInclusionProofV1 | null>;
}

export interface DeploymentWaitProjectionBuildInput {
  readonly projectPath: string;
  readonly tasks: readonly TaskItem[];
  readonly threadTitles: ReadonlyMap<string, string | null>;
  readonly observeDeployment: (input: {
    readonly deploymentId: string;
    readonly targetRevision?: string;
  }) => Promise<DeploymentObservationV1 | null>;
  readonly candidate?: DeploymentCandidateEvidence | null;
}

function deploymentId(subjectRef: string): string | null {
  const parts = subjectRef.split(':');
  return parts.length === 3 && parts[2] ? parts[2] : null;
}

function observationProjection(observation: DeploymentObservationV1) {
  return {
    bootId: observation.bootId,
    bootSequence: observation.bootSequence,
    runningRevision: observation.runningRevision,
    readyServices: observation.readyServices,
    observedAt: observation.observedAt,
  } as const;
}

function matchedCondition(match: DeploymentWaitMatchedEvidenceV1): DeploymentWaitPredicate | null {
  if (match.kind === 'new_ready_boot') return { kind: match.kind, services: match.services };
  return match.targetRevision ? { kind: match.kind, revision: match.targetRevision, services: match.services } : null;
}

async function projectMatchedTask(
  task: TaskItem,
  threadTitle: string | null,
  observeDeployment: DeploymentWaitProjectionBuildInput['observeDeployment'],
): Promise<DeploymentWaitItemProjection | null> {
  const outcome = task.deploymentWait?.waitOutcome;
  const match = outcome?.reason === 'matched' ? outcome.deploymentMatch : undefined;
  const condition = match ? matchedCondition(match) : null;
  const id = outcome ? deploymentId(outcome.subjectRef) : null;
  if (!outcome || outcome.delivery !== 'pending' || !match || !condition || !id) return null;
  const observation = await observeDeployment({
    deploymentId: id,
    ...(condition.kind === 'revision_included' ? { targetRevision: condition.revision } : {}),
  });
  const ready =
    !task.deploymentWait?.currentExecutionClaim &&
    observation !== null &&
    deploymentOutcomeMatchesObservation(outcome, observation);
  return {
    taskId: task.id,
    threadId: task.threadId,
    threadTitle,
    taskTitle: task.title,
    ownerCatId: task.ownerCatId,
    ...(task.sourceMessageId ? { sourceMessageId: task.sourceMessageId } : {}),
    subjectRef: outcome.subjectRef,
    deploymentId: id,
    generation: outcome.generation,
    createdAt: outcome.registeredAt ?? null,
    matchedAt: outcome.at,
    nextStep: outcome.nextStep ?? '',
    condition,
    state: ready ? 'ready_to_return' : 'unknown',
    ...(!ready
      ? {
          stateReason: task.deploymentWait?.currentExecutionClaim
            ? ('deployment_match_pending_recheck' as const)
            : observation
              ? ('deployment_evidence_incomplete' as const)
              : ('deployment_evidence_unavailable' as const),
        }
      : {}),
    delivery: outcome.delivery,
    observation: observation
      ? observationProjection(observation)
      : {
          bootId: match.bootId,
          bootSequence: match.bootSequence,
          runningRevision: match.runningRevision,
          readyServices: match.services,
          observedAt: match.observedAt,
        },
  };
}

async function projectActiveTask(
  task: TaskItem,
  threadTitle: string | null,
  observeDeployment: DeploymentWaitProjectionBuildInput['observeDeployment'],
): Promise<DeploymentWaitItemProjection | null> {
  const active = task.deploymentWait?.await;
  const condition = active?.continuation.when[0];
  const id = active ? deploymentId(active.subjectRef) : null;
  if (!active || active.continuation.when.length !== 1 || !condition || !id) return null;
  const observation = await observeDeployment({
    deploymentId: id,
    ...(condition.kind === 'revision_included' ? { targetRevision: condition.revision } : {}),
  });
  const evaluation = observation ? evaluateDeploymentWait(active, observation) : null;
  // A live observation is advisory. Only a persisted matched outcome can claim
  // readiness; the recovery sweep still has to recheck and admit its wake.
  const state = evaluation?.state === 'waiting' ? 'waiting' : 'unknown';
  return {
    taskId: task.id,
    threadId: task.threadId,
    threadTitle,
    taskTitle: task.title,
    ownerCatId: task.ownerCatId,
    ...(task.sourceMessageId ? { sourceMessageId: task.sourceMessageId } : {}),
    subjectRef: active.subjectRef,
    deploymentId: id,
    generation: active.generation,
    createdAt: active.createdAt,
    nextStep: active.continuation.then,
    condition,
    state: state === 'waiting' ? 'waiting_for_update' : state,
    ...(state === 'unknown'
      ? {
          stateReason:
            evaluation?.state === 'matched'
              ? ('deployment_match_pending_recheck' as const)
              : observation
                ? ('deployment_evidence_incomplete' as const)
                : ('deployment_evidence_unavailable' as const),
        }
      : {}),
    ...(observation ? { observation: observationProjection(observation) } : {}),
  };
}

async function candidateProjection(
  tasks: readonly TaskItem[],
  candidate: DeploymentCandidateEvidence | null | undefined,
): Promise<DeploymentCandidateProjection | null> {
  if (!candidate) return null;
  let satisfiableCount = 0;
  let unknownCount = 0;
  for (const task of tasks) {
    const active = task.deploymentWait?.await;
    const condition = active?.continuation.when[0];
    if (!active || active.continuation.when.length !== 1 || !condition) continue;
    if (candidate.subjectRef && active.subjectRef !== candidate.subjectRef) continue;
    const nextBootSequence = active.baseline.bootSequence + 1;
    if (!Number.isSafeInteger(nextBootSequence)) {
      unknownCount += 1;
      continue;
    }
    const inclusionProof =
      condition.kind === 'revision_included' ? await candidate.proveInclusion(condition.revision) : undefined;
    const observation: DeploymentObservationV1 = {
      subjectRef: active.subjectRef,
      bootId: `candidate:${candidate.revision.slice(0, 12)}:g${active.generation}`,
      bootSequence: nextBootSequence,
      runningRevision: candidate.revision,
      readyServices: condition.services,
      observedAt: candidate.observedAt,
      ...(inclusionProof ? { inclusionProof } : {}),
    };
    const evaluation = evaluateDeploymentWait(active, observation);
    if (evaluation.state === 'matched') satisfiableCount += 1;
    else if (evaluation.state === 'unknown') unknownCount += 1;
  }
  return { revision: candidate.revision, observedAt: candidate.observedAt, satisfiableCount, unknownCount };
}

export async function buildDeploymentWaitProjection(
  input: DeploymentWaitProjectionBuildInput,
): Promise<DeploymentWaitListResponse> {
  const observationCache = new Map<string, Promise<DeploymentObservationV1 | null>>();
  const observeDeployment: DeploymentWaitProjectionBuildInput['observeDeployment'] = (query) => {
    const key = JSON.stringify([query.deploymentId, query.targetRevision ?? null]);
    let pending = observationCache.get(key);
    if (!pending) {
      pending = input.observeDeployment(query);
      observationCache.set(key, pending);
    }
    return pending;
  };
  const proofCache = new Map<string, Promise<DeploymentInclusionProofV1 | null>>();
  const sourceCandidate = input.candidate;
  const candidate = sourceCandidate
    ? {
        ...sourceCandidate,
        proveInclusion: (targetRevision: string) => {
          let pending = proofCache.get(targetRevision);
          if (!pending) {
            pending = sourceCandidate.proveInclusion(targetRevision);
            proofCache.set(targetRevision, pending);
          }
          return pending;
        },
      }
    : null;
  const tasks = input.tasks.filter(
    (task) =>
      task.kind === 'work' &&
      task.status !== 'done' &&
      (task.deploymentWait?.await !== undefined ||
        (task.deploymentWait?.waitOutcome?.reason === 'matched' &&
          task.deploymentWait.waitOutcome.delivery === 'pending')),
  );
  const items = (
    await Promise.all(
      tasks.map(async (task) => {
        const title = input.threadTitles.get(task.threadId) ?? null;
        return task.deploymentWait?.await
          ? projectActiveTask(task, title, observeDeployment)
          : projectMatchedTask(task, title, observeDeployment);
      }),
    )
  )
    .filter((item): item is DeploymentWaitItemProjection => item !== null)
    .sort(
      (left, right) =>
        (left.createdAt ?? Number.MAX_SAFE_INTEGER) - (right.createdAt ?? Number.MAX_SAFE_INTEGER) ||
        left.taskId.localeCompare(right.taskId),
    );
  return {
    projectPath: input.projectPath,
    items,
    candidate: await candidateProjection(tasks, candidate),
  };
}
