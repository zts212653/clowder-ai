import { createHash } from 'node:crypto';
import type { EvaluationUnitRef, TraceAnnotation, TraceEpisode } from '@cat-cafe/shared';
import type { InjectionTraceStore } from '../../../domains/prompt-hooks/InjectionTraceStore.js';
import type { EvaluationCatalog } from '../evaluation/evaluation-catalog.js';
import { traceMetricIncidentKey } from './trace-incident-key.js';

export interface SemanticEpisodeContext {
  episode: TraceEpisode;
  inputText: string | null;
  outputText: string | null;
  contextMessages?: Array<{ messageId: string; catId: string | null; content: string }>;
}

export interface SemanticSweepMatch {
  objectiveId: string;
  metricId: string;
  unitRefs: EvaluationUnitRef[];
  polarity: 'counterexample' | 'positive';
  confidence: number;
  explanation: string;
}

export interface SemanticSweepDecision {
  invocationId: string;
  status: 'matched' | 'irrelevant' | 'unscorable';
  matches: SemanticSweepMatch[];
}

export interface SemanticSweepEvaluator {
  evaluate(input: { catalog: EvaluationCatalog; contexts: SemanticEpisodeContext[] }): Promise<SemanticSweepDecision[]>;
}

export interface SemanticSweepRunResult {
  selected: number;
  classified: number;
  annotations: number;
  unitEvaluationReady?: boolean;
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * Background-only semantic classifier. Invocation routing never calls this
 * service; a scheduler supplies a bounded time window and injected evaluator.
 */
export class SemanticSweepService {
  constructor(
    private readonly deps: {
      traceStore: Pick<
        InjectionTraceStore,
        'listUnclassifiedInvocationIds' | 'getEpisodeByInvocationId' | 'markEpisodeClassified'
      >;
      annotationSink: {
        append(annotation: TraceAnnotation): Promise<{
          outcome: 'created' | 'duplicate';
          annotationId: string;
          unitEvaluationReady?: boolean;
        }>;
      };
      catalog: EvaluationCatalog;
      hydrateContext: (episode: TraceEpisode) => Promise<SemanticEpisodeContext>;
      evaluator: SemanticSweepEvaluator;
    },
  ) {}

  async run(input: {
    ownerUserId: string;
    startMs: number;
    endMs: number;
    limit?: number;
  }): Promise<SemanticSweepRunResult> {
    const invocationIds = await this.deps.traceStore.listUnclassifiedInvocationIds(
      input.ownerUserId,
      input.startMs,
      input.endMs,
      input.limit ?? 50,
    );
    const contexts: SemanticEpisodeContext[] = [];
    for (const invocationId of invocationIds) {
      const episode = await this.deps.traceStore.getEpisodeByInvocationId(invocationId);
      if (episode) contexts.push(await this.deps.hydrateContext(episode));
    }
    if (contexts.length === 0) return { selected: 0, classified: 0, annotations: 0 };

    const decisions = await this.deps.evaluator.evaluate({ catalog: this.deps.catalog, contexts });
    const decisionsByInvocation = new Map<string, SemanticSweepDecision>();
    for (const decision of decisions) {
      if (decisionsByInvocation.has(decision.invocationId)) {
        throw new Error(`semantic_sweep_duplicate_decision:${decision.invocationId}`);
      }
      if (!contexts.some((context) => context.episode.terminal.invocationId === decision.invocationId)) {
        throw new Error(`semantic_sweep_unknown_invocation:${decision.invocationId}`);
      }
      if (decision.status === 'matched' && decision.matches.length === 0) {
        throw new Error(`semantic_sweep_matched_without_matches:${decision.invocationId}`);
      }
      if (decision.status !== 'matched' && decision.matches.length > 0) {
        throw new Error(`semantic_sweep_terminal_decision_has_matches:${decision.invocationId}`);
      }
      decisionsByInvocation.set(decision.invocationId, decision);
    }

    let classified = 0;
    let annotationCount = 0;
    let unitEvaluationReady = false;
    for (const context of contexts) {
      const terminal = context.episode.terminal;
      const decision = decisionsByInvocation.get(terminal.invocationId);
      // Missing decisions stay in the unclassified work index for a later retry.
      if (!decision) continue;
      for (const match of decision.matches) {
        const incidentKey = traceMetricIncidentKey({
          ownerUserId: terminal.ownerUserId,
          invocationId: terminal.invocationId,
          objectiveId: match.objectiveId,
          metricId: match.metricId,
          polarity: match.polarity,
        });
        const annotation: TraceAnnotation = {
          annotationId: `ann-${digest(['semantic-sweep', incidentKey])}`,
          episodeRef: terminal,
          source: 'semantic-sweep',
          ruleId: 'semantic-sweep-v1',
          objectiveId: match.objectiveId,
          metricId: match.metricId,
          unitRefs: match.unitRefs,
          polarity: match.polarity,
          confidence: Math.max(0, Math.min(1, match.confidence)),
          incidentKey,
          evidenceRefs: [
            `trace://${terminal.threadId}/${terminal.traceTurnId}`,
            `invocation://${terminal.invocationId}`,
          ],
          rationale: match.explanation,
          createdAt: terminal.terminalAt,
        };
        const appended = await this.deps.annotationSink.append(annotation);
        unitEvaluationReady ||= appended.unitEvaluationReady === true;
        annotationCount++;
      }
      await this.deps.traceStore.markEpisodeClassified(terminal.ownerUserId, terminal.invocationId);
      classified++;
    }
    return {
      selected: contexts.length,
      classified,
      annotations: annotationCount,
      ...(unitEvaluationReady ? { unitEvaluationReady: true } : {}),
    };
  }
}
