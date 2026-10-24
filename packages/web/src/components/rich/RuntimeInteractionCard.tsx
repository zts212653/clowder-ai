'use client';

import type { RuntimeInteractionRecord, RuntimeInteractionResponse } from '@cat-cafe/shared';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import type { RichCardBlock } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import { mailboxRuntimeCopy } from '../shell/mailbox/mailbox-runtime.shell-copy';
import { useShellCopy } from '../shell/shell-copy';
import { useShellPresentation } from '../shell/shell-presentation';
import { ApprovalResultRow } from './ApprovalResultRow';
import { decisionResultCopy } from './decision-result.shell-copy';
import { CLASSIC_RUNTIME_INTERACTION_COPY, type RuntimeInteractionCopy } from './RuntimeInteractionCopy';
import { RuntimeInteractionDecisionActions } from './RuntimeInteractionDecisionActions';
import { RuntimeInteractionElicitationForm } from './RuntimeInteractionElicitationForm';
import { RuntimeInteractionQuestionForm } from './RuntimeInteractionQuestionForm';
import { RuntimeInteractionRequestDetails } from './RuntimeInteractionRequestDetails';
import { runtimeDecisionResult } from './runtime-decision-result';

export function isRuntimeInteractionCardBlock(block: RichCardBlock): boolean {
  return block.meta?.kind === 'runtime_interaction' && typeof block.meta.interactionId === 'string';
}

