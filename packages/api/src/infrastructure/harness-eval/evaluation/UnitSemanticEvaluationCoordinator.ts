import { createHash } from 'node:crypto';
import type { EvaluationSnapshot, MetricDefinition, TraceEpisode } from '@cat-cafe/shared';
import type { SemanticEpisodeContext } from '../trace-annotation/SemanticSweepService.js';
import { buildSemanticMetricResult, orderSemanticTraceCorpus, validateSemanticOutput } from './evaluator-runner.js';
import type { ObjectiveEvaluationRuntime } from './ObjectiveEvaluationRuntime.js';
import type {
  UnitSemanticEpisodePacket,
  UnitSemanticEvaluationJob,
  UnitSemanticEvaluationJobStore,
  UnitSemanticRetrievalReceipt,
} from './UnitSemanticEvaluationJobStore.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export interface UnitSemanticRetrievalPacket {
  jobId: string;
  cursor: number;
  nextCursor: number;
  remaining: number;
  exhausted: boolean;
  episodes: UnitSemanticEpisodePacket[];
}

export interface UnitSemanticEvaluationPacket {
  jobId: string;
  snapshotId: string;
  objectiveId: string;
  metric: MetricDefinition;
  evaluationModelId: string;
  evaluationModelVersion: string;
  unitRefs: EvaluationSnapshot['unitRefs'];
  window: EvaluationSnapshot['window'];
  frozenCorpusSize: number;
  priorityHints: EvaluationSnapshot['samples'];
  initialRetrieval: UnitSemanticRetrievalPacket;
}

type PendingSemanticCandidate = { snapshot: EvaluationSnapshot; metric: MetricDefinition };

/**
 * Asynchronous semantic evaluator boundary for a frozen Unit snapshot.
 *
 * Structured annotations only reorder the corpus. All evidence returned to the
 * eval cat is selected from snapshot.traceCorpus, and the append-only retrieval
 * receipts become the authoritative provenance of what the evaluator saw.
 * They retain evidence digests rather than message bodies; replay rehydrates
 * the canonical source and fails closed if it was changed or deleted.
 */
export class UnitSemanticEvaluationCoordinator {
  constructor(
    private readonly deps: {
      runtime: ObjectiveEvaluationRuntime;
      jobStore: UnitSemanticEvaluationJobStore;
      hydrateContext: (episode: TraceEpisode) => Promise<SemanticEpisodeContext>;
      now?: () => number;
    },
  ) {}

  async prepare(input: {
    ownerUserId: string;
    evaluatorCatId: string;
    now: number;
    initialBatchSize?: number;
    limitJobs?: number;
  }): Promise<UnitSemanticEvaluationPacket[]> {
    const initialBatchSize = boundedBatchSize(input.initialBatchSize ?? 5);
    await this.deps.runtime.runCadenceMetrics(input.ownerUserId, input.now);
    const candidates = await this.pendingCandidates(input.ownerUserId);
    const packets: UnitSemanticEvaluationPacket[] = [];
    for (const candidate of candidates.slice(0, input.limitJobs ?? 4)) {
      const packet = await this.prepareCandidate(candidate, input.evaluatorCatId, initialBatchSize);
      if (packet) packets.push(packet);
    }
    return packets;
  }

  private async pendingCandidates(ownerUserId: string): Promise<PendingSemanticCandidate[]> {
    const candidates: PendingSemanticCandidate[] = [];
    for (const objective of this.deps.runtime.catalog.registry.objectives) {
      const pending = await this.deps.runtime.snapshots.getPendingUnitRun(ownerUserId, objective.id);
      if (!pending) continue;
      for (const metric of pending.snapshot.metricDefinitions) {
        if (metric.kind !== 'semantic' || metric.evaluator.kind !== 'llm') continue;
        if (await this.deps.runtime.externalSemanticResults.get(pending.snapshotId, metric.id)) continue;
        candidates.push({ snapshot: pending.snapshot, metric });
      }
    }
    return candidates.sort(compareCandidates);
  }

