import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskSpec_P1 } from '../scheduler/types.js';
import { createRetiredAutomaticEvalSpec } from './automatic-eval-retirement.js';
import {
  buildCapabilityWakeupClosureImport,
  CAPABILITY_WAKEUP_HISTORICAL_VERDICT_ID,
} from './capability-wakeup-closure-import.js';
import { loadDomains } from './hub/eval-hub-read-model.js';
import { loadLifecycleRootsWithLegacyCases, migrationForCase } from './legacy-reeval-case-migration.js';
import { compareReevalCycles } from './reeval-case-cycle-order.js';
import type { ReevalCaseReevaluationService } from './reeval-case-reevaluation.js';
import type { ReevalCaseResponsibilityService } from './reeval-case-responsibility.js';
import { lifecycleRootRefs } from './reeval-closure-bootstrap.js';
import type { IReevalClosureEventLog } from './reeval-closure-event-log.js';
import { type ReevalCaseReconcileSubject, type ReevalLifecycleReconcileSubject } from './reeval-closure-reconciler.js';

export interface ReevalClosureSubjectsLoaderOptions {
  harnessFeedbackRoot: string;
  eventLog: IReevalClosureEventLog;
  resolveAssignedEvalCatId?: (domainId: string, registryCatId: string) => Promise<string | undefined>;
  frictionV3Cutover?: { lifecycleVersion: 1 };
}

export async function loadReevalClosureSubjects(
  options: ReevalClosureSubjectsLoaderOptions,
): Promise<ReevalLifecycleReconcileSubject[]> {
  const domains = loadDomains(options.harnessFeedbackRoot);
  const historical = buildCapabilityWakeupClosureImport();
  const historicalBootstrapEvents = historical.bootstrapEvents ?? [];
  const historicalVerdictExists = existsSync(
    join(options.harnessFeedbackRoot, 'verdicts', `${CAPABILITY_WAKEUP_HISTORICAL_VERDICT_ID}.md`),
  );
  const roots = loadLifecycleRootsWithLegacyCases(options.harnessFeedbackRoot);
  const subjects: ReevalLifecycleReconcileSubject[] = [];
  const caseRoots = new Map<string, Extract<(typeof roots)[number], { schemaVersion: 2 | 3 }>[]>();

  for (const root of roots) {
    if (root.verdictId === historical.root.verdictId && root.schemaVersion === 1) continue;
    if (root.schemaVersion === 3 && options.frictionV3Cutover?.lifecycleVersion !== 1) continue;
    if (root.schemaVersion === 2 || root.schemaVersion === 3) {
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
    groupedRoots.sort(compareReevalCycles);
    const first = groupedRoots[0];
    if (!first) continue;
    for (const candidate of groupedRoots.slice(1)) {
      if (
        candidate.domainId !== first.domainId ||
        candidate.findingKey !== first.findingKey ||
        candidate.harnessUnderEval.featureId !== first.harnessUnderEval.featureId
      ) {
        throw new Error(`case ${caseId} contains incompatible immutable lifecycle roots`);
      }
    }
    const domain = domains.get(first.domainId);
    if (!domain) throw new Error(`lifecycle case ${caseId} references unregistered domain ${first.domainId}`);
    const assignedEvalCatId =
      (await options.resolveAssignedEvalCatId?.(first.domainId, domain.evalCat.catId)) ?? domain.evalCat.catId;
    const migration = migrationForCase(options.harnessFeedbackRoot, caseId);
    const caseSubject: ReevalCaseReconcileSubject = {
      caseRoot: {
        caseId,
        domainId: first.domainId,
        targetOwnerCatId:
          first.schemaVersion === 3 ? first.repairTarget.ownerCatId : domain.handoffTargetResolver.ownerCatId,
        assignedEvalCatId,
        reevalWithinHours: domain.sla.reevalWithinHours,
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
      openRefsByVerdictId: new Map(
        groupedRoots.map((root) => [
          root.verdictId,
          root.verdictId === historical.root.verdictId ? historical.openRefs : lifecycleRootRefs(root),
        ]),
      ),
      responsibilityContext: {
        systemThreadId: domain.systemThreadId,
        featureId: first.schemaVersion === 3 ? first.repairTarget.featureId : domain.handoffTargetResolver.featureId,
        ownerCatId: first.schemaVersion === 3 ? first.repairTarget.ownerCatId : domain.handoffTargetResolver.ownerCatId,
        evalCatId: assignedEvalCatId,
      },
      ...(migration ? { legacyMigration: migration.freshnessReview } : {}),
      ...(groupedRoots.some((root) => root.verdictId === historical.root.verdictId)
        ? {
            legacyContinuity: {
              ownerResponseRefs: historicalBootstrapEvents
                .filter((event) => event.type === 'owner_acknowledged')
                .flatMap((event) => event.refs),
              planRefs: historicalBootstrapEvents
                .filter((event) => event.type === 'action_planned')
                .flatMap((event) => event.refs),
              actionRefs: historicalBootstrapEvents
                .filter((event) => event.type === 'fix_recorded')
                .flatMap((event) => event.refs),
              reevalRefs: historicalBootstrapEvents
                .filter((event) => event.type === 'reeval_requested')
                .flatMap((event) => event.refs),
            },
          }
        : {}),
    };
    subjects.push(caseSubject);
  }

  const historicalRoot = roots.find((root) => root.verdictId === historical.root.verdictId);
  if (historicalVerdictExists && historicalRoot?.schemaVersion !== 2 && historicalRoot?.schemaVersion !== 3) {
    const domain = domains.get(historical.root.domainId);
    if (!domain) {
      throw new Error(`historical lifecycle ${historical.root.verdictId} references an unregistered domain`);
    }
    const assignedEvalCatId =
      (await options.resolveAssignedEvalCatId?.(historical.root.domainId, domain.evalCat.catId)) ??
      domain.evalCat.catId;
    subjects.push({
      ...historical,
      assignedEvalCatId,
      ...(historicalRoot?.schemaVersion === 1
        ? { root: historicalRoot, openRefs: lifecycleRootRefs(historicalRoot) }
        : {}),
      events: await options.eventLog.read(historical.root.verdictId),
    });
  }
  return subjects.sort((left, right) => reconcileSubjectId(left).localeCompare(reconcileSubjectId(right)));
}

function reconcileSubjectId(subject: ReevalLifecycleReconcileSubject): string {
  return 'caseRoot' in subject ? subject.caseRoot.caseId : subject.root.verdictId;
}

export interface ReevalClosureTaskSpecOptions {
  eventLog: IReevalClosureEventLog;
  loadSubjects: () => Promise<ReevalLifecycleReconcileSubject[]>;
  responsibilityService?: Pick<ReevalCaseResponsibilityService, 'reconcile'>;
  reevaluationService?: Pick<ReevalCaseReevaluationService, 'needsReconcile' | 'reconcile'>;
  now?: () => string;
  pollIntervalMs?: number;
  log: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
}

export function createReevalClosureTaskSpec(options?: ReevalClosureTaskSpecOptions): TaskSpec_P1<unknown> {
  return createRetiredAutomaticEvalSpec({
    id: 'eval-verdict-closure-reconciler',
    profile: 'poller',
    trigger: { type: 'interval', ms: options?.pollIntervalMs ?? 600_000 },
    label: 'Eval Verdict Closure Reconciler（自动运行已退役）',
  });
}
