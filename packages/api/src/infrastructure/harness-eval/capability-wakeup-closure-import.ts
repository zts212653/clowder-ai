import type { LifecycleRootArtifact } from './publish-verdict/lifecycle-root-artifact.js';
import type { ReevalClosureReconcileSubject } from './reeval-closure-reconciler.js';
import type { EvalLifecycleEvent, EvalLifecycleRef } from './reeval-closure-schema.js';

export const CAPABILITY_WAKEUP_HISTORICAL_VERDICT_ID = '2026-07-12-capability-wakeup-workspace-navigator-cognitive-fix';

const VERDICT_REF = `docs/harness-feedback/verdicts/${CAPABILITY_WAKEUP_HISTORICAL_VERDICT_ID}.md`;
const OWNER_RESPONSE_REF = 'thread:thread_eval_capability_wakeup:message:0001784195114335-000025-13f15128';

const root: LifecycleRootArtifact = {
  schemaVersion: 1,
  verdictId: CAPABILITY_WAKEUP_HISTORICAL_VERDICT_ID,
  domainId: 'eval:capability-wakeup',
  createdAt: '2026-07-12T03:24:01.034Z',
  verdict: 'fix',
  harnessUnderEval: {
    featureId: 'F203',
    componentId: 'workspace-navigator',
    name: 'workspace-navigator',
  },
  ownerAsk: {
    targetFeatureId: 'F203',
    targetOwnerCatId: 'opus-47',
    requestedAction: 'tighten workspace-navigator how-to and reachability guidance before re-evaluation',
  },
  acceptanceReevalPlan: {
    nextEvalAt: '2026-07-19T03:00:00.000Z',
    closureCondition: 'a later capability-wakeup verdict verifies the repaired behavior',
  },
};

const historicalRootUnavailable: EvalLifecycleRef = {
  kind: 'other',
  availability: 'unavailable',
  unavailableReason:
    'historical verdict predates lifecycle-root.json; root fields were recovered from durable verdict and owner evidence',
};

const resultUnavailable: EvalLifecycleRef = {
  kind: 'reeval',
  availability: 'unavailable',
  unavailableReason: '07-19 re-evaluation result and trusted eval principal were not available at import time',
};

const bootstrapEvents: readonly EvalLifecycleEvent[] = [
  {
    eventId: `f266:${CAPABILITY_WAKEUP_HISTORICAL_VERDICT_ID}:import:opened`,
    verdictId: CAPABILITY_WAKEUP_HISTORICAL_VERDICT_ID,
    domainId: 'eval:capability-wakeup',
    type: 'verdict_opened',
    actor: { kind: 'migration', id: 'f266-capability-wakeup-import' },
    occurredAt: '2026-07-12T03:24:01.034Z',
    reason: 'import the first real actionable verdict into the canonical lifecycle',
    refs: [{ kind: 'verdict', availability: 'available', value: VERDICT_REF }, historicalRootUnavailable],
  },
  {
    eventId: `f266:${CAPABILITY_WAKEUP_HISTORICAL_VERDICT_ID}:import:acknowledged`,
    verdictId: CAPABILITY_WAKEUP_HISTORICAL_VERDICT_ID,
    domainId: 'eval:capability-wakeup',
    type: 'owner_acknowledged',
    actor: { kind: 'cat', id: 'opus-47' },
    occurredAt: '2026-07-16T09:45:14.335Z',
    reason: 'F203 owner explicitly accepted the dropped verdict and began the fix',
    refs: [{ kind: 'message', availability: 'available', value: OWNER_RESPONSE_REF }],
  },
  {
    eventId: `f266:${CAPABILITY_WAKEUP_HISTORICAL_VERDICT_ID}:import:planned`,
    verdictId: CAPABILITY_WAKEUP_HISTORICAL_VERDICT_ID,
    domainId: 'eval:capability-wakeup',
    type: 'action_planned',
    actor: { kind: 'cat', id: 'opus-47' },
    occurredAt: '2026-07-16T09:45:14.336Z',
    reason: 'owner narrowed the repair to inline open/reveal semantics and the full trigger recipe',
    refs: [{ kind: 'message', availability: 'available', value: OWNER_RESPONSE_REF }],
  },
  {
    eventId: `f266:${CAPABILITY_WAKEUP_HISTORICAL_VERDICT_ID}:import:fixed`,
    verdictId: CAPABILITY_WAKEUP_HISTORICAL_VERDICT_ID,
    domainId: 'eval:capability-wakeup',
    type: 'fix_recorded',
    actor: { kind: 'cat', id: 'opus-47' },
    occurredAt: '2026-07-16T09:47:37.000Z',
    reason: 'the focused workspace-navigator how-to fix landed on origin/main',
    refs: [{ kind: 'commit', availability: 'available', value: '50ec90163' }],
  },
  {
    eventId: `f266:${CAPABILITY_WAKEUP_HISTORICAL_VERDICT_ID}:import:reeval-requested`,
    verdictId: CAPABILITY_WAKEUP_HISTORICAL_VERDICT_ID,
    domainId: 'eval:capability-wakeup',
    type: 'reeval_requested',
    actor: { kind: 'cat', id: 'opus-47' },
    occurredAt: '2026-07-16T09:47:38.000Z',
    dueAt: '2026-07-19T03:00:00.000Z',
    reason: 'owner handed the fix to the scheduled 07-19 capability-wakeup re-evaluation',
    refs: [{ kind: 'message', availability: 'available', value: OWNER_RESPONSE_REF }, resultUnavailable],
  },
];

export function buildCapabilityWakeupClosureImport(): ReevalClosureReconcileSubject {
  return {
    root,
    acknowledgeHours: 48,
    events: [],
    openRefs: bootstrapEvents[0].refs,
    bootstrapEvents,
  };
}