  private async prepareCandidate(
    candidate: PendingSemanticCandidate,
    evaluatorCatId: string,
    initialBatchSize: number,
  ): Promise<UnitSemanticEvaluationPacket | null> {
    const { snapshot, metric } = candidate;
    const { ordered, priorityAnchorIds } = orderSemanticTraceCorpus(snapshot, metric.id);
    if (ordered.length === 0) return null;
    const jobId = `unit-semantic-${digest([snapshot.snapshotId, snapshot.evaluationModelVersion, metric.id])}`;
    const existing = await this.deps.jobStore.get(jobId);
    if (existing && existing.evaluatorCatId !== evaluatorCatId) {
      throw new Error(`unit_semantic_job_principal_locked:${jobId}:${existing.evaluatorCatId}`);
    }
    const job: UnitSemanticEvaluationJob = existing ?? {
      jobId,
      ownerUserId: snapshot.ownerUserId,
      evaluatorCatId,
      snapshotId: snapshot.snapshotId,
      objectiveId: snapshot.objectiveId,
      metricId: metric.id,
      evaluationModelId: snapshot.evaluationModelId,
      evaluationModelVersion: snapshot.evaluationModelVersion,
      unitRefs: snapshot.unitRefs,
      window: snapshot.window,
      orderedInvocationIds: ordered.map((episode) => episode.terminal.invocationId),
      priorityAnchorIds,
      createdAt: snapshot.createdAt,
    };
    await this.deps.jobStore.append(job);
    const receipt = await this.initialReceipt(job, snapshot, initialBatchSize);
    return {
      jobId: job.jobId,
      snapshotId: snapshot.snapshotId,
      objectiveId: snapshot.objectiveId,
      metric,
      evaluationModelId: snapshot.evaluationModelId,
      evaluationModelVersion: snapshot.evaluationModelVersion,
      unitRefs: snapshot.unitRefs,
      window: snapshot.window,
      frozenCorpusSize: snapshot.traceCorpus.length,
      priorityHints: snapshot.samples.filter((sample) => sample.metricId === metric.id),
      initialRetrieval: await this.packetForReceipt(job, snapshot, receipt),
    };
  }

  private async initialReceipt(
    job: UnitSemanticEvaluationJob,
    snapshot: EvaluationSnapshot,
    initialBatchSize: number,
  ): Promise<UnitSemanticRetrievalReceipt> {
    const existing = await this.deps.jobStore.getReceipt(job.jobId, 0);
    if (existing) return existing;
    const appended = await this.deps.jobStore.appendReceipt(
      job.jobId,
      await this.createReceipt(job, snapshot, 0, job.orderedInvocationIds.slice(0, initialBatchSize)),
    );
    return appended.receipt;
  }

  async retrieve(
    principal: { ownerUserId: string; evaluatorCatId: string },
    input: { jobId: string; cursor: number; limit: number },
  ): Promise<UnitSemanticRetrievalPacket> {
    const job = await this.requireJob(principal, input.jobId);
    if (!Number.isInteger(input.cursor) || input.cursor < 0) {
      throw new Error(`unit_semantic_invalid_cursor:${input.jobId}:${input.cursor}`);
    }
    const limit = boundedBatchSize(input.limit);
    const snapshot = await this.requireFrozenSnapshot(job);

    const existing = await this.deps.jobStore.getReceipt(job.jobId, input.cursor);
    if (existing) return this.packetForReceipt(job, snapshot, existing);

    const receipts = await this.deps.jobStore.contiguousReceipts(job.jobId);
    const nextExpectedCursor = receipts.at(-1)?.nextCursor ?? 0;
    if (input.cursor !== nextExpectedCursor) {
      throw new Error(`unit_semantic_cursor_gap:${input.jobId}:${input.cursor}:${nextExpectedCursor}`);
    }
    const invocationIds = job.orderedInvocationIds.slice(input.cursor, input.cursor + limit);
    if (invocationIds.length === 0) {
      return {
        jobId: job.jobId,
        cursor: input.cursor,
        nextCursor: input.cursor,
        remaining: 0,
        exhausted: true,
        episodes: [],
      };
    }
    const appended = await this.deps.jobStore.appendReceipt(
      job.jobId,
      await this.createReceipt(job, snapshot, input.cursor, invocationIds),
    );
    return this.packetForReceipt(job, snapshot, appended.receipt);
  }

