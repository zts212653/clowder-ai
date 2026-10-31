import { randomUUID } from 'node:crypto';
import type { EvidenceDrillDown, EvidenceItem, EvidenceSearchExecution, SearchOptions } from './interfaces.js';
import type {
  PerspectiveAnchorCandidate,
  PerspectiveGraphResolveStep,
  PerspectiveOpenAnchorStep,
  PerspectiveOpenedAnchor,
  PerspectivePlan,
  PerspectiveRun,
  PerspectiveSearchEvidenceStep,
  PerspectiveWarning,
} from './perspective-types.js';

export interface PerspectiveRunnerDeps {
  searchEvidence(query: string, options: SearchOptions): Promise<EvidenceSearchExecution>;
  openAnchor(candidate: PerspectiveAnchorCandidate): Promise<Omit<PerspectiveOpenedAnchor, 'sourceStepId' | 'stepId'>>;
  resolveGraph?: (anchor: string) => Promise<{
    status: string;
    anchor?: string;
    drillDown?: EvidenceDrillDown;
    candidates?: Array<{ anchor: string; title?: string; drillDown?: EvidenceDrillDown }>;
  }>;
  now?: () => Date;
  randomId?: () => string;
}

type PerspectiveGraphResolveResult = Awaited<ReturnType<NonNullable<PerspectiveRunnerDeps['resolveGraph']>>>;

export interface PerspectiveRunOptions {
  actorCatId: string;
  inputs?: Record<string, unknown>;
}

export class PerspectiveRunner {
  private readonly now: () => Date;
  private readonly randomId: () => string;

  constructor(private readonly deps: PerspectiveRunnerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.randomId = deps.randomId ?? (() => `perspective-run-${randomUUID()}`);
  }

  async run(plan: PerspectivePlan, options: PerspectiveRunOptions): Promise<PerspectiveRun> {
    const startedAt = this.timestamp();
    const run: PerspectiveRun = {
      runId: this.randomId(),
      planId: plan.id,
      startedAt,
      actorCatId: options.actorCatId,
      effectiveInputs: { ...(plan.defaults ?? {}), ...(options.inputs ?? {}) },
      steps: [],
      candidateAnchors: [],
      openedAnchors: [],
      warnings: [],
    };

    let previousCandidates: PerspectiveAnchorCandidate[] = [];

    for (const step of plan.steps) {
      if (step.type === 'search_evidence') {
        const candidates = await this.runSearchStep(step, run);
        previousCandidates = candidates;
        continue;
      }
      if (step.type === 'open_anchor') {
        await this.runOpenAnchorStep(step, previousCandidates, run);
        previousCandidates = [];
        continue;
      }
      const candidates = await this.runGraphResolveStep(step, run);
      previousCandidates = candidates;
    }

    return run;
  }

  private async runSearchStep(
    step: PerspectiveSearchEvidenceStep,
    run: PerspectiveRun,
  ): Promise<PerspectiveAnchorCandidate[]> {
    const startedAt = this.timestamp();
    const execution = await this.deps.searchEvidence(step.query, searchOptionsFromStep(step));
    const candidates = execution.items.map((item, index) => candidateFromEvidenceItem(item, step.id, index));
    run.candidateAnchors.push(...candidates);
    run.steps.push({
      id: step.id,
      type: step.type,
      status: 'ok',
      startedAt,
      finishedAt: this.timestamp(),
      queryOrAnchor: step.query,
      hitCount: execution.items.length,
      degraded: execution.meta.degraded,
      ...(execution.meta.degradeReason ? { degradeReason: execution.meta.degradeReason } : {}),
      ...(execution.meta.effectiveMode ? { effectiveMode: execution.meta.effectiveMode } : {}),
    });
    return candidates;
  }

  private async runOpenAnchorStep(
    step: PerspectiveOpenAnchorStep,
    previousCandidates: PerspectiveAnchorCandidate[],
    run: PerspectiveRun,
  ): Promise<void> {
    const startedAt = this.timestamp();
    const selected = previousCandidates.slice(0, step.maxOpen);
    const stepWarnings: PerspectiveWarning[] = [];
    let openedCount = 0;

    for (const candidate of selected) {
      try {
        const opened = await this.deps.openAnchor(candidate);
        if (isSuccessfulOpenStatus(opened.status)) {
          openedCount += 1;
        } else {
          stepWarnings.push({
            stepId: step.id,
            code: 'open_anchor_unsuccessful',
            message: unsuccessfulOpenMessage(opened, candidate),
          });
        }
        run.openedAnchors.push({
          ...opened,
          anchor: opened.anchor || candidate.anchor,
          status: opened.status,
          sourceStepId: candidate.sourceStepId,
          stepId: step.id,
        });
      } catch (error) {
        const message = errorMessage(error);
        run.openedAnchors.push({
          anchor: candidate.anchor,
          status: 'unsupported',
          sourceStepId: candidate.sourceStepId,
          stepId: step.id,
          error: message,
        });
        stepWarnings.push({ stepId: step.id, code: 'open_anchor_failed', message });
      }
    }

    run.warnings.push(...stepWarnings);
    run.steps.push({
      id: step.id,
      type: step.type,
      status: stepWarnings.length > 0 ? 'warning' : 'ok',
      startedAt,
      finishedAt: this.timestamp(),
      openedCount,
    });
  }