export interface RuntimeInteractionHostRead {
  ownerUserId: string;
  revision: number;
  cardRef: NonNullable<RuntimeInteractionRecord['cardRef']>;
  readCurrent: boolean;
}
export function RuntimeInteractionCard({
  block,
  messageId,
  host,
  copy: suppliedCopy,
  presentation,
  secondaryActions,
}: {
  block: RichCardBlock;
  messageId?: string;
  host?: RuntimeInteractionHostRead;
  copy?: RuntimeInteractionCopy;
  presentation?: 'mailbox';
  secondaryActions?: ReactNode;
}) {
  const shellCopy = useShellCopy(mailboxRuntimeCopy);
  const resultCopy = useShellCopy(decisionResultCopy);
  const isV2 = useShellPresentation() === 'v2';
  const copy = suppliedCopy ?? (isV2 ? shellCopy : CLASSIC_RUNTIME_INTERACTION_COPY);
  const interactionId = String(block.meta?.interactionId ?? '');
  const [record, setRecord] = useState<RuntimeInteractionRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchGeneration = useRef(0);
  const submittingRef = useRef(false);

  const hydrate = useCallback(async () => {
    const generation = ++fetchGeneration.current;
    setLoading(true);
    try {
      const response = await apiFetch(`/api/runtime-interactions/${encodeURIComponent(interactionId)}`);
      if (!response.ok) throw new Error(copy.syncFailed);
      const body = (await response.json()) as { interaction: RuntimeInteractionRecord };
      if (fetchGeneration.current === generation && !submittingRef.current) {
        setRecord(body.interaction);
        setError(null);
      }
    } catch (caught) {
      if (fetchGeneration.current === generation) setError(errorMessage(caught));
    } finally {
      if (fetchGeneration.current === generation) setLoading(false);
    }
  }, [interactionId, copy]);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<{ interactionId?: string }>).detail;
      if (detail?.interactionId === interactionId) void hydrate();
    };
    window.addEventListener('cat-cafe:runtime-interaction-updated', handler);
    return () => window.removeEventListener('cat-cafe:runtime-interaction-updated', handler);
  }, [hydrate, interactionId]);

  const submitMutation = async (suffix: 'respond' | 'reject', payload: Record<string, unknown>): Promise<void> => {
    if (!record?.cardRef || submittingRef.current || (host && (!hostAligned || loading))) return;
    submittingRef.current = true;
    fetchGeneration.current += 1;
    setSubmitting(true);
    setError(null);
    try {
      const response = await apiFetch(`/api/runtime-interactions/${encodeURIComponent(interactionId)}/${suffix}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const responseBody = await readSubmitBody(response);
      if (response.status === 409) {
        submittingRef.current = false;
        setSubmitting(false);
        await hydrate();
        return;
      }
      if (!response.ok || !responseBody.interaction) throw new Error(responseBody.error ?? copy.submitFailed);
      fetchGeneration.current += 1;
      setRecord(responseBody.interaction);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };
  const submit = async (runtimeResponse: RuntimeInteractionResponse): Promise<void> => {
    if (!record?.cardRef) return;
    await submitMutation('respond', { cardRef: record.cardRef, response: runtimeResponse });
  };
  const reject = async (): Promise<void> => {
    if (!record?.cardRef) return;
    await submitMutation('reject', { cardRef: record.cardRef });
  };

  const hostOwnerMatches =
    !host ||
    Boolean(
      record &&
        record.request.owner.userId === host.ownerUserId &&
        record.request.owner.threadId === host.cardRef.threadId &&
        record.cardRef?.threadId === host.cardRef.threadId &&
        record.cardRef.messageId === host.cardRef.messageId &&
        record.cardRef.blockId === host.cardRef.blockId,
    );
  const hostAligned = !host || Boolean(host.readCurrent && hostOwnerMatches && record?.updatedAt === host.revision);
  const canonical =
    record?.request.kind !== 'conversation_decision' &&
    hostOwnerMatches &&
    Boolean(record?.cardRef && messageId === record.cardRef.messageId && block.id === record.cardRef.blockId);

  if (
    (isV2 || presentation === 'mailbox') &&
    record &&
    canonical &&
    record.status !== 'staged' &&
    record.status !== 'pending'
  ) {
    const result = runtimeDecisionResult(record, resultCopy, copy);
    return (
      <section data-testid="runtime-interaction-card">
        <ApprovalResultRow status={result.status} label={result.label}>
          <RuntimeInteractionRequestDetails request={record.request} terminal={record.terminal} />
          {error ? <p role="alert">{error}</p> : null}
          {secondaryActions}
        </ApprovalResultRow>
      </section>
    );
  }
  return (
    <section
      className={
        presentation === 'mailbox' ? 'space-y-3' : 'rounded-2xl border border-cafe bg-cafe-surface p-3 shadow-sm'
      }
      data-testid="runtime-interaction-card"
    >
      <header className="mb-3 flex items-start gap-2">
        <div className="min-w-0">
          {presentation !== 'mailbox' && (
            <p className="text-micro font-medium text-[var(--semantic-info)]">
              {
                copy.kind[
                  record?.request.kind === 'conversation_decision' ? 'unknown' : (record?.request.kind ?? 'unknown')
                ]
              }
            </p>
          )}
          <h3 className="text-sm font-semibold">{record?.request.title ?? block.title}</h3>
          {record?.request.description ? (
            <p className="mt-1 whitespace-pre-wrap break-words text-xs text-cafe-muted">{record.request.description}</p>
          ) : null}
        </div>
        <span className="ml-auto text-micro text-cafe-muted">{copy.status[record?.status ?? 'staged']}</span>
      </header>

      {loading && !record ? <p className="text-sm text-cafe-muted">{copy.loading}</p> : null}
      {error ? <p className="mb-2 text-sm text-[var(--semantic-critical)]">{error}</p> : null}
      {record && record.status === 'staged' ? <p className="text-sm text-cafe-muted">{copy.preparing}</p> : null}
      {record && record.status !== 'staged' && (!canonical || (host && !hostAligned && record.status === 'pending')) ? (
        <p className="text-sm text-cafe-muted">{copy.readonly}</p>
      ) : null}
      {record && canonical && record.status !== 'staged' && record.status !== 'pending' ? (
        <TerminalState record={record} copy={copy} />
      ) : null}
      {record && canonical && record.status === 'pending' ? (
        <PendingSurface
          record={record}
          disabled={submitting || (host !== undefined && (!hostAligned || loading))}
          copy={copy}
          presentation={presentation}
          secondaryActions={secondaryActions}
          onSubmit={(response) => void submit(response)}
          onReject={() => void reject()}
        />
      ) : null}
      {(!record || record.status !== 'pending' || !canonical || record.request.kind !== 'question') &&
      secondaryActions ? (
        <div className="flex items-center">{secondaryActions}</div>
      ) : null}
    </section>
  );
}

function PendingSurface({
  record,
  disabled,
  onSubmit,
  onReject,
  copy,
  presentation,
  secondaryActions,
}: {
  copy: RuntimeInteractionCopy;
  presentation?: 'mailbox';
  secondaryActions?: ReactNode;
  record: RuntimeInteractionRecord;
  disabled: boolean;
  onSubmit: (response: RuntimeInteractionResponse) => void;
  onReject: () => void;
}) {
  const request = record.request;
  if (request.kind === 'conversation_decision') return null;
  if (request.kind === 'question') {
    return (
      <RuntimeInteractionQuestionForm
        request={request}
        disabled={disabled}
        onSubmit={onSubmit}
        onReject={onReject}
        copy={copy.form}
        presentation={presentation}
        secondaryActions={secondaryActions}
      />
    );
  }
  if (request.kind === 'elicitation') {
    return (
      <RuntimeInteractionElicitationForm
        request={request}
        disabled={disabled}
        onSubmit={onSubmit}
        copy={copy.elicitation}
      />
    );
  }
  return (
    <RuntimeInteractionDecisionActions
      decisions={request.decisions}
      disabled={disabled}
      onSelect={(decision) => onSubmit({ kind: 'decision', decisionId: decision.id })}
    />
  );
}

function TerminalState({ record, copy }: { record: RuntimeInteractionRecord; copy: RuntimeInteractionCopy }) {
  return <p className="text-sm text-cafe-muted">{terminalCopy(record, copy)}</p>;
}

function terminalCopy(record: RuntimeInteractionRecord, copy: RuntimeInteractionCopy): string {
  if (record.status === 'answered')
    return record.request.kind === 'question' ? copy.terminal.answered : copy.terminal.handled;
  const reason = record.terminal?.reasonCode;
  if (reason === 'user_rejected') return copy.terminal.rejected;
  if (reason === 'user_cancelled') return copy.terminal.cancelled;
  if (reason === 'host_restarted') return copy.terminal.restarted;
  if (reason === 'transport_lost') return copy.terminal.lost;
  if (reason === 'confirmation_unavailable') return copy.terminal.unavailable;
  if (reason === 'surface_publication_failed') return copy.terminal.publicationFailed;
  return copy.terminal.invalid;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readSubmitBody(
  response: Response,
): Promise<{ interaction?: RuntimeInteractionRecord; error?: string; reasonCode?: string }> {
  try {
    const body = (await response.json()) as unknown;
    return body && typeof body === 'object'
      ? (body as { interaction?: RuntimeInteractionRecord; error?: string; reasonCode?: string })
      : {};
  } catch {
    return {};
  }
}
