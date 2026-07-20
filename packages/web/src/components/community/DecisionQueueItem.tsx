import { useState } from 'react';
import { AlertOctagonIcon, CheckCircleIcon, FileTextIcon, HashIcon } from './community-icons';
import type {
  CommunityDecisionAction,
  CommunityDecisionPriority,
  CommunityDecisionQueueItemModel,
  CommunityDecisionQueueKind,
} from './decision-queue-types';

export interface DecisionQueueItemProps {
  item: CommunityDecisionQueueItemModel;
  expanded: boolean;
  actor: string;
  onToggle: () => void;
  onActionComplete: () => void;
  onOpenThread: (threadId: string) => void;
}

const PRIORITY_CLASSES: Record<CommunityDecisionPriority, string> = {
  urgent: 'border-conn-red-ring bg-conn-red-bg text-conn-red-text',
  high: 'border-conn-amber-ring bg-conn-amber-bg text-conn-amber-text',
  normal: 'border-cafe-border/50 bg-cafe-surface-elevated/50 text-cafe-secondary',
  low: 'border-cafe-subtle/30 bg-cafe-surface/60 text-cafe-muted',
};

const KIND_LABELS: Record<CommunityDecisionQueueKind, string> = {
  'direction-decision': 'Direction',
  'closure-action': 'Closure',
  'reconciliation-finding': 'Finding',
  'sla-dead-letter': 'SLA',
  'external-followup': 'Follow-up',
};

const EXTERNAL_ACTION_KINDS = new Set<CommunityDecisionAction['kind']>(['open-github', 'close-via-github']);
const AUDIT_ACTION_KINDS = new Set<CommunityDecisionAction['kind']>([
  'mark-reported',
  'waive-closure',
  'waive-finding',
]);

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`;
  return `${Math.floor(diff / 86_400_000)}天前`;
}

function isExternalUrl(endpoint: string | undefined): endpoint is string {
  return typeof endpoint === 'string' && /^https?:\/\//.test(endpoint);
}

function isExternalAction(action: CommunityDecisionAction): boolean {
  if (isExternalUrl(action.endpoint)) return true;
  return EXTERNAL_ACTION_KINDS.has(action.kind);
}

function usesAuditForm(action: CommunityDecisionAction): boolean {
  if (action.requiresAuditForm === true) return true;
  return AUDIT_ACTION_KINDS.has(action.kind);
}

function resolveDirectionAcceptBody(item: CommunityDecisionQueueItemModel): Record<string, unknown> {
  const body: Record<string, unknown> = { decision: 'accepted' };
  const assignedCatId = item.source.assignedCatId?.trim();
  if (assignedCatId) body.catId = assignedCatId;
  const routeRecommendation = item.source.routeRecommendation;
  if (routeRecommendation && routeRecommendation.kind !== 'decline') {
    body.routeRecommendation = routeRecommendation;
  }
  return body;
}

async function postAction(action: CommunityDecisionAction, body?: Record<string, unknown>): Promise<void> {
  if (!action.endpoint) throw new Error('Action endpoint is missing');
  const res = await fetch(action.endpoint, {
    method: action.method === 'GET' ? 'GET' : 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Action failed with ${res.status}`);
}

