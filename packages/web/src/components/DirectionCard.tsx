'use client';

/**
 * F168 C3.2 — DirectionCard: renders narrator triage analysis + route actions.
 *
 * Shows inside CommunityPanel when a pending-decision issue has narrator
 * triage entries. Owner can accept/decline/discuss, override role assignment,
 * and the resolve call records a RouteDecisionEvalEvent (INV-13).
 */

import { useCallback, useState } from 'react';

import { ArrowIcon, ChatIcon, CheckIcon, DocIcon, NarratorIcon, PlusIcon, XIcon } from './DirectionCardIcons';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface QuestionResult {
  id: string;
  result: 'PASS' | 'WARN' | 'FAIL' | 'UNKNOWN';
}

interface RouteRecommendation {
  kind: 'existing-thread' | 'new-thread' | 'decline';
  threadId?: string;
}

interface TriageEntry {
  catId: string;
  verdict: 'WELCOME' | 'NEEDS-DISCUSSION' | 'POLITELY-DECLINE';
  questions: QuestionResult[];
  authoredByRole?: string;
  narrative?: string;
  evidenceRefs?: string[];
  routeRecommendation?: RouteRecommendation;
  recommendedOwnerRole?: string;
}

interface DirectionCardPayload {
  entries: TriageEntry[];
  consensus?: { verdict: string };
}

export interface DirectionCardProps {
  issueId: string;
  directionCard: DirectionCardPayload;
  onResolve: (
    issueId: string,
    decision: 'accepted' | 'declined',
    opts?: {
      routeRecommendation?: RouteRecommendation;
    },
  ) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const VERDICT_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  WELCOME: { bg: 'bg-green-500/10', text: 'text-green-600 dark:text-green-400', label: 'WELCOME' },
  'NEEDS-DISCUSSION': { bg: 'bg-amber-500/10', text: 'text-amber-600 dark:text-amber-400', label: 'NEEDS-DISCUSSION' },
  'POLITELY-DECLINE': { bg: 'bg-red-500/10', text: 'text-red-600 dark:text-red-400', label: 'POLITELY-DECLINE' },
};

const Q_STYLES: Record<string, { bg: string; text: string }> = {
  PASS: { bg: 'bg-green-500/10', text: 'text-green-600 dark:text-green-400' },
  WARN: { bg: 'bg-amber-500/10', text: 'text-amber-600 dark:text-amber-400' },
  FAIL: { bg: 'bg-red-500/10', text: 'text-red-600 dark:text-red-400' },
  UNKNOWN: { bg: 'bg-gray-500/10', text: 'text-gray-500' },
};

const Q_LABELS: Record<string, string> = {
  Q1: 'Q1',
  Q2: 'Q2',
  Q3: 'Q3',
  Q4: 'Q4',
  Q5: 'Q5',
};

function QuestionGrid({ questions }: { questions: QuestionResult[] }) {
  return (
    <div className="grid grid-cols-5 gap-1 mb-2">
      {questions.map((q) => {
        const style = Q_STYLES[q.result] ?? Q_STYLES.UNKNOWN;
        return (
          <div key={q.id} data-testid={`q-${q.id}`} className={`text-center py-1 rounded ${style.bg}`}>
            <span className="block text-micro text-cafe-muted">{Q_LABELS[q.id] ?? q.id}</span>
            <span className={`text-micro font-semibold ${style.text}`}>{q.result}</span>
          </div>
        );
      })}
    </div>
  );
}

function EvidenceRefs({ refs }: { refs: string[] }) {
  if (refs.length === 0) return null;
  return (
    <div className="mb-2">
      <div className="text-micro font-semibold text-cafe-muted uppercase tracking-wider mb-1">Evidence</div>
      <div className="flex flex-wrap gap-1">
        {refs.map((ref) => (
          <span
            key={ref}
            className="text-micro px-1.5 py-0.5 rounded bg-cafe-surface-sunken text-cafe-secondary border border-cafe-subtle/30 flex items-center gap-1"
          >
            <DocIcon />
            {ref}
          </span>
        ))}
      </div>
    </div>
  );
}

