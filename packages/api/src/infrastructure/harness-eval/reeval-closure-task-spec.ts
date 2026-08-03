import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { GateCtx, TaskSpec_P1 } from '../scheduler/types.js';
import {
  buildCapabilityWakeupClosureImport,
  CAPABILITY_WAKEUP_HISTORICAL_VERDICT_ID,
} from './capability-wakeup-closure-import.js';
import { loadDomains } from './hub/eval-hub-read-model.js';
import { scanLifecycleRootArtifacts } from './publish-verdict/lifecycle-root-artifact.js';
import { projectReevalCase } from './reeval-case.js';
import type { ReevalCaseResponsibilityService } from './reeval-case-responsibility.js';
import { lifecycleRootRefs } from './reeval-closure-bootstrap.js';
import type { IReevalClosureEventLog } from './reeval-closure-event-log.js';
import {
  type PlannedReevalClosureAppend,
  planReevalClosureEvents,
  type ReevalCaseReconcileSubject,
  type ReevalLifecycleReconcileSubject,
} from './reeval-closure-reconciler.js';

export interface ReevalClosureSubjectsLoaderOptions {
  harnessFeedbackRoot: string;
  eventLog: IReevalClosureEventLog;
  resolveAssignedEvalCatId?: (domainId: string, registryCatId: string) => Promise<string | undefined>;
}

export async function loadReevalClosureSubjects(
  options: ReevalClosureSubjectsLoaderOptions,
): Promise<ReevalLifecycleReconcileSubject[]> {
  const domains = loadDomains(options.harnessFeedbackRoot);
  const roots = scanLifecycleRootArtifacts(options.harnessFeedbackRoot);
  const historical = buildCapabilityWakeupClosureImport();
  const subjects: ReevalLifecycleReconcileSubject[] = [];
  const caseRoots = new Map<string, Extract<(typeof roots)[number], { schemaVersion: 2 }>[]>();

  for (const root of roots) {
    if (root.verdictId === historical.root.verdictId) continue;
    if (root.schemaVersion === 2) {
      const grouped = caseRoots.get(root.caseId) ?? [];
      grouped.push(root);
      caseRoots.set(root.caseId, grouped);
      continue;
    }
    const domain = domains.get(root.domainId);
    if (!domain) throw new Error(`lifecycle root ${root.verdictId} references unregistered domain ${root.domainId}`);
    const assignedEvalCatId =
      (await options.resolveAssignedEvalCatId?.(root.domainId, domain.evalCat.catId)) ?? domain.evalCat.catId;
    subjects.push({
      root,
      assignedEvalCatId,
      acknowledgeHours: domain.sla.acknowledgeHours,
      events: await options.eventLog.read(root.verdictId),
      openRefs: lifecycleRootRefs(root),
    });
  }

  for (const [caseId, groupedRoots] of caseRoots) {
    groupedRoots.sort(
      (left, right) => left.createdAt.localeCompare(right.createdAt) || left.verdictId.localeCompare(right.verdictId),
    );
    const first = groupedRoots[0];
    if (!first) continue;
    for (const candidate of groupedRoots.slice(1)) {
      if (
        candidate.domainId !== first.domainId ||
        candidate.findingKey !== first.findingKey ||
        candidate.ownerAsk.targetOwnerCatId !== first.ownerAsk.targetOwnerCatId
      ) {
        throw new Error(`case ${caseId} contains incompatible immutable lifecycle roots`);
      }
    }
    const domain = domains.get(first.domainId);
    if (!domain) throw new Error(`lifecycle case ${caseId} references unregistered domain ${first.domainId}`);
    const assignedEvalCatId =
      (await options.resolveAssignedEvalCatId?.(first.domainId, domain.evalCat.catId)) ?? domain.evalCat.catId;
    const caseSubject: ReevalCaseReconcileSubject = {
      caseRoot: {
        caseId,
        domainId: first.domainId,
        targetOwnerCatId: first.ownerAsk.targetOwnerCatId,
        assignedEvalCatId,
        cycles: groupedRoots.map((root) => ({
          verdictId: root.verdictId,
          createdAt: root.createdAt,
          verdict: root.verdict,
        })),
      },
      roots: groupedRoots,
      assignedEvalCatId,
      acknowledgeHours: domain.sla.acknowledgeHours,
      events: await options.eventLog.read(caseId),
      openRefsByVerdictId: new Map(groupedRoots.map((root) => [root.verdictId, lifecycleRootRefs(root)])),
      responsibilityContext: {
        systemThreadId: domain.systemThreadId,
        featureId: domain.handoffTargetResolver.featureId,
        evalCatId: assignedEvalCatId,
      },
    };
    subjects.push(caseSubject);
  }

  const historicalVerdictExists = existsSync(
    join(options.harnessFeedbackRoot, 'verdicts', `${CAPABILITY_WAKEUP_HISTORICAL_VERDICT_ID}.md`),
  );
  if (historicalVerdictExists) {
    const domain = domains.get(historical.root.domainId);
    if (!domain) {
      throw new Error(`historical lifecycle ${historical.root.verdictId} references an unregistered domain`);
    }
    const assignedEvalCatId =
      (await options.resolveAssignedEvalCatId?.(historical.root.domainId, domain.evalCat.catId)) ??
      domain.evalCat.catId;
    const backfilledRoot = roots.find((root) => root.verdictId === historical.root.verdictId);
    subjects.push({
      ...historical,
      assignedEvalCatId,
      ...(backfilledRoot ? { root: backfilledRoot, openRefs: lifecycleRootRefs(backfilledRoot) } : {}),
      events: await options.eventLog.read(historical.root.verdictId),
    });
  }
  return subjects.sort((left, right) => reconcileSubjectId(left).localeCompare(reconcileSubjectId(right)));
}

