import { existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import {
  getTemplateFileInfo,
  getTemplateOverlayPath,
} from '../domains/cats/services/context/prompt-template-loader.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { HookOverrideStore } from '../domains/prompt-hooks/HookOverrideStore.js';
import type { InjectionTraceStore } from '../domains/prompt-hooks/InjectionTraceStore.js';
import { getCachedRegistry, refreshOverrideSnapshot } from '../domains/prompt-hooks/PipelinePromptBuilder.js';
import type { ObjectiveEvaluationRuntime } from '../infrastructure/harness-eval/evaluation/ObjectiveEvaluationRuntime.js';
import type { GuardRejectionEventLog } from '../infrastructure/harness-eval/GuardRejectionEventLog.js';
import type { CycleGovernanceCoordinator } from '../infrastructure/harness-eval/governance/CycleGovernanceCoordinator.js';
import type { HarnessGovernanceProposalStore } from '../infrastructure/harness-eval/governance/HarnessGovernanceProposalStore.js';
import { harnessGovernanceCandidateRoutes } from './harness-governance-candidate-routes.js';
import { promptInjectionOverrideRoutes } from './prompt-injection-overrides.js';
import { segmentEvaluationRoutes } from './segment-evaluation.js';
import { segmentLifelineRoutes } from './segment-lifeline.js';
import { segmentLifelineReplayRoutes } from './segment-lifeline-replay.js';

export interface SegmentLifecycleSurfaceOptions {
  traceStore?: InjectionTraceStore;
  guardRejectionLog?: GuardRejectionEventLog;
  overrideStore?: HookOverrideStore;
  messageStore?: IMessageStore;
  threadStore?: IThreadStore;
  runtime?: ObjectiveEvaluationRuntime;
  governance?: CycleGovernanceCoordinator;
  proposals?: HarnessGovernanceProposalStore;
}

/**
 * Register the complete production-owned F257 segment journey as one surface.
 * Keeping the four plugins together prevents a rebuild from restoring an
 * internal evaluator route while silently dropping the Console entry/replay or
 * its governance executor.
 */
export async function registerSegmentLifecycleSurface(
  app: FastifyInstance,
  options: SegmentLifecycleSurfaceOptions,
): Promise<void> {
  await app.register(promptInjectionOverrideRoutes, {
    overrideStore: options.overrideStore,
    refreshOverrideSnapshot,
    runtime: options.runtime,
  });
  await app.register(harnessGovernanceCandidateRoutes, {
    governance: options.governance,
  });
  await app.register(segmentLifelineRoutes, {
    traceStore: options.traceStore,
    overrideStore: options.overrideStore,
    resolveManifestVersion: (segmentId) => getCachedRegistry()?.getHook(segmentId)?.manifest.version ?? 1,
    resolveSegmentName: (segmentId) => getCachedRegistry()?.getHook(segmentId)?.manifest.name ?? segmentId,
    resolveSegmentManifest: (segmentId) => {
      const manifest = getCachedRegistry()?.getHook(segmentId)?.manifest;
      if (!manifest) return null;
      const fileInfo = getTemplateFileInfo(segmentId);
      const overlayPath = getTemplateOverlayPath(segmentId);
      return {
        safetyTier: manifest.safetyTier,
        allowLocalOverride: !!fileInfo?.local,
        disableable: manifest.disableable,
        hasBackup: overlayPath ? existsSync(`${overlayPath}.bak`) : false,
      };
    },
  });
  await app.register(segmentEvaluationRoutes, { runtime: options.runtime, proposals: options.proposals });
  await app.register(segmentLifelineReplayRoutes, {
    traceStore: options.traceStore,
    guardRejectionLog: options.guardRejectionLog,
    messageStore: options.messageStore,
    threadStore: options.threadStore,
  });
}