  async submit(
    principal: { ownerUserId: string; evaluatorCatId: string },
    input: { jobId: string; labels: Record<string, number>; explanation: string },
  ): Promise<{
    resultId: string;
    inspectedCount: number;
    frozenCorpusSize: number;
    exhausted: boolean;
    unitCompleted: boolean;
  }> {
    const job = await this.requireJob(principal, input.jobId);
    validateSemanticOutput(input, job.metricId);
    const submissionDigest = digest(input);
    const completed = await this.deps.jobStore.getCompletion(job.jobId);
    if (completed) {
      if (completed.submissionDigest !== submissionDigest) {
        throw new Error(`unit_semantic_completion_conflict:${job.jobId}`);
      }
      return this.submissionResponse(job, completed.result, completed.unitCompleted);
    }

    const snapshot = await this.requireFrozenSnapshot(job);
    const metric = snapshot.metricDefinitions.find((candidate) => candidate.id === job.metricId);
    if (!metric) throw new Error(`unit_semantic_metric_not_found:${job.jobId}:${job.metricId}`);
    const receipts = await this.deps.jobStore.contiguousReceipts(job.jobId);
    const inspectedInvocationIds = receipts.flatMap((receipt) => receipt.invocationIds);
    if (inspectedInvocationIds.length === 0) {
      throw new Error(`unit_semantic_no_retrieval:${job.jobId}`);
    }
    const exhausted = inspectedInvocationIds.length === job.orderedInvocationIds.length;
    const retrieval = {
      frozenCorpusSize: job.orderedInvocationIds.length,
      inspectedInvocationIds,
      priorityAnchorIds: job.priorityAnchorIds,
      exhausted,
    };
    const candidate = buildSemanticMetricResult(snapshot, metric, this.deps.now?.() ?? Date.now(), input, retrieval);
    const staged = await this.deps.runtime.externalSemanticResults.get(snapshot.snapshotId, metric.id);
    if (staged && staged.resultId !== candidate.resultId) {
      throw new Error(`unit_semantic_completion_conflict:${job.jobId}`);
    }
    // A staged result is the durable retry anchor for the crash seam between
    // Unit commit and job-completion receipt. Reuse its first completion time.
    const result = staged ?? candidate;
    const { unitCompleted } = await this.deps.runtime.acceptExternalSemanticResult(result);
    await this.deps.jobStore.complete(job.jobId, {
      submissionDigest,
      result,
      unitCompleted,
      completedAt: result.evaluatedAt,
    });
    return this.submissionResponse(job, result, unitCompleted);
  }

  private async requireJob(
    principal: { ownerUserId: string; evaluatorCatId: string },
    jobId: string,
  ): Promise<UnitSemanticEvaluationJob> {
    const job = await this.deps.jobStore.get(jobId);
    if (!job) throw new Error(`unit_semantic_job_not_found:${jobId}`);
    if (job.ownerUserId !== principal.ownerUserId || job.evaluatorCatId !== principal.evaluatorCatId) {
      throw new Error(`unit_semantic_principal_mismatch:${jobId}`);
    }
    return job;
  }

  private async requireFrozenSnapshot(job: UnitSemanticEvaluationJob): Promise<EvaluationSnapshot> {
    const snapshot = await this.deps.runtime.snapshots.get(job.snapshotId);
    if (!snapshot) throw new Error(`unit_semantic_snapshot_not_found:${job.snapshotId}`);
    const frozenIds = snapshot.traceCorpus.map((episode) => episode.terminal.invocationId);
    const { ordered, priorityAnchorIds } = orderSemanticTraceCorpus(snapshot, job.metricId);
    const expectedOrder = ordered.map((episode) => episode.terminal.invocationId);
    if (
      snapshot.ownerUserId !== job.ownerUserId ||
      snapshot.objectiveId !== job.objectiveId ||
      snapshot.evaluationModelId !== job.evaluationModelId ||
      snapshot.evaluationModelVersion !== job.evaluationModelVersion ||
      frozenIds.length !== job.orderedInvocationIds.length ||
      JSON.stringify(expectedOrder) !== JSON.stringify(job.orderedInvocationIds) ||
      JSON.stringify(priorityAnchorIds) !== JSON.stringify(job.priorityAnchorIds)
    ) {
      throw new Error(`unit_semantic_snapshot_conflict:${job.jobId}`);
    }
    return snapshot;
  }

