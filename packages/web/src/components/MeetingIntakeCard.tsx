'use client';

import type { ApprovalHubItem, MeetingIntakeOutput } from '@cat-cafe/shared';
import { useCallback, useMemo, useState } from 'react';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import type { Thread } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { ApprovalDecisionCard } from './ApprovalDecisionCard';
import {
  useAuthorizeWrite,
  useGuardedWrite,
  useReportEditing,
  useWriteBlocked,
  type WriteEvidence,
} from './ApprovalHost';
import { MeetingIntakeDismissAction } from './MeetingIntakeDismissAction';
import { MEETING_OUTPUTS, MeetingIntakeForm } from './MeetingIntakeForm';
import { MeetingIntakeRepairActions } from './MeetingIntakeRepairActions';
import { MeetingIntakeSourceDetails, MeetingIntakeSummary } from './MeetingIntakeSummary';
import { bindMeetingDestinationCatAndRetry, routeCatRepairThreadId } from './meeting-intake-route-repair';
import {
  meetingActionReason,
  meetingErrorMessage,
  meetingRecord,
  meetingRepairView,
  meetingSpeakerText,
  meetingStatusLabel,
  parseMeetingSpeakers,
  userMeetingThreads,
} from './meeting-intake-utils';

interface MeetingFormValues {
  speakers: string;
  context: string;
  destination: string;
  outputs: readonly MeetingIntakeOutput[];
}

/** Anything the user changed from what the proposal arrived with (or a manual reference typed) is work in progress. */
function meetingFormChanged(
  current: MeetingFormValues & { manualReference: string },
  initial: MeetingFormValues,
): boolean {
  return (
    current.speakers !== initial.speakers ||
    current.context !== initial.context ||
    current.destination !== initial.destination ||
    current.manualReference !== '' ||
    current.outputs.length !== initial.outputs.length ||
    current.outputs.some((output) => !initial.outputs.includes(output))
  );
}

interface MeetingRequestOutcome {
  /** The response body when the producer accepted the request; null otherwise. */
  body: Record<string, unknown> | null;
  /** What the request itself saw of the response, when it can say so. */
  evidence?: WriteEvidence;
  error: string | null;
  /** A 409 or an accepted request means the proposal on screen is out of date. */
  refresh: boolean;
}