function reconcileSubjectId(subject: ReevalLifecycleReconcileSubject): string {
  return 'caseRoot' in subject ? subject.caseRoot.caseId : subject.root.verdictId;
}

interface ReevalClosureBatchSignal {
  planned: PlannedReevalClosureAppend[];
  bindResponsibility: boolean;
}

function caseNeedsResponsibility(
  subject: ReevalCaseReconcileSubject,
  planned: readonly PlannedReevalClosureAppend[],
): boolean {
  const events = [...subject.events, ...planned.map((item) => item.event)];
  if (events.length === 0) return false;
  const projection = projectReevalCase(subject.caseRoot, events);
  return (
    projection.status === 'open' ||
    (projection.status === 'escalated' && projection.escalation?.stage === 'acknowledgement')
  );
}

export interface ReevalClosureTaskSpecOptions {
  eventLog: IReevalClosureEventLog;
  loadSubjects: () => Promise<ReevalLifecycleReconcileSubject[]>;
  responsibilityService?: Pick<ReevalCaseResponsibilityService, 'reconcile'>;
  now?: () => string;
  pollIntervalMs?: number;
  log: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
}

export function createReevalClosureTaskSpec(
  options: ReevalClosureTaskSpecOptions,
): TaskSpec_P1<ReevalClosureBatchSignal> {
  const now = options.now ?? (() => new Date().toISOString());
  return {
    id: 'eval-verdict-closure-reconciler',
    profile: 'poller',
    trigger: { type: 'interval', ms: options.pollIntervalMs ?? 600_000 },
    admission: {
      async gate(_ctx: GateCtx) {
        const workItems = (await options.loadSubjects())
          .map((subject) => {
            const planned = planReevalClosureEvents(subject, now());
            const bindResponsibility =
              Boolean(options.responsibilityService) &&
              'caseRoot' in subject &&
              caseNeedsResponsibility(subject, planned);
            return { subject, planned, bindResponsibility };
          })
          .filter((candidate) => candidate.planned.length > 0 || candidate.bindResponsibility)
          .map(({ subject, planned, bindResponsibility }) => ({
            subjectKey: reconcileSubjectId(subject),
            dedupeKey:
              planned.map((item) => item.event.eventId).join('|') ||
              `f266:${reconcileSubjectId(subject)}:responsibility`,
            signal: { planned, bindResponsibility },
          }));
        if (workItems.length === 0) return { run: false, reason: 'no lifecycle events due' };
        return { run: true, workItems };
      },
    },
    run: {
      overlap: 'skip',
      timeoutMs: 60_000,
      async execute(signal, subjectKey) {
        for (const item of signal.planned) {
          const result = await options.eventLog.append(item.event, item.expectedSequence);
          if (result.outcome === 'conflict') {
            options.log.warn(
              `[eval-verdict-closure] CAS conflict for ${item.event.verdictId}: expected ${item.expectedSequence}, actual ${result.actualSequence}`,
            );
            return;
          }
          if (result.outcome === 'appended') {
            options.log.info(
              `[eval-verdict-closure] appended ${item.event.type} for ${item.event.verdictId} at ${result.sequence}`,
            );
          }
        }
        if (signal.bindResponsibility && options.responsibilityService) {
          const refreshed = (await options.loadSubjects()).find(
            (subject) => reconcileSubjectId(subject) === subjectKey && 'caseRoot' in subject,
          );
          if (refreshed && 'caseRoot' in refreshed) {
            await options.responsibilityService.reconcile(refreshed, refreshed.responsibilityContext);
          }
        }
      },
    },
    state: { runLedger: 'sqlite' },
    outcome: { whenNoSignal: 'drop' },
    enabled: () => true,
    display: {
      label: 'Eval Verdict Closure Reconciler',
      category: 'system',
      description: 'Opens actionable verdict lifecycles and resurfaces overdue acknowledgement or re-evaluation',
      subjectKind: 'none',
    },
  };
}