  private async packetForReceipt(
    job: UnitSemanticEvaluationJob,
    snapshot: EvaluationSnapshot,
    receipt: UnitSemanticRetrievalReceipt,
  ): Promise<UnitSemanticRetrievalPacket> {
    const byInvocation = new Map(snapshot.traceCorpus.map((episode) => [episode.terminal.invocationId, episode]));
    if (receipt.evidenceDigests.length !== receipt.invocationIds.length) {
      throw new Error(`unit_semantic_retrieval_corrupt:${job.jobId}:${receipt.cursor}`);
    }
    const episodes: UnitSemanticEpisodePacket[] = [];
    for (const [index, invocationId] of receipt.invocationIds.entries()) {
      const episode = byInvocation.get(invocationId);
      if (!episode) throw new Error(`unit_semantic_snapshot_conflict:${job.jobId}`);
      const packet = toEpisodePacket(await this.deps.hydrateContext(episode));
      if (digest(packet) !== receipt.evidenceDigests[index]) {
        throw new Error(`unit_semantic_evidence_changed:${job.jobId}:${receipt.cursor}:${invocationId}`);
      }
      episodes.push(packet);
    }
    return {
      jobId: job.jobId,
      cursor: receipt.cursor,
      nextCursor: receipt.nextCursor,
      remaining: job.orderedInvocationIds.length - receipt.nextCursor,
      exhausted: receipt.nextCursor >= job.orderedInvocationIds.length,
      episodes,
    };
  }

  private async createReceipt(
    job: UnitSemanticEvaluationJob,
    snapshot: EvaluationSnapshot,
    cursor: number,
    invocationIds: string[],
  ): Promise<UnitSemanticRetrievalReceipt> {
    const byInvocation = new Map(snapshot.traceCorpus.map((episode) => [episode.terminal.invocationId, episode]));
    const evidenceDigests: string[] = [];
    for (const invocationId of invocationIds) {
      const episode = byInvocation.get(invocationId);
      if (!episode) throw new Error(`unit_semantic_snapshot_conflict:${job.jobId}`);
      const packet = toEpisodePacket(await this.deps.hydrateContext(episode));
      evidenceDigests.push(digest(packet));
    }
    return {
      cursor,
      nextCursor: cursor + invocationIds.length,
      invocationIds,
      evidenceDigests,
      createdAt: this.deps.now?.() ?? Date.now(),
    };
  }

  private submissionResponse(
    job: UnitSemanticEvaluationJob,
    result: import('@cat-cafe/shared').MetricResult,
    unitCompleted: boolean,
  ) {
    return {
      resultId: result.resultId,
      inspectedCount: result.value.kind === 'semantic' ? result.value.retrieval.inspectedInvocationIds.length : 0,
      frozenCorpusSize: job.orderedInvocationIds.length,
      exhausted: result.value.kind === 'semantic' ? result.value.retrieval.exhausted : false,
      unitCompleted,
    };
  }
}

function compareCandidates(left: PendingSemanticCandidate, right: PendingSemanticCandidate): number {
  return (
    left.snapshot.createdAt - right.snapshot.createdAt ||
    left.snapshot.snapshotId.localeCompare(right.snapshot.snapshotId) ||
    left.metric.id.localeCompare(right.metric.id)
  );
}

function boundedBatchSize(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 25) {
    throw new Error(`unit_semantic_invalid_batch_size:${value}`);
  }
  return value;
}

function toEpisodePacket(context: SemanticEpisodeContext): UnitSemanticEpisodePacket {
  const { episode } = context;
  return {
    invocationId: episode.terminal.invocationId,
    traceTurnId: episode.terminal.traceTurnId,
    threadId: episode.terminal.threadId,
    catId: episode.terminal.catId,
    terminalAt: episode.terminal.terminalAt,
    terminalKind: episode.terminal.terminalKind,
    toolCalls: episode.terminal.toolCalls,
    segments: episode.summary.segments,
    inputText: context.inputText,
    outputText: context.outputText,
    contextMessages: context.contextMessages ?? [],
  };
}

export function formatUnitSemanticEvaluationPackets(packets: UnitSemanticEvaluationPacket[]): string {
  return [
    '## Unit semantic evaluation (frozen raw corpus)',
    '',
    'Each job is an independent Unit evaluation. Structured counterexamples are high-priority retrieval hints only.',
    'Judge from the raw trace episodes returned by the server. Use `cat_cafe_retrieve_unit_evaluation_traces`',
    'with the returned nextCursor when more evidence is needed, then call `cat_cafe_submit_unit_evaluation`.',
    'You may stop before exhaustion when the inspected evidence is sufficient, but explain the semantic judgment.',
    'Do not invent invocation ids, counts, denominators, or retrieval provenance.',
    '',
    '```json',
    JSON.stringify({ jobs: packets }, null, 2),
    '```',
  ].join('\n');
}