  private async runGraphResolveStep(
    step: PerspectiveGraphResolveStep,
    run: PerspectiveRun,
  ): Promise<PerspectiveAnchorCandidate[]> {
    const startedAt = this.timestamp();
    if (!this.deps.resolveGraph) {
      const warning = {
        stepId: step.id,
        code: 'graph_resolve_unavailable',
        message: `graph_resolve step "${step.id}" has no resolver dependency`,
      };
      run.warnings.push(warning);
      run.steps.push({
        id: step.id,
        type: step.type,
        status: 'warning',
        startedAt,
        finishedAt: this.timestamp(),
        queryOrAnchor: step.anchor,
      });
      return [];
    }

    try {
      const resolved = await this.deps.resolveGraph(step.anchor);
      const candidates = candidatesFromGraphResolution(resolved, step.id);
      run.candidateAnchors.push(...candidates);
      run.steps.push({
        id: step.id,
        type: step.type,
        status: resolved.status === 'no_match' ? 'warning' : 'ok',
        startedAt,
        finishedAt: this.timestamp(),
        queryOrAnchor: step.anchor,
        hitCount: candidates.length,
      });
      return candidates;
    } catch (error) {
      const message = errorMessage(error);
      run.warnings.push({ stepId: step.id, code: 'graph_resolve_failed', message });
      run.steps.push({
        id: step.id,
        type: step.type,
        status: 'warning',
        startedAt,
        finishedAt: this.timestamp(),
        queryOrAnchor: step.anchor,
      });
      return [];
    }
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

function searchOptionsFromStep(step: PerspectiveSearchEvidenceStep): SearchOptions {
  return {
    ...(step.scope ? { scope: step.scope } : {}),
    ...(step.mode ? { mode: step.mode } : {}),
    ...(step.depth ? { depth: step.depth } : {}),
    ...(step.limit ? { limit: step.limit } : {}),
    ...(step.dimension ? { dimension: step.dimension } : {}),
    ...(step.collections ? { collections: step.collections } : {}),
    ...(step.explain != null ? { explain: step.explain } : {}),
  };
}

function candidateFromEvidenceItem(
  item: EvidenceItem,
  sourceStepId: string,
  index: number,
): PerspectiveAnchorCandidate {
  return {
    anchor: item.anchor,
    title: item.title,
    ...(item.summary ? { summary: item.summary } : {}),
    ...(item.sourcePath ? { sourcePath: item.sourcePath } : {}),
    ...(item.drillDown ? { drillDown: item.drillDown } : {}),
    sourceStepId,
    rank: index + 1,
  };
}

function candidatesFromGraphResolution(
  resolved: PerspectiveGraphResolveResult,
  sourceStepId: string,
): PerspectiveAnchorCandidate[] {
  if (resolved.status === 'graph') {
    if (!resolved.anchor) return [];
    return [candidateFromGraphAnchor(resolved.anchor, resolved.anchor, sourceStepId, 0, resolved.drillDown)];
  }
  if (resolved.status === 'candidates') {
    if (!resolved.candidates) return [];
    return resolved.candidates.map((candidate, index) =>
      candidateFromGraphAnchor(
        candidate.anchor,
        graphCandidateTitle(candidate),
        sourceStepId,
        index,
        candidate.drillDown,
      ),
    );
  }
  return [];
}

function candidateFromGraphAnchor(
  anchor: string,
  title: string,
  sourceStepId: string,
  index: number,
  drillDown?: EvidenceDrillDown,
): PerspectiveAnchorCandidate {
  return {
    anchor,
    title,
    ...(drillDown ? { drillDown } : {}),
    sourceStepId,
    rank: index + 1,
  };
}

function graphCandidateTitle(candidate: { anchor: string; title?: string }): string {
  if (candidate.title && candidate.title.trim().length > 0) return candidate.title;
  return candidate.anchor;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSuccessfulOpenStatus(status: PerspectiveOpenedAnchor['status']): boolean {
  return status === 'opened' || status === 'route_identified';
}

function unsuccessfulOpenMessage(
  opened: Omit<PerspectiveOpenedAnchor, 'sourceStepId' | 'stepId'>,
  candidate: PerspectiveAnchorCandidate,
): string {
  if (opened.error) return opened.error;
  return `open_anchor returned ${opened.status} for ${candidate.anchor}`;
}