const ROLE_OPTIONS = ['case-owner', 'narrator', 'reconciler'] as const;

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function DirectionCard({ issueId, directionCard, onResolve }: DirectionCardProps) {
  const [resolving, setResolving] = useState(false);

  // Find the narrator entry (authoredByRole === 'narrator')
  const narratorEntry = directionCard.entries.find((e) => e.authoredByRole === 'narrator');

  const routeRec = narratorEntry?.routeRecommendation;

  // useCallback must be called before any early return (React hooks rules)
  const handleResolve = useCallback(
    async (decision: 'accepted' | 'declined') => {
      setResolving(true);
      try {
        await onResolve(issueId, decision, {
          routeRecommendation:
            decision === 'accepted' && routeRec && routeRec.kind !== 'decline' ? routeRec : undefined,
        });
      } finally {
        setResolving(false);
      }
    },
    [issueId, onResolve, routeRec],
  );

  // If no narrator entry, don't render anything
  if (!narratorEntry) return null;

  const verdict = narratorEntry.verdict;
  const verdictStyle = VERDICT_STYLES[verdict] ?? VERDICT_STYLES.WELCOME;
  const isDecline = verdict === 'POLITELY-DECLINE';
  const borderColor = isDecline ? 'border-l-red-500' : 'border-l-cafe-accent';

  return (
    <div
      data-testid={`direction-card-${issueId}`}
      className={`mx-3 mb-2 bg-cafe-surface-canvas border border-cafe-subtle/40 ${borderColor} border-l-[3px] rounded-lg p-3 shadow-sm animate-in fade-in slide-in-from-top-1 duration-200`}
    >
      {/* Header: badges */}
      <div className="flex items-center gap-2 mb-2">
        <span className="text-micro font-semibold px-1.5 py-0.5 rounded-full bg-purple-500/10 text-purple-600 dark:text-purple-400 flex items-center gap-1">
          <NarratorIcon />
          narrator
        </span>
        <span className={`text-micro font-semibold px-1.5 py-0.5 rounded-full ${verdictStyle.bg} ${verdictStyle.text}`}>
          {verdictStyle.label}
        </span>
      </div>

      {/* Narrative */}
      {narratorEntry.narrative && (
        <div className="text-xs text-cafe-text leading-relaxed mb-2 p-2 bg-cafe-surface-elevated rounded border border-cafe-subtle/20">
          {narratorEntry.narrative}
        </div>
      )}

      {/* 5-question results */}
      <QuestionGrid questions={narratorEntry.questions} />

      {/* Evidence refs */}
      {narratorEntry.evidenceRefs && <EvidenceRefs refs={narratorEntry.evidenceRefs} />}

      {/* Route recommendation + role dropdown */}
      {routeRec && (
        <div className="flex items-center gap-2 p-2 bg-cafe-surface-sunken rounded border border-cafe-subtle/20 mb-2">
          <span className="text-micro font-semibold text-cafe-muted whitespace-nowrap">Route</span>
          <span className="text-xs font-medium text-cafe-interactive flex items-center gap-1">
            {routeRec.kind === 'existing-thread' && (
              <>
                <ArrowIcon />
                {routeRec.threadId}
              </>
            )}
            {routeRec.kind === 'new-thread' && (
              <>
                <PlusIcon />
                New thread
              </>
            )}
            {routeRec.kind === 'decline' && (
              <>
                <XIcon />
                Decline
              </>
            )}
          </span>
          <span className="flex-1" />
          <span className="text-micro font-semibold text-cafe-muted">Role</span>
          <select
            data-testid={`role-select-${issueId}`}
            defaultValue={narratorEntry.recommendedOwnerRole ?? 'case-owner'}
            disabled
            title="Role assignment — Phase D"
            className="text-micro px-1.5 py-1 rounded border border-cafe-subtle/30 bg-cafe-surface-canvas text-cafe-secondary disabled:opacity-50"
          >
            {ROLE_OPTIONS.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-1.5" data-testid={`direction-actions-${issueId}`}>
        {isDecline ? (
          <>
            <button
              type="button"
              data-testid={`btn-decline-${issueId}`}
              disabled={resolving}
              onClick={() => handleResolve('declined')}
              className="text-micro font-semibold px-3 py-1.5 rounded border border-red-500/30 text-red-600 dark:text-red-400 bg-cafe-surface-canvas hover:border-red-500 transition-colors flex items-center gap-1 disabled:opacity-50"
            >
              <XIcon />
              Decline
            </button>
            <button
              type="button"
              data-testid={`btn-discuss-${issueId}`}
              disabled
              title="Discuss workflow — Phase D"
              className="text-micro font-semibold px-3 py-1.5 rounded border border-amber-500/30 text-amber-600 dark:text-amber-400 bg-cafe-surface-canvas transition-colors flex items-center gap-1 disabled:opacity-50"
            >
              <ChatIcon />
              Discuss
            </button>
            <span className="flex-1" />
            <button
              type="button"
              data-testid={`btn-override-accept-${issueId}`}
              disabled={resolving}
              onClick={() => handleResolve('accepted')}
              className="text-micro font-semibold px-3 py-1.5 rounded border border-transparent text-green-600/40 dark:text-green-400/40 bg-cafe-surface-canvas hover:text-green-600 hover:border-green-500/30 transition-colors flex items-center gap-1 disabled:opacity-50"
            >
              <CheckIcon />
              Override: Accept
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              data-testid={`btn-accept-${issueId}`}
              disabled={resolving}
              onClick={() => handleResolve('accepted')}
              className="text-micro font-semibold px-3 py-1.5 rounded bg-green-600 text-white hover:bg-green-700 transition-colors flex items-center gap-1 disabled:opacity-50"
            >
              {routeRec?.kind === 'new-thread' ? <PlusIcon /> : <CheckIcon />}
              {routeRec?.kind === 'new-thread' ? 'Accept: New Thread' : 'Accept Route'}
            </button>
            <button
              type="button"
              data-testid={`btn-discuss-${issueId}`}
              disabled
              title="Discuss workflow — Phase D"
              className="text-micro font-semibold px-3 py-1.5 rounded border border-amber-500/30 text-amber-600 dark:text-amber-400 bg-cafe-surface-canvas transition-colors flex items-center gap-1 disabled:opacity-50"
            >
              <ChatIcon />
              Discuss
            </button>
            <button
              type="button"
              data-testid={`btn-decline-${issueId}`}
              disabled={resolving}
              onClick={() => handleResolve('declined')}
              className="text-micro font-semibold px-3 py-1.5 rounded border border-cafe-subtle/30 text-cafe-muted bg-cafe-surface-canvas hover:border-red-500/30 hover:text-red-600 transition-colors flex items-center gap-1 disabled:opacity-50"
            >
              <XIcon />
              Decline
            </button>
          </>
        )}
      </div>
    </div>
  );
}
