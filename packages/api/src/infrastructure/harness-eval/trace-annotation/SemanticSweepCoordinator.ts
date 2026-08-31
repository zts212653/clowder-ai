import { createHash } from 'node:crypto';
import type { EvaluationUnitRef, TraceEpisode, TraceTerminalExtension } from '@cat-cafe/shared';
import type { InjectionTraceStore } from '../../../domains/prompt-hooks/InjectionTraceStore.js';
import { type EvaluationCatalog, validateEvaluationCoordinate } from '../evaluation/evaluation-catalog.js';
import type { ObjectiveEvaluationRuntime } from '../evaluation/ObjectiveEvaluationRuntime.js';
import type { SemanticSweepJob, SemanticSweepJobStore } from './SemanticSweepJobStore.js';
import {
  type SemanticEpisodeContext,
  type SemanticSweepDecision,
  type SemanticSweepRunResult,
  SemanticSweepService,
} from './SemanticSweepService.js';
import type { TraceAnnotationStore } from './TraceAnnotationStore.js';

type SweepTraceStore = Pick<
  InjectionTraceStore,
  'listUnclassifiedInvocationIds' | 'getEpisodeByInvocationId' | 'markEpisodeClassified'
>;

export interface SemanticSweepPacket {
  jobId: string;
  window: { start: number; end: number };
  episodes: Array<{
    invocationId: string;
    traceTurnId: string;
    threadId: string;
    catId: string;
    inputMessageId: string | null;
    outputMessageId: string | null;
    terminalAt: number;
    terminalKind: string;
    toolCalls: TraceTerminalExtension['toolCalls'];
    segments: TraceEpisode['summary']['segments'];
    inputText: string | null;
    outputText: string | null;
    contextMessages: Array<{ messageId: string; catId: string | null; content: string }>;
  }>;
  rules: Array<{
    objectiveId: string;
    objectiveLabel: string;
    evaluationModelId: string;
    unitRefs: EvaluationUnitRef[];
    metrics: Array<{ metricId: string; label: string; kind: string; ruleRef: string }>;
  }>;
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * Creates owner-scoped, immutable semantic-review batches and applies the eval
 * cat's structured decisions back to the unified annotation ledger.
 *
 * This coordinator never runs on the invocation response path. It is called by
 * periodic/manual eval workers, and submissions are bound to the assigned eval
 * cat plus the exact invocation ids frozen in the job.
 */
export class SemanticSweepCoordinator {
  constructor(
    private readonly deps: {
      traceStore: SweepTraceStore;
      jobStore: SemanticSweepJobStore;
      annotationSink: Pick<TraceAnnotationStore, 'append'> | ObjectiveEvaluationRuntime;
      catalog: EvaluationCatalog;
      hydrateContext: (episode: TraceEpisode) => Promise<SemanticEpisodeContext>;
    },
  ) {}

  async prepare(input: {
    ownerUserId: string;
    evaluatorCatId: string;
    startMs: number;
    endMs: number;
    limit?: number;
  }): Promise<{ job: SemanticSweepJob; packet: SemanticSweepPacket } | null> {
    const invocationIds = await this.deps.traceStore.listUnclassifiedInvocationIds(
      input.ownerUserId,
      input.startMs,
      input.endMs,
      input.limit ?? 10,
    );
    const contexts: SemanticEpisodeContext[] = [];
    for (const invocationId of invocationIds) {
      const episode = await this.deps.traceStore.getEpisodeByInvocationId(invocationId);
      if (!episode || episode.terminal.ownerUserId !== input.ownerUserId) continue;
      contexts.push(await this.deps.hydrateContext(episode));
    }
    if (contexts.length === 0) return null;

    contexts.sort(
      (left, right) =>
        left.episode.terminal.terminalAt - right.episode.terminal.terminalAt ||
        left.episode.terminal.invocationId.localeCompare(right.episode.terminal.invocationId),
    );
    const episodeRefs = contexts.map((context) => context.episode.terminal);
    const jobId = `semantic-sweep-${digest([
      input.ownerUserId,
      input.evaluatorCatId,
      episodeRefs.map((ref) => ref.invocationId),
    ])}`;
    const job: SemanticSweepJob = {
      jobId,
      ownerUserId: input.ownerUserId,
      evaluatorCatId: input.evaluatorCatId,
      window: {
        start: Math.min(...episodeRefs.map((ref) => ref.terminalAt)),
        end: Math.max(...episodeRefs.map((ref) => ref.terminalAt)) + 1,
      },
      episodeRefs,
      createdAt: Math.max(...episodeRefs.map((ref) => ref.terminalAt)),
    };
    await this.deps.jobStore.append(job);
    return { job, packet: this.buildPacket(job, contexts) };
  }

