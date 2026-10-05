import { contextualGitMutationCandidates } from './native-effect-git-context.mjs';
import { withoutInterpreterSource } from './native-effect-interpreter-source.mjs';
import {
  explicitSingleFileCopyTarget,
  isConstrainedLocalMediaObservation,
  isLocalMediaObservationCommand,
} from './native-effect-media-classifier.mjs';
import { decideNativeEffect, deny } from './native-effect-policy.mjs';
import { managedPreviewOperationDecision } from './native-effect-preview-classifier.mjs';
import { isShellStructure, segmentCommandText, segmentContexts } from './native-effect-segment-locations.mjs';
import { segmentView } from './native-effect-segment-view.mjs';
import {
  classifyShellSegment,
  constrainedGhPullRequestOperation,
  explicitTemporaryWorktreeTarget,
  isDataDrivenPipelineConsumer,
  SHELL_EFFECT_PRIORITY,
  splitPipelineSegments,
  splitShellExecutionSegmentsWithSeparators,
} from './native-effect-shell-classifier.mjs';
import { expandSegmentBindings, isShellBinding } from './native-effect-shell-expansion.mjs';
import { stripShellComments } from './native-effect-shell-tokenizer.mjs';
import { classifyNativeTarget as classifyTarget } from './native-effect-target-classifier.mjs';
import { worktreeRemovalDecision } from './native-effect-worktree-removal.mjs';

// Provenance: F306 AC-C7 -- how a shell command becomes candidates (per segment, per
// directory it can run in), moved out of native-effect-target-guard.mjs (slice 2b, pure move).

export function decideShellHookPayload(view, cwd, source) {
  const raw = stripShellComments(view.judged);
  const dataDrivenConsumer = splitPipelineSegments(raw).slice(1).find(isDataDrivenPipelineConsumer);
  if (dataDrivenConsumer) {
    const effect = classifyShellSegment(dataDrivenConsumer);
    const decision = decideNativeEffect({ effect, target: classifyTarget(raw, cwd, effect), source });
    if (decision.decision === 'deny') return decision;
  }
  const parts = splitShellExecutionSegmentsWithSeparators(raw);
  const segments = parts.map((part) => part.text);
  const mediaObservation = segments.find(isLocalMediaObservationCommand);
  if (mediaObservation && (segments.length !== 1 || !isConstrainedLocalMediaObservation(mediaObservation))) {
    const candidate = { effect: 'unknown', target: classifyTarget(raw, cwd, 'unknown'), source };
    if (decideNativeEffect(candidate).decision === 'deny') {
      return deny(candidate, 'unbounded_local_media_observation');
    }
  }
  // Each segment is judged in every directory it can run in (after its preceding `cd`s),
  // against its own target only. Nothing else in the text is its target (2026-09-27).
  const contexts = segmentContexts(parts, cwd);
  const units = (parts.length > 0 ? parts : [{ text: '', separator: null }]).map((part, index) => ({
    segment: isShellStructure(part.text) ? '' : segmentCommandText(part.text),
    contexts: contexts[index] ?? [{ directory: cwd, bindings: new Map() }],
  }));
  const previewDecisions = units.map(({ segment, contexts }) =>
    segmentPreviewDecision(
      segment,
      contexts.map(({ directory }) => directory),
    ),
  );
  const previewBoundary = deniedManagedPreviewBoundary(previewDecisions, segments, cwd, source);
  if (previewBoundary) return previewBoundary;
  const expanded = units.map(({ segment, contexts }) =>
    contexts.flatMap(({ directory, bindings }) =>
      expandSegmentBindings(isShellBinding(segment) ? '' : withoutInterpreterSource(segment), bindings).map(
        (variant) => ({ ...variant, directory }),
      ),
    ),
  );
  const candidates = expanded.flatMap((variants, index) =>
    variants.map(({ text, argvPreserved, directory }) =>
      segmentCandidate(text, directory, previewDecisions[index]?.operation, source, argvPreserved),
    ),
  );
  const decisions = candidates.map((candidate) => (candidate.decision ? candidate : decideNativeEffect(candidate)));
  const denied = decisions.find((decision) => decision.decision === 'deny');
  if (denied) return denied;
  const rank = (candidate) =>
    candidate.effect === 'unknown' ? -2 : (SHELL_EFFECT_PRIORITY.get(candidate.effect) ?? -1);
  return decisions.reduce((best, candidate) => (rank(candidate) > rank(best) ? candidate : best));
}

/** A preview operation is admitted only if every directory the segment can run in admits it. */
function segmentPreviewDecision(segment, locations) {
  const decisions = locations.map((location) => managedPreviewOperationDecision(segment, location));
  return decisions.find((decision) => decision?.status === 'deny') ?? decisions[0];
}

function segmentCandidate(segment, cwd, managedPreview, source, argvPreserved) {
  // Pure shell structure (`fi`, `done`, `}`) runs nothing of its own.
  if (!segment.trim()) return { effect: 'read', target: { kind: 'ordinary', value: cwd ?? '' }, source };
  const removal = worktreeRemovalDecision(segment, cwd, source, argvPreserved);
  if (removal) return removal;
  // A benign prefix can prevent the whole command from being a pure Git chain.
  // Its mutation segment still needs the same checkout/ancestor protection.
  const contextual = argvPreserved ? contextualGitMutationCandidates(segment, cwd) : null;
  if (contextual?.length === 1) return { ...contextual[0], source };
  const { command, location, targetCwd, targetText } = argvPreserved
    ? segmentView(segment, cwd)
    : { command: segment, location: cwd, targetCwd: cwd };
  const effect = bindingViewEffect(command, managedPreview, argvPreserved);
  const remoteOperation = argvPreserved && constrainedGhPullRequestOperation(command);
  const explicitTarget = argvPreserved
    ? (explicitTemporaryWorktreeTarget(command) ?? explicitSingleFileCopyTarget(command))
    : undefined;
  const locatedSource = location ? { ...source, cwd: location } : source;
  if (managedPreview)
    return { effect, target: { kind: 'ordinary', value: managedPreview.target }, source: locatedSource };
  if (remoteOperation)
    return { effect, target: { kind: 'remote_repository', value: remoteOperation.target }, source: locatedSource };
  const target = classifyTarget(
    explicitTarget ?? targetText ?? command,
    explicitTarget ? undefined : targetCwd,
    effect,
    explicitTarget,
  );
  return { effect, target, source: locatedSource };
}

function bindingViewEffect(command, managedPreview, argvPreserved) {
  const observed = managedPreview?.effect ?? classifyShellSegment(command);
  // A target-only view cannot prove a read, refresh or remote-only operation.
  // Keep recognised destructive effects so uncertain argv never downgrades a root denial.
  return !argvPreserved && ['read', 'repository_refresh', 'remote_mutation'].includes(observed) ? 'unknown' : observed;
}

function deniedManagedPreviewBoundary(decisions, segments, cwd, source) {
  const invalidIndex = decisions.findIndex((decision) => decision?.status === 'deny');
  const allowedIndex = decisions.findIndex((decision) => decision?.status === 'allow');
  const index = invalidIndex >= 0 ? invalidIndex : allowedIndex;
  if (index < 0) return null;
  if (invalidIndex < 0 && segments.length === 1) return null;
  const candidate = { effect: 'unknown', target: classifyTarget(segments[index], cwd, 'unknown'), source };
  return deny(candidate, 'unbounded_managed_preview_operation');
}
