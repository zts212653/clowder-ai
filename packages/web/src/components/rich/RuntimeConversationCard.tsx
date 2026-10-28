'use client';

import type { RuntimeConversationResponse, RuntimeInteractionCardRef } from '@cat-cafe/shared';
import type { ReactNode } from 'react';
import { useCallback, useRef, useState } from 'react';
import { readApprovalResultOwner } from '@/lib/approval-result-owner';
import { approvalResultRead } from '@/lib/approval-result-read';
import type { RichInteractiveBlock } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { useShellCopy } from '../shell/shell-copy';
import { syncReplyDraftToStorage } from '../thread-drafts';
import { ApprovalResultRow } from './ApprovalResultRow';
import { conversationDecisionCopy } from './conversation-decision.shell-copy';
import { decisionResultCopy } from './decision-result.shell-copy';
import { InteractiveBlock } from './InteractiveBlock';
import { ReadOnlyChoiceList } from './ReadOnlyChoiceList';
import {
  type RuntimeConversationBinding,
  type RuntimeConversationContext,
  readConversation,
  readConversationOwner,
  sameConversationCard,
  sameConversationPresentation,
  submitConversationAnswer,
} from './runtime-conversation-model';
import { RetainedApprovalCardResult, useOriginalApprovalRead } from './use-original-approval-read';

