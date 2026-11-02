'use client';

import type { RuntimeInteractionRecord, RuntimeInteractionResponse } from '@cat-cafe/shared';
import { runtimeInteractionRequestSchema } from '@cat-cafe/shared';
import { type ReactNode, useCallback, useRef, useState } from 'react';
import { readApprovalProducerBody } from '@/lib/approval-producer-read';
import { approvalResultRead } from '@/lib/approval-result-read';
import { useApprovalResult } from '@/lib/use-approval-result';
import type { RichCardBlock } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import { apiSessionIdentity } from '@/utils/api-session-identity';
import { mailboxRuntimeCopy } from '../shell/mailbox/mailbox-runtime.shell-copy';
import { SettledRuntimeReceipt } from '../shell/mailbox/SettledRuntimeReceipt';
import type { SettledResultItem } from '../shell/mailbox/settled-results-source';
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

function runtimeBody(body: unknown, owner: string | null, id: string): RuntimeInteractionRecord | null {
  if (
    !body ||
    typeof body !== 'object' ||
    !('interaction' in body) ||
    !body.interaction ||
    typeof body.interaction !== 'object'
  )
    return null;
  const value = body.interaction as Record<string, unknown>,
    request = runtimeInteractionRequestSchema.safeParse(value.request);
  return request.success &&
    request.data.interactionId === id &&
    request.data.owner.userId === owner &&
    Number.isSafeInteger(value.revision) &&
    typeof value.status === 'string'
    ? (value as unknown as RuntimeInteractionRecord)
    : null;
}

export function isRuntimeInteractionCardBlock(block: RichCardBlock): boolean {
  return block.meta?.kind === 'runtime_interaction' && typeof block.meta.interactionId === 'string';
}

export interface RuntimeInteractionHostRead {
  ownerUserId: string;
  revision: number;
  cardRef: NonNullable<RuntimeInteractionRecord['cardRef']>;
  readCurrent: boolean;
  /** Re-check containing owner/source/generation immediately before a hosted write. */
  verifyCurrentRead: () => boolean;
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
  const canonicalRead = useApprovalResult<SettledResultItem | undefined>(
    'F306',
    interactionId,
    'settled',
    async () => undefined,
    host?.ownerUserId,
    false,
  );
  const item = canonicalRead.value;
  const retained =
    item &&
    item.navigation.state === 'anchored' &&
    item.navigation.approvalCardRef.messageId === messageId &&
    item.detail.runtimeCardRef &&
    typeof item.detail.runtimeCardRef === 'object' &&
    'blockId' in item.detail.runtimeCardRef &&
    item.detail.runtimeCardRef.blockId === block.id
      ? item
      : null;
  const source = useApprovalResult<RuntimeInteractionRecord | null>(
    'F306',
    interactionId,
    'runtime-record',
    async (signal, fresh) => {
      const owner = apiSessionIdentity.getSnapshot().ownerUserId;
      const body = await readApprovalProducerBody(
        { owner: owner ?? '', producer: 'F306', proposalId: interactionId },
        `/api/runtime-interactions/${encodeURIComponent(interactionId)}`,
        { signal, fresh },
      );
      const record = runtimeBody(body, owner, interactionId);
      if (!record) throw new Error(copy.syncFailed);
      return record;
    },
    host?.ownerUserId,
    !retained,
  );
  const record = source.value ?? null;
  const loading = source.reading || (source.value === undefined && !source.failed && !retained);
  const [submitting, setSubmitting] = useState(false),
    [submitError, setError] = useState<string | null>(null);
  const error = submitError ?? (source.failed ? copy.syncFailed : null);
  const submittingRef = useRef(false);
  const hydrate = useCallback(async () => {
    await source.refresh();
    setError(null);
  }, [source.refresh]);

  const submitMutation = async (suffix: 'respond' | 'reject', payload: Record<string, unknown>): Promise<void> => {
    if (
      !record?.cardRef ||
      source.failed ||
      source.stale ||
      submittingRef.current ||
      (host && (!hostAligned || loading || host.verifyCurrentRead?.() !== true))
    )
      return;
    submittingRef.current = true;
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
      const next = runtimeBody(responseBody, source.ownerUserId, interactionId);
      if (!next) throw new Error(copy.submitFailed);
      approvalResultRead.seedFacts(
        { owner: source.ownerUserId ?? '', producer: 'F306', proposalId: interactionId },
        { native: { interaction: next } },
      );
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

  if (retained)
    return (
      <section data-testid="runtime-interaction-card">
        <SettledRuntimeReceipt item={retained} reread={() => void hydrate()} />
      </section>
    );
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
