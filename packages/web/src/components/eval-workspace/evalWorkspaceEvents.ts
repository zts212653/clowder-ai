import { currentEvalDueAt } from '../eval-lifecycle-display';
import type { EvalDomainSummary, EvalHubItem, EvalHubSummary } from '../HubEvalTypes';

export type EvalWorkspaceEventKind =
  | 'escalated'
  | 'needs_decision'
  | 'needs_action'
  | 'awaiting_reeval'
  | 'resolved'
  | 'watching';
export type EvalWorkspaceEventSeverity = 'critical' | 'attention' | 'info';

export interface EvalWorkspaceEvent {
  id: string;
  domainId: string;
  domainDisplayName: string;
  kind: EvalWorkspaceEventKind;
  severity: EvalWorkspaceEventSeverity;
  verdict: EvalHubItem['verdict'];
  title: string;
  summary: string;
  action: string;
  nextCheck: string;
  nextEvalAt?: string;
  metricGlossary?: EvalDomainSummary['metricGlossary'];
  lifecycle: EvalHubItem['lifecycle'];
  stale: boolean;
  source: EvalHubItem['source'];
  systemThreadId: string;
}

export function deriveEvalWorkspaceEvents(summary: EvalHubSummary): EvalWorkspaceEvent[] {
  const domains = new Map(summary.domains.map((domain) => [domain.domainId, domain]));
  const activeVerdictIds = new Set(
    summary.domains.flatMap((domain) => (domain.latestVerdictId ? [domain.latestVerdictId] : [])),
  );
  return summary.items
    .filter((item) => activeVerdictIds.has(item.id))
    .map((item) => toWorkspaceEvent(item, requireDomainSummary(item, domains)))
    .sort(compareEvents);
}

function requireDomainSummary(
  item: EvalHubItem,
  domains: Map<EvalDomainSummary['domainId'], EvalDomainSummary>,
): EvalDomainSummary {
  const domain = domains.get(item.domainId);
  if (!domain) throw new Error(`Eval Hub item ${item.id} references unknown domain ${item.domainId}`);
  return domain;
}

function toWorkspaceEvent(item: EvalHubItem, domain: EvalDomainSummary): EvalWorkspaceEvent {
  const kind = deriveEventKind(item);
  const domainDisplayName = domain.displayName;
  const nextEvalAt = currentEvalDueAt(item);
  return {
    id: item.id,
    domainId: item.domainId,
    domainDisplayName,
    kind,
    severity: severityFor(kind),
    verdict: item.verdict,
    title: item.operatorNarrative.headline,
    summary: item.operatorNarrative.summary,
    action: item.operatorNarrative.action,
    nextCheck: item.operatorNarrative.nextCheck,
    ...(nextEvalAt ? { nextEvalAt } : {}),
    ...(domain.metricGlossary ? { metricGlossary: domain.metricGlossary } : {}),
    lifecycle: item.lifecycle,
    stale: item.lifecycle.stale,
    source: item.source,
    systemThreadId: domain.systemThreadId,
  };
}

function deriveEventKind(item: EvalHubItem): EvalWorkspaceEventKind {
  const status = item.lifecycle.closureStatus;
  if (
    status !== 'escalated' &&
    status !== 'resolved' &&
    status !== 'suppressed_with_reason' &&
    (item.lifecycle.stale || item.lifecycle.reevalStatus === 'pending' || item.reeval.status === 'pending_reeval')
  ) {
    return 'awaiting_reeval';
  }
  switch (status) {
    case 'escalated':
      return 'escalated';
    case 'resolved':
    case 'suppressed_with_reason':
      return 'resolved';
    case 'reeval_pending':
    case 'live_active':
      return 'awaiting_reeval';
    case 'monitoring':
      return item.lifecycle.reevalDebtStatus === 'due' || item.lifecycle.reevalDebtStatus === 'in_progress'
        ? 'awaiting_reeval'
        : 'watching';
    case 'open':
    case 'acknowledged':
    case 'action_planned':
    case 'fix_landed':
    case 'main_landed':
      return item.verdict === 'delete_sunset' ? 'needs_decision' : 'needs_action';
    case 'observing':
    case 'unavailable':
      if (item.verdict === 'delete_sunset') return 'needs_decision';
      if (item.verdict === 'fix' || item.verdict === 'build') return 'needs_action';
      return 'watching';
  }
}

function severityFor(kind: EvalWorkspaceEventKind): EvalWorkspaceEventSeverity {
  if (kind === 'escalated') return 'critical';
  if (kind === 'needs_decision') return 'critical';
  if (kind === 'needs_action') return 'attention';
  if (kind === 'awaiting_reeval') return 'attention';
  return 'info';
}

function compareEvents(a: EvalWorkspaceEvent, b: EvalWorkspaceEvent): number {
  const rank: Record<EvalWorkspaceEventKind, number> = {
    escalated: 0,
    needs_decision: 1,
    needs_action: 2,
    awaiting_reeval: 3,
    resolved: 4,
    watching: 5,
  };
  return rank[a.kind] - rank[b.kind] || a.domainDisplayName.localeCompare(b.domainDisplayName);
}
