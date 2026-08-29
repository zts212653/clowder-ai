'use client';

import type { ApprovalItem, MeetingIntakeOutput } from '@cat-cafe/shared';
import { useMemo, useState } from 'react';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import type { Thread } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { ApprovalDecisionCard } from './ApprovalDecisionCard';
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

export function MeetingIntakeCard({ item }: { item: ApprovalItem }) {
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
  const [editOpen, setEditOpen] = useState(
    () =>
      !(parseMeetingSpeakers(initialSpeakers) && initialContext.trim() && initialDestination && initialOutputs.length),
  );
  const [manualReference, setManualReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsedSpeakers = parseMeetingSpeakers(speakers);
  const canConfirm = Boolean(parsedSpeakers && context.trim() && destination && outputs.length > 0 && !busy);

  async function action(name: string, payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch(`/api/meeting-intakes/${item.proposalId}/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(meetingErrorMessage(body, response.status));
        if (response.status === 409) await fetchPending();
        return null;
      }
      await fetchPending();
      return meetingRecord(body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败');
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function confirm(): Promise<void> {
    if (!parsedSpeakers || !canConfirm) return;
    await action('confirm', {
      expectedRevision: revision,
      choices: { speakerMap: parsedSpeakers, context: context.trim(), destinationHandle: destination, outputs },
    });
  }

  async function bindDestinationCatAndRetry(threadId: string, catId: string): Promise<void> {
    if (!catId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await bindMeetingDestinationCatAndRetry({
        threadId,
        catId,
        proposalId: item.proposalId,
        revision,
      });
      if (!result.ok) {
        setError(result.message);
        if (result.status === 409) await fetchPending();
        return;
      }
      await fetchPending();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存负责猫猫失败');
    } finally {
      setBusy(false);
    }
  }

  const currentDecision = (
    <div className="space-y-3">
      {repair && (
        <MeetingIntakeRepairActions
          repair={repair}
          manualReference={manualReference}
          busy={busy}
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
              onClick={() => setEditOpen((current) => !current)}
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
          )}
        </>
      )}
      <div className="flex items-center justify-between gap-2">
        <MeetingIntakeDismissAction
          judgmentState={detail.judgmentState}
          executionState={detail.executionState}
          busy={busy}
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