  async submit(
    principal: { ownerUserId: string; evaluatorCatId: string },
    input: { jobId: string; decisions: SemanticSweepDecision[] },
  ): Promise<SemanticSweepRunResult & { alreadyCompleted: boolean }> {
    const job = await this.deps.jobStore.get(input.jobId);
    if (!job) throw new Error(`semantic_sweep_job_not_found:${input.jobId}`);
    if (job.ownerUserId !== principal.ownerUserId || job.evaluatorCatId !== principal.evaluatorCatId) {
      throw new Error(`semantic_sweep_principal_mismatch:${input.jobId}`);
    }
    const submissionDigest = digest(input.decisions);
    const completed = await this.deps.jobStore.getCompletion(input.jobId);
    if (completed) {
      if (completed.submissionDigest !== submissionDigest) {
        throw new Error(`semantic_sweep_completion_conflict:${input.jobId}`);
      }
      return { ...completed.result, alreadyCompleted: true };
    }

    const allowed = new Set(job.episodeRefs.map((ref) => ref.invocationId));
    for (const decision of input.decisions) {
      if (!allowed.has(decision.invocationId)) {
        throw new Error(`semantic_sweep_unknown_invocation:${decision.invocationId}`);
      }
      for (const match of decision.matches) {
        const coordinateError = validateEvaluationCoordinate(this.deps.catalog, match);
        if (coordinateError) throw new Error(`invalid_evaluation_coordinate:${coordinateError}`);
      }
    }

    const frozenIds = job.episodeRefs.map((ref) => ref.invocationId);
    const frozenStore: SweepTraceStore = {
      listUnclassifiedInvocationIds: async () => frozenIds,
      getEpisodeByInvocationId: (invocationId) => this.deps.traceStore.getEpisodeByInvocationId(invocationId),
      markEpisodeClassified: (ownerUserId, invocationId) =>
        this.deps.traceStore.markEpisodeClassified(ownerUserId, invocationId),
    };
    const service = new SemanticSweepService({
      traceStore: frozenStore,
      annotationSink: this.deps.annotationSink,
      catalog: this.deps.catalog,
      hydrateContext: this.deps.hydrateContext,
      evaluator: { evaluate: async () => input.decisions },
    });
    const result = await service.run({
      ownerUserId: job.ownerUserId,
      startMs: job.window.start,
      endMs: job.window.end,
      limit: job.episodeRefs.length,
    });
    if ('runCadenceMetrics' in this.deps.annotationSink) {
      await this.deps.annotationSink.runCadenceMetrics(job.ownerUserId, Date.now());
    }
    await this.deps.jobStore.complete(input.jobId, {
      submissionDigest,
      result,
      completedAt: Date.now(),
    });
    return { ...result, alreadyCompleted: false };
  }

  private buildPacket(job: SemanticSweepJob, contexts: SemanticEpisodeContext[]): SemanticSweepPacket {
    return {
      jobId: job.jobId,
      window: job.window,
      episodes: contexts.map(({ episode, inputText, outputText, contextMessages }) => ({
        invocationId: episode.terminal.invocationId,
        traceTurnId: episode.terminal.traceTurnId,
        threadId: episode.terminal.threadId,
        catId: episode.terminal.catId,
        inputMessageId: episode.terminal.inputMessageId,
        outputMessageId: episode.terminal.outputMessageId,
        terminalAt: episode.terminal.terminalAt,
        terminalKind: episode.terminal.terminalKind,
        toolCalls: episode.terminal.toolCalls,
        segments: episode.summary.segments,
        inputText,
        outputText,
        contextMessages: contextMessages ?? [],
      })),
      rules: this.deps.catalog.registry.objectives.map((objective) => {
        const model = this.deps.catalog.registry.evaluationModels.find(
          (candidate) => candidate.id === objective.evaluationModelId,
        );
        return {
          objectiveId: objective.id,
          objectiveLabel: objective.label,
          evaluationModelId: objective.evaluationModelId,
          unitRefs: this.deps.catalog.manifest.units.flatMap((unit) =>
            unit.objectives
              .filter((attachment) => attachment.objectiveId === objective.id)
              .map((attachment) => ({
                unitType: 'segment' as const,
                unitId: unit.unitId,
                ...(attachment.clauseId ? { clauseId: attachment.clauseId } : {}),
              })),
          ),
          metrics: (model?.metrics ?? []).map((metric) => ({
            metricId: metric.id,
            label: metric.label,
            kind: metric.kind,
            ruleRef: metric.evaluator.ruleRef,
          })),
        };
      }),
    };
  }
}

export function formatSemanticSweepPacket(packet: SemanticSweepPacket): string {
  return [
    '## Objective semantic sweep (immutable trace batch)',
    '',
    `Job: ${packet.jobId}`,
    `Window: ${new Date(packet.window.start).toISOString()} — ${new Date(packet.window.end).toISOString()}`,
    '',
    'Review each frozen episode against the supplied Objective/Metric rules.',
    'Then call `cat_cafe_submit_semantic_sweep` with this exact jobId and structured decisions.',
    'Do not invent invocation ids; omit an episode when evidence is insufficient and it must remain retryable.',
    '',
    '```json',
    JSON.stringify(packet, null, 2),
    '```',
  ].join('\n');
}