/** One POST to the producer's own endpoint, mapped to what the card shows and what a host is told. */
async function postMeetingAction(
  proposalId: string,
  name: string,
  payload: Record<string, unknown>,
): Promise<MeetingRequestOutcome> {
  try {
    const response = await apiFetch(`/api/meeting-intakes/${proposalId}/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        body: null,
        evidence: { outcome: 'http-error', status: response.status },
        error: meetingErrorMessage(body, response.status),
        refresh: response.status === 409,
      };
    }
    return { body: meetingRecord(body), error: null, refresh: true };
  } catch (cause) {
    return {
      body: null,
      evidence: { outcome: 'network-error' },
      error: cause instanceof Error ? cause.message : '操作失败',
      refresh: false,
    };
  }
}

/** The two-step repair (save the destination's cat, then retry delivery), mapped the same way as a single request. */
async function bindCatAndRetryOutcome(
  input: Parameters<typeof bindMeetingDestinationCatAndRetry>[0],
): Promise<MeetingRequestOutcome> {
  try {
    const result = await bindMeetingDestinationCatAndRetry(input);
    if (result.ok) return { body: null, error: null, refresh: true };
    // Stopped on purpose between the two requests: nothing was answered, so there is no status to report and no
    // reason to refresh. The host re-reads when the write ends.
    if ('stopped' in result) return { body: null, error: result.message, refresh: false };
    return {
      body: null,
      evidence: { outcome: 'http-error', status: result.status },
      error: result.message,
      refresh: result.status === 409,
    };
  } catch (cause) {
    return {
      body: null,
      evidence: { outcome: 'network-error' },
      error: cause instanceof Error ? cause.message : '保存负责猫猫失败',
      refresh: false,
    };
  }
}

/**
 * Whether the edit form is open, and whether the user is working in it. Opening the form or putting the cursor in it is the
 * start of work in progress and needs no changed character; a form that is open only because the proposal arrived
 * incomplete is not, until the user touches it. A changed form is work in progress however it is shown. Told to a host as
 * one editor, so it can keep the card (and the cursor) where they are.
 */
function useMeetingEditForm(initialOpen: () => boolean, formChanged: boolean) {
  const [editOpen, setEditOpen] = useState(initialOpen);
  const [touched, setTouched] = useState(false);
  useReportEditing('meeting-form', formChanged || (editOpen && touched));
  const touch = useCallback(() => setTouched(true), []);
  const toggle = useCallback(() => {
    setEditOpen((current) => !current);
    setTouched(true);
  }, []);
  return { editOpen, toggle, touch };
}

/** One producer request behind the host's guard; busy and error are the card's own, as before. */
function useMeetingRequest(
  setBusy: (busy: boolean) => void,
  setError: (message: string | null) => void,
  refresh: () => Promise<void>,
) {
  const guardedWrite = useGuardedWrite();
  return async (request: () => Promise<MeetingRequestOutcome>): Promise<Record<string, unknown> | null> => {
    const written = await guardedWrite('meeting-intake', async (reportEvidence) => {
      setBusy(true);
      setError(null);
      try {
        const outcome = await request();
        if (outcome.evidence) reportEvidence(outcome.evidence);
        if (outcome.error) setError(outcome.error);
        if (outcome.refresh) await refresh();
        return outcome.body;
      } finally {
        setBusy(false);
      }
    });
    return written.sent ? written.value : null;
  };
}

export function MeetingIntakeCard({ item }: { item: ApprovalHubItem }) {
  const fetchPending = useApprovalHubStore((state) => state.fetchPending);
  const rawThreads = useChatStore((state) => state.threads as Thread[] | unknown);
  const currentProjectPath = useChatStore((state) => state.currentProjectPath);
  const isLoadingThreads = useChatStore((state) => state.isLoadingThreads);
  const threads = useMemo(() => userMeetingThreads(rawThreads), [rawThreads]);
  const detail = meetingRecord(item.detail);
  const choices = meetingRecord(detail.choices);
  const revision = Number.isSafeInteger(detail.revision) ? Number(detail.revision) : 0;
  const repair = meetingRepairView(detail.repair);
  const metadata = meetingRecord(detail.metadata);
  const source = meetingRecord(detail.source);
  const initialSpeakers = meetingSpeakerText(choices.speakerMap);
  const initialContext = typeof choices.context === 'string' ? choices.context : '';
  const initialDestination = typeof choices.destinationHandle === 'string' ? choices.destinationHandle : '';
  const initialOutputs = Array.isArray(choices.outputs)
    ? choices.outputs.filter((value): value is MeetingIntakeOutput =>
        MEETING_OUTPUTS.some((output) => output.id === value),
      )
    : [];
  const routeCatRepairThread = routeCatRepairThreadId(repair?.code, initialDestination, threads);

  const [speakers, setSpeakers] = useState(initialSpeakers);
  const [context, setContext] = useState(initialContext);
  const [destination, setDestination] = useState(initialDestination);
  const [outputs, setOutputs] = useState<MeetingIntakeOutput[]>(initialOutputs);
  const [manualReference, setManualReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsedSpeakers = parseMeetingSpeakers(speakers);
  // A host that has locked writes keeps the form editable; nothing is sent until it unlocks.
  const writeBlocked = useWriteBlocked(busy);
  const canConfirm = Boolean(parsedSpeakers && context.trim() && destination && outputs.length > 0 && !writeBlocked);

  const formChanged = meetingFormChanged(
    { speakers, context, destination, outputs, manualReference },
    { speakers: initialSpeakers, context: initialContext, destination: initialDestination, outputs: initialOutputs },
  );
  const {
    editOpen,
    toggle: toggleEdit,
    touch: touchForm,
  } = useMeetingEditForm(
    () =>
      !(parseMeetingSpeakers(initialSpeakers) && initialContext.trim() && initialDestination && initialOutputs.length),
    formChanged,
  );

  const perform = useMeetingRequest(setBusy, setError, fetchPending);
  const authorizeWrite = useAuthorizeWrite();
  const action = (name: string, payload: Record<string, unknown>) =>
    perform(() => postMeetingAction(item.proposalId, name, payload));

  async function confirm(): Promise<void> {
    if (!parsedSpeakers || !canConfirm) return;
    await action('confirm', {
      expectedRevision: revision,
      choices: { speakerMap: parsedSpeakers, context: context.trim(), destinationHandle: destination, outputs },
    });
  }

  async function bindDestinationCatAndRetry(threadId: string, catId: string): Promise<void> {
    if (!catId || busy) return;
    await perform(() =>
      bindCatAndRetryOutcome({
        threadId,
        catId,
        proposalId: item.proposalId,
        revision,
        mayRetry: () => authorizeWrite('meeting-intake'),
      }),
    );
  }

  const currentDecision = (
    <div className="space-y-3">
      {repair && (
        <MeetingIntakeRepairActions
          repair={repair}
          manualReference={manualReference}
          busy={writeBlocked}
          revision={revision}
          routeCatRepair={routeCatRepairThread ? { threadId: routeCatRepairThread } : undefined}
          onBindCatAndRetry={(threadId, catId) => void bindDestinationCatAndRetry(threadId, catId)}
          onManualReferenceChange={setManualReference}
          onAction={(name, payload) => void action(name, payload)}
        />
      )}
      {detail.judgmentState === 'unresolved' && (
        <>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
            <button
              type="button"
              onClick={toggleEdit}
              className="rounded-md border border-cafe px-3 py-1.5 text-micro font-medium hover:bg-cafe-muted sm:mr-auto"
              aria-expanded={editOpen}
              data-testid="meeting-edit-toggle"
            >
              {editOpen ? '收起修改' : '有内容要改'}
            </button>
            <button
              type="button"
              onClick={() => void confirm()}
              disabled={!canConfirm}
              className="rounded-md bg-[var(--semantic-success)] px-3 py-1.5 text-micro font-medium text-[var(--cafe-accent-foreground)] disabled:opacity-50"
              data-testid="meeting-confirm"
            >
              {busy ? '处理中…' : '确认并开始整理'}
            </button>
          </div>
          {editOpen && (
            <div className="contents" onFocusCapture={touchForm}>
              <MeetingIntakeForm
                speakers={speakers}
                context={context}
                destination={destination}
                outputs={outputs}
                threads={threads}
                suggestedTitle={typeof metadata.title === 'string' ? metadata.title : '会议跟进'}
                projectPath={currentProjectPath}
                loadingThreads={isLoadingThreads}
                disabled={busy}
                onSpeakersChange={setSpeakers}
                onContextChange={setContext}
                onDestinationChange={setDestination}
                onOutputsChange={setOutputs}
              />
            </div>
          )}
        </>
      )}
      <div className="flex items-center justify-between gap-2">
        <MeetingIntakeDismissAction
          judgmentState={detail.judgmentState}
          executionState={detail.executionState}
          busy={writeBlocked}
          onDismiss={() => void action('dismiss', { expectedRevision: revision })}
        />
        {error && <p className="text-micro text-[var(--semantic-error)]">{error}</p>}
      </div>
    </div>
  );

  return (
    <ApprovalDecisionCard
      testId={`approval-item-${item.proposalId}`}
      header={
        <div className="flex items-center gap-2">
          <span className="rounded-md bg-[var(--semantic-info-subtle)] px-1.5 py-0.5 text-micro font-medium text-[var(--semantic-info)]">
            会议
          </span>
          <span className="text-micro font-medium text-cafe-secondary">{meetingStatusLabel(Boolean(repair))}</span>
        </div>
      }
      title={item.summary}
      actionReason={
        <p>
          <span className="font-semibold text-cafe">为什么需要我：</span>
          {meetingActionReason(Boolean(repair))}
        </p>
      }
      recommendation={
        <MeetingIntakeSummary speakers={speakers} destination={destination} outputs={outputs} threads={threads} />
      }
      currentDecision={currentDecision}
      details={{
        label: '查看原会议和记录',
        testId: 'meeting-source-details',
        content: (
          <MeetingIntakeSourceDetails
            sourceHandle={typeof source.handle === 'string' ? source.handle : '飞书会议记录'}
            revision={revision}
            meetingId={typeof metadata.meetingId === 'string' ? metadata.meetingId : undefined}
          />
        ),
      }}
    />
  );
}