export interface ConversationHostRead {
  ownerUserId: string;
  revision: number;
  cardRef: RuntimeInteractionCardRef;
  readCurrent: boolean;
  verifyCurrentRead: () => boolean;
}
/** Both original Chat and Inbox mount the same block and canonical writer. No second pending lifecycle. */
export function RuntimeConversationCard({
  block,
  binding,
  messageId,
  sourceThreadId,
  catId,
  host,
  secondaryActions,
  onAnswerInText,
}: {
  block: RichInteractiveBlock;
  binding: RuntimeConversationBinding;
  messageId?: string;
  sourceThreadId?: string;
  catId?: string;
  host?: ConversationHostRead;
  secondaryActions?: ReactNode;
  onAnswerInText?: () => void;
}) {
  const copy = useShellCopy(conversationDecisionCopy);
  const resultCopy = useShellCopy(decisionResultCopy);
  const source = useOriginalApprovalRead(
    'F306',
    binding.interactionId,
    { threadId: sourceThreadId, messageId, block },
    async (_signal, fresh) => {
      const principal = fresh ? await readConversationOwner() : await readApprovalResultOwner();
      const read = principal ? await readConversation(binding.interactionId, !fresh) : null;
      return { read, principal };
    },
    host?.ownerUserId,
  );
  const record = source.value?.read ?? null,
    owner = source.value?.principal === source.ownerUserId ? source.ownerUserId : null;
  const [busy, setBusy] = useState(false);
  const loading = source.reading || (source.value === undefined && !source.failed && !source.retained);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0),
    submitting = useRef(false);
  const attempt = useRef<{ signature: string; operationId: string } | null>(null);
  const hydrate = useCallback(async () => {
    const next = await source.refresh();
    setFailed(!next?.read);
  }, [source.refresh]);
  const aligned = Boolean(
    record &&
      owner &&
      record.request.owner.userId === owner &&
      binding.version === 1 &&
      binding.requestKind === 'conversation_decision' &&
      binding.blockId === block.id &&
      record.request.interactionId === binding.interactionId &&
      record.cardRef.messageId === messageId &&
      record.cardRef.threadId === sourceThreadId &&
      record.request.owner.catId === catId &&
      sameConversationPresentation(
        record.request.presentation,
        record.status === 'pending'
          ? block
          : {
              ...block,
              disabled: record.request.presentation.disabled,
              selectedIds: record.request.presentation.selectedIds,
            },
      ) &&
      (!host ||
        (host.ownerUserId === owner &&
          (record.status !== 'pending' || (host.readCurrent && host.revision === record.revision)) &&
          sameConversationCard(host.cardRef, record.cardRef))),
  );
  const actionable = aligned && record?.status === 'pending' && !record.submission && !loading && !busy;
  function context(): RuntimeConversationContext | null {
    if (!actionable || !record || (host && !host.verifyCurrentRead())) return null;
    return {
      interactionId: binding.interactionId,
      ownerUserId: record.request.owner.userId,
      expectedRevision: record.revision,
      cardRef: record.cardRef,
      operationId: crypto.randomUUID(),
    };
  }
  async function submit(selectedIds: string[], customInput?: string) {
    const coordinates = context();
    if (!coordinates || submitting.current) return;
    const answer: RuntimeConversationResponse = {
      kind: 'selection',
      selectedIds,
      ...(customInput ? { customInput } : {}),
    };
    const signature = JSON.stringify(answer);
    if (attempt.current?.signature !== signature) attempt.current = { signature, operationId: coordinates.operationId };
    coordinates.operationId = attempt.current.operationId;
    submitting.current = true;
    generation.current++;
    setBusy(true);
    setFailed(false);
    try {
      const next = await submitConversationAnswer(coordinates, answer, host?.verifyCurrentRead);
      if (next && owner === next.request.owner.userId)
        approvalResultRead.seedFacts(
          { owner, producer: 'F306', proposalId: binding.interactionId },
          { native: { interaction: next } },
        );
    } catch {
      setFailed(true);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  function bindText() {
    const coordinates = context();
    if (!coordinates || !record?.request.allowTextResponse) return;
    const reply = {
      id: coordinates.cardRef.messageId,
      threadId: coordinates.cardRef.threadId,
      content: record.request.title,
      senderCatId: record.request.owner.catId,
      runtimeAnswerContext: coordinates,
    };
    syncReplyDraftToStorage(reply.threadId, reply);
    useChatStore.getState().setReplyTo(reply);
    onAnswerInText?.();
    window.dispatchEvent(
      new CustomEvent('cat-cafe:conversation-answer-bound', { detail: { threadId: coordinates.cardRef.threadId } }),
    );
  }
  const selectedIds = record?.terminal?.response?.kind === 'selection' ? record.terminal.response.selectedIds : [];
  const terminal = record?.terminal?.reasonCode;
  const result =
    terminal === 'answered'
      ? copy.answered
      : terminal === 'withdrawn'
        ? copy.withdrawn
        : terminal === 'superseded'
          ? copy.superseded
          : terminal === 'defaulted'
            ? copy.defaulted
            : copy.expired;
  if (source.retained)
    return (
      <section data-testid="runtime-conversation-card">
        <RetainedApprovalCardResult item={source.retained} reread={() => void source.reread()} />
      </section>
    );
  if (aligned && record && record.status !== 'pending') {
    const choices = record.request.presentation.options
      .filter((option) => selectedIds.includes(option.id))
      .map((option) => option.label);
    const { label, status } = conversationResult(terminal, choices, copy, resultCopy);
    return (
      <section data-testid="runtime-conversation-card">
        <div data-testid="conversation-decision-result">
          <ApprovalResultRow status={status} label={label}>
            <h3 className="font-semibold">{record.request.title}</h3>
            <ReadOnlyChoiceList options={record.request.presentation.options} selectedIds={selectedIds} />
            <button
              type="button"
              disabled={busy}
              onClick={() => void hydrate()}
              className="shell-focusable text-xs hover:underline"
            >
              {copy.retry}
            </button>
            {secondaryActions}
          </ApprovalResultRow>
        </div>
      </section>
    );
  }
  return (
    <section data-testid="runtime-conversation-card" className="space-y-3">
      <InteractiveBlock
        block={block}
        controller={{ copy, disabled: !actionable, selectedIds, submit: (ids, text) => void submit(ids, text) }}
      />
      {loading ? <p className="text-xs text-cafe-muted">{copy.loading}</p> : null}
      {aligned && record?.request.deadlineAt ? (
        <p className="text-xs text-cafe-muted">{copy.deadline(new Date(record.request.deadlineAt).toLocaleString())}</p>
      ) : null}
      {aligned && record?.status !== 'pending' ? (
        <output data-testid="conversation-decision-result">{result}</output>
      ) : null}
      {failed || (!loading && !aligned) ? (
        <p role="alert" className="text-xs text-cafe-muted">
          {copy.changed}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {actionable && record?.request.allowTextResponse ? (
          <button type="button" onClick={bindText} className="text-xs underline">
            {copy.text}
          </button>
        ) : null}
        <button type="button" disabled={busy} onClick={() => void hydrate()} className="text-xs underline">
          {copy.retry}
        </button>
        <div className="ml-auto flex gap-2">{secondaryActions}</div>
      </div>
    </section>
  );
}

import { conversationResult } from './conversation-result';
