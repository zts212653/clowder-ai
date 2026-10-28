'use client';

import { useMemo } from 'react';
import { countRecallEvents } from '@/hooks/recall-feed-model';
import { filterRecallEvents } from '@/hooks/recall-tool-events';
import type { ChatMessage, ToolEvent } from '@/stores/chat-types';
import { usePublishLayoutAfterDisclosure } from '../cli-output/CliOutputBlock';
import { describeMessageInvocationTrajectory, openMessageTrajectoryInWorkspace } from '../InvocationTrajectoryAnchor';
import { openReplyRecallInWorkspace } from '../memory/recall-navigation';
import { useMessageDisclosureState } from '../message-disclosure-state';
import { ReplyLastLine } from './ReplyLastLine';
import { ReplyRecord } from './ReplyRecord';
import type { ReplyOutputProjection } from './reply-output';
import type { ReplyRecallProjection } from './reply-recall';
import { summarizeReplyRecord } from './reply-record';
import { deriveReplyExecutionState, deriveReplyStatus } from './reply-status';
import { projectReplySubexecutions } from './reply-subexecution';
import { useReplyQuiet } from './use-reply-quiet';

/**
 * F322 B — §1.16 层 2 and 层 3 of a cat's reply in the new shell: the one line that says what it is doing (and, at its end, the
 * collapsed record with the trajectory) and the opened record. Layer 1, what the cat said, is the reply body the caller draws.
 *
 * Everything here is read off THIS message: its own stream flag, reconciliation phase, tool events, usage, and — for "went
 * quiet" — the liveness of its own turn only (`useReplyQuiet`). Whether the record starts open is the caller's setting
 * (`defaultExpanded`); it is never forced open while the reply streams.
 */
function latestToolUse(message: ChatMessage): ToolEvent | null {
  const events = message.toolEvents ?? [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'tool_use') return event;
  }
  return null;
}

export interface ReplyLayersProps {
  message: ChatMessage;
  threadId: string;
  /** Single-reply open/closed memory (the same key the CLI block used). */
  disclosureKey: string | undefined;
  /** The "执行记录默认" / this thread's "执行记录" setting, already resolved. */
  defaultExpanded: boolean;
  /** The stream's working text when it has been split from the spoken body (a merged reply); undefined otherwise. */
  workingText?: string;
  recall?: ReplyRecallProjection;
  nativeOutput?: ReplyOutputProjection;
}

function resolveReplyRecall(message: ChatMessage, recall: ReplyRecallProjection | undefined) {
  if (recall) return recall;
  const invocationId =
    message.lifecycle?.kind === 'response' ? message.lifecycle.invocationId : message.extra?.stream?.turnInvocationId;
  if (!message.catId || !invocationId) return undefined;
  const events = filterRecallEvents(message.toolEvents ?? []);
  return events.length > 0
    ? ({ invocationId, catId: message.catId, status: 'ready', events } satisfies ReplyRecallProjection)
    : undefined;
}

function hasReplyRecord(input: {
  rowCount: number;
  thinking?: string;
  workingText?: string;
  metadata: boolean;
  recall?: ReplyRecallProjection;
}): boolean {
  return Boolean(
    input.rowCount > 0 ||
      input.thinking ||
      input.workingText ||
      input.metadata ||
      input.recall?.events.length ||
      input.recall?.status === 'unavailable',
  );
}

export function ReplyLayers({
  message,
  threadId,
  disclosureKey,
  defaultExpanded,
  workingText,
  recall,
  nativeOutput,
}: ReplyLayersProps) {
  const subexecutions = useMemo(
    () => projectReplySubexecutions(message.metadata?.subexecutionEvents ?? []),
    [message.metadata?.subexecutionEvents],
  );
  const effectiveRecall = resolveReplyRecall(message, recall);
  const record = summarizeReplyRecord(message.toolEvents, message.metadata);
  const status = message.lifecycle?.kind === 'response' ? message.lifecycle.status : undefined;
  const executionFacts = {
    streaming: Boolean(message.isStreaming),
    status,
    errored: message.variant === 'error',
  };
  const execution = deriveReplyExecutionState(executionFacts);
  const terminalRecall = execution === 'terminal' ? effectiveRecall : undefined;
  const recallCount = terminalRecall?.status === 'ready' ? countRecallEvents([...terminalRecall.events]).total : 0;
  const hasRecord = hasReplyRecord({
    rowCount: record.rows.length + (nativeOutput?.processCount ?? 0) + subexecutions.total,
    thinking: message.thinking,
    workingText,
    metadata: Boolean(message.metadata) || (message.extra?.startupRecovery?.attempt ?? 0) > 1,
    recall: terminalRecall,
  });

  const quiet = useReplyQuiet({
    threadId,
    catId: message.catId,
    streamTurnId:
      message.lifecycle?.kind === 'response' ? message.lifecycle.invocationId : message.extra?.stream?.turnInvocationId,
    active: execution === 'running',
  });
  const latestTool = latestToolUse(message);
  const replyStatus = deriveReplyStatus({
    ...executionFacts,
    failure: {
      reasonCode: message.extra?.cliDiagnostics?.reasonCode,
      timeoutDiagnostics: Boolean(message.extra?.timeoutDiagnostics),
    },
    quiet,
    now: Date.now(),
    latestToolUse: latestTool,
  });
  const recordActive = execution === 'running';

  // An export (long image / document) shows the record opened, as the CLI block always did.
  const isExport =
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('export') === 'true';
  const { expanded, setExpanded } = useMessageDisclosureState(disclosureKey, defaultExpanded || isExport);
  usePublishLayoutAfterDisclosure(expanded);

  const descriptor = describeMessageInvocationTrajectory(message);
  const recordId = `reply-record-${message.id}`;
  const open = hasRecord && expanded;

  return (
    <div
      data-testid="reply-layers"
      className="mt-1 flex min-w-0 flex-col gap-1 empty:hidden"
      // An explicit basis keeps inline-size containment from collapsing the content-sized reply bubble.
      // Reuse the existing child-group/record gutter width; the reading column still bounds it.
      style={{
        containerName: 'reply',
        containerType: 'inline-size',
        width: 'calc(37rem + 1px)',
        maxWidth: '100%',
      }}
      data-reply-status={replyStatus?.kind}
    >
      <ReplyLastLine
        status={replyStatus}
        toolCount={record.toolCount}
        processCount={nativeOutput?.processCount}
        errorCount={record.errorCount}
        durationMs={record.durationMs}
        startedAt={message.timestamp}
        activityEvent={latestTool ?? undefined}
        rerouted={record.rerouted}
        subexecutions={subexecutions}
        hasRecord={hasRecord}
        open={open}
        recordId={recordId}
        onToggle={() => setExpanded((value) => !value)}
        onOpenTrajectory={
          descriptor ? () => openMessageTrajectoryInWorkspace(message, threadId, descriptor) : undefined
        }
        recallCount={recallCount}
        onOpenRecall={
          recallCount > 0 && terminalRecall
            ? () =>
                openReplyRecallInWorkspace({
                  threadId,
                  invocationId: terminalRecall.invocationId,
                  catId: terminalRecall.catId,
                })
            : undefined
        }
      />
      {open ? (
        <ReplyRecord
          id={recordId}
          rows={record.rows}
          active={recordActive}
          thinking={message.thinking}
          workingText={workingText}
          metadata={message.metadata}
          recall={terminalRecall}
          nativeOutput={nativeOutput}
          subexecutions={subexecutions}
          catId={message.catId ?? undefined}
          startupRecovery={message.extra?.startupRecovery}
        />
      ) : null}
    </div>
  );
}