export function DecisionQueueItem({
  item,
  expanded,
  actor,
  onToggle,
  onActionComplete,
  onOpenThread,
}: DecisionQueueItemProps) {
  const [activeForm, setActiveForm] = useState<CommunityDecisionAction | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runAction = async (action: CommunityDecisionAction, body?: Record<string, unknown>) => {
    setPendingAction(action.kind);
    setError(null);
    try {
      await postAction(action, body);
      setActiveForm(null);
      onActionComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <article
      data-testid={`decision-item-${item.id}`}
      className={`rounded-lg border p-3 ${PRIORITY_CLASSES[item.priority]}`}
    >
      <button type="button" className="w-full text-left min-w-0" onClick={onToggle}>
        <div className="flex items-start gap-2 min-w-0">
          <span className="mt-0.5 shrink-0">
            {item.priority === 'urgent' ? <AlertOctagonIcon /> : <FileTextIcon />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5 text-micro uppercase tracking-wider">
              <span className="font-semibold">{item.priority}</span>
              <span className="text-cafe-muted">{KIND_LABELS[item.kind]}</span>
              <span className="text-cafe-muted">{item.actor}</span>
              <span className="text-cafe-muted">{relativeTime(item.lastUpdatedAt)}</span>
            </div>
            <h4
              data-testid={`decision-item-title-${item.id}`}
              className="mt-1 text-xs font-semibold text-cafe-primary break-words"
            >
              {item.title}
            </h4>
            <p className="mt-0.5 text-micro text-cafe-secondary break-words">{item.ask}</p>
          </div>
          <span className="text-micro text-cafe-muted shrink-0">{expanded ? '▾' : '▸'}</span>
        </div>
      </button>

      {expanded && (
        <div className="mt-3 space-y-3 min-w-0">
          <p className="text-xs text-cafe-secondary break-words">{item.why}</p>

          {item.evidenceRefs.length > 0 && (
            <div className="space-y-1">
              {item.evidenceRefs.map((evidence, index) => (
                <div
                  key={`${evidence.source}-${evidence.label}-${index}`}
                  data-testid={`decision-evidence-${item.id}-${index}`}
                  className="flex items-start gap-1.5 text-micro text-cafe-muted break-words"
                >
                  <span className="mt-0.5 shrink-0">
                    <HashIcon />
                  </span>
                  <span className="min-w-0 break-words">
                    <span className="font-medium text-cafe-secondary">{evidence.label}</span>
                    {evidence.text ? ` — ${evidence.text}` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {item.recommendedActions.map((action) => (
              <DecisionActionButton
                key={action.kind}
                item={item}
                action={action}
                pending={pendingAction === action.kind}
                onRun={runAction}
                onOpenThread={onOpenThread}
                onOpenForm={() => {
                  setError(null);
                  setActiveForm(action);
                }}
              />
            ))}
          </div>

          {activeForm && (
            <DecisionAuditForm
              action={activeForm}
              actor={actor}
              pending={pendingAction === activeForm.kind}
              onCancel={() => setActiveForm(null)}
              onSubmit={(body) => runAction(activeForm, body)}
            />
          )}

          {error && (
            <div data-testid={`decision-action-error-${item.id}`} className="text-micro text-conn-red-text">
              {error}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function DecisionActionButton({
  item,
  action,
  pending,
  onRun,
  onOpenThread,
  onOpenForm,
}: {
  item: CommunityDecisionQueueItemModel;
  action: CommunityDecisionAction;
  pending: boolean;
  onRun: (action: CommunityDecisionAction, body?: Record<string, unknown>) => void;
  onOpenThread: (threadId: string) => void;
  onOpenForm: () => void;
}) {
  const testId = `decision-action-${action.kind}-${item.id}`;
  if (action.kind === 'open-thread') {
    return (
      <button
        data-testid={testId}
        type="button"
        disabled={!action.threadId}
        onClick={() => {
          if (action.threadId) onOpenThread(action.threadId);
        }}
        className="inline-flex items-center gap-1 rounded-md border border-cafe-border/50 bg-cafe-surface px-2 py-1 text-micro font-medium text-cafe-secondary hover:bg-cafe-surface-elevated/70 disabled:opacity-40"
      >
        <FileTextIcon />
        {action.label}
      </button>
    );
  }

  if (isExternalAction(action)) {
    return (
      <a
        data-testid={testId}
        href={action.endpoint}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 rounded-md border border-cafe-border/50 bg-cafe-surface px-2 py-1 text-micro font-medium text-cafe-secondary hover:bg-cafe-surface-elevated/70"
      >
        {action.label}
      </a>
    );
  }

  if (action.kind === 'resolve-direction') {
    return (
      <>
        <button
          data-testid={`${testId}-accept`}
          type="button"
          disabled={pending}
          onClick={() => onRun(action, resolveDirectionAcceptBody(item))}
          className="rounded-md border border-conn-green-ring bg-conn-green-bg px-2 py-1 text-micro font-medium text-conn-green-text hover:bg-conn-green-hover disabled:opacity-40"
        >
          Accept
        </button>
        <button
          data-testid={`${testId}-decline`}
          type="button"
          disabled={pending}
          onClick={() => onRun(action, { decision: 'declined' })}
          className="rounded-md border border-cafe-border/50 bg-cafe-surface px-2 py-1 text-micro font-medium text-cafe-secondary hover:bg-cafe-surface-elevated/70 disabled:opacity-40"
        >
          Decline
        </button>
      </>
    );
  }

  if (usesAuditForm(action)) {
    return (
      <button
        data-testid={testId}
        type="button"
        disabled={pending}
        onClick={onOpenForm}
        className="rounded-md border border-cafe-border/50 bg-cafe-surface px-2 py-1 text-micro font-medium text-cafe-secondary hover:bg-cafe-surface-elevated/70 disabled:opacity-40"
      >
        {action.label}
      </button>
    );
  }

  return (
    <button
      data-testid={testId}
      type="button"
      disabled={pending}
      onClick={() => onRun(action)}
      className="inline-flex items-center gap-1 rounded-md border border-cafe-border/50 bg-cafe-surface px-2 py-1 text-micro font-medium text-cafe-secondary hover:bg-cafe-surface-elevated/70 disabled:opacity-40"
    >
      <CheckCircleIcon />
      {action.label}
    </button>
  );
}

function DecisionAuditForm({
  action,
  actor,
  pending,
  onCancel,
  onSubmit,
}: {
  action: CommunityDecisionAction;
  actor: string;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (body: Record<string, unknown>) => void;
}) {
  const [url, setUrl] = useState('');
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const isReport = action.kind === 'mark-reported';
  const canSubmit = isReport ? url.trim().length > 0 : reason.trim().length > 0 && evidence.trim().length > 0;
  const submitDisabled = pending ? true : !canSubmit;

  return (
    <form
      data-testid={`decision-audit-form-${action.kind}`}
      className="space-y-2 rounded-md border border-cafe-border/40 bg-cafe-surface/70 p-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit) return;
        onSubmit(
          isReport
            ? { publicCommentUrl: url.trim(), actor }
            : { reason: reason.trim(), evidence: evidence.trim(), actor },
        );
      }}
    >
      {isReport ? (
        <input
          data-testid={`decision-report-url-${action.kind}`}
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="Public comment URL"
          className="w-full rounded-md border border-cafe-border/40 bg-cafe-surface px-2 py-1 text-xs text-cafe-primary"
        />
      ) : (
        <>
          <input
            data-testid={`decision-waive-reason-${action.kind}`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Reason"
            className="w-full rounded-md border border-cafe-border/40 bg-cafe-surface px-2 py-1 text-xs text-cafe-primary"
          />
          <textarea
            data-testid={`decision-waive-evidence-${action.kind}`}
            value={evidence}
            onChange={(event) => setEvidence(event.target.value)}
            placeholder="Evidence"
            rows={2}
            className="w-full resize-none rounded-md border border-cafe-border/40 bg-cafe-surface px-2 py-1 text-xs text-cafe-primary"
          />
        </>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={submitDisabled}
          className="rounded-md bg-cafe-accent px-2 py-1 text-micro font-semibold text-cafe-surface disabled:opacity-40"
        >
          Submit
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-cafe-border/40 px-2 py-1 text-micro text-cafe-secondary"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
