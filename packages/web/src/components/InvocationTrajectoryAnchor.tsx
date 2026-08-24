'use client';

import type { InvocationTrajectoryStatus } from '@cat-cafe/shared';
import { getBubbleInvocationId } from '@/debug/bubbleIdentity';
import type { ChatMessage } from '@/stores/chat-types';
import { captureMessageScrollAnchorForMessage } from '@/utils/scrollToMessage';
import { openInvocationTrajectory } from './workspace/trajectory/trajectory-navigation';

export interface MessageInvocationTrajectoryDescriptor {
  invocationId: string;
  status: InvocationTrajectoryStatus;
}

function hasTimeoutEvidence(message: ChatMessage): boolean {
  if (message.extra?.timeoutDiagnostics) return true;
  const reasonCode = message.extra?.cliDiagnostics?.reasonCode;
  return typeof reasonCode === 'string' && reasonCode.toLowerCase().includes('timeout');
}

export function describeMessageInvocationTrajectory(
  message: ChatMessage,
): MessageInvocationTrajectoryDescriptor | undefined {
  const invocationId =
    getBubbleInvocationId(message) ??
    message.extra?.timeoutDiagnostics?.invocationId ??
    message.extra?.cliDiagnostics?.debugRef.invocationId;
  if (!invocationId || !message.catId) return undefined;
  const phase = message.extra?.invocationReconciliation?.phase;
  let status: InvocationTrajectoryStatus;
  if (phase === 'failed') status = hasTimeoutEvidence(message) ? 'timeout' : 'error';
  else if (phase === 'canceled') status = 'cancelled';
  else if (phase === 'running' || phase === 'unknown_running' || message.isStreaming) status = 'running';
  else if (hasTimeoutEvidence(message)) status = 'timeout';
  else if (message.variant === 'error' || message.content.trimStart().startsWith('Error:')) status = 'error';
  else status = 'done';
  return { invocationId, status };
}

export function openMessageInvocationTrajectory(message: ChatMessage, threadId: string): void {
  const descriptor = describeMessageInvocationTrajectory(message);
  if (!descriptor) return;
  const container = document.querySelector<HTMLElement>('[data-chat-container]');
  const anchor = container ? captureMessageScrollAnchorForMessage(container, message.id) : undefined;
  openInvocationTrajectory({
    threadId,
    invocationId: descriptor.invocationId,
    originRef: {
      kind: 'message',
      threadId,
      messageId: message.id,
      viewportOffsetPx: anchor?.viewportOffsetPx ?? 0,
    },
  });
}

const STATUS_LABEL: Record<InvocationTrajectoryStatus, string> = {
  running: '运行中',
  done: '轨迹',
  error: '出错',
  cancelled: '已取消',
  timeout: '超时',
};

const STATUS_TONE: Record<InvocationTrajectoryStatus, string> = {
  running: 'border-conn-blue-ring bg-conn-blue-bg text-conn-blue-text',
  done: 'border-cafe-subtle bg-cafe-surface text-cafe-muted hover:text-cafe-accent',
  error: 'border-conn-red-ring bg-conn-red-bg text-conn-red-text',
  cancelled: 'border-conn-amber-ring bg-conn-amber-bg text-conn-amber-text',
  timeout: 'border-conn-red-ring bg-conn-red-bg text-conn-red-text',
};

export function InvocationTrajectoryAnchor({
  message,
  threadId,
  onOpen,
}: {
  message: ChatMessage;
  threadId: string;
  onOpen?: (descriptor: MessageInvocationTrajectoryDescriptor) => void;
}) {
  const descriptor = describeMessageInvocationTrajectory(message);
  if (!descriptor) return null;
  const quiet = descriptor.status === 'done';
  return (
    <button
      type="button"
      data-invocation-anchor={descriptor.invocationId}
      data-trajectory-status={descriptor.status}
      onClick={(event) => {
        event.stopPropagation();
        if (onOpen) onOpen(descriptor);
        else openMessageInvocationTrajectory(message, threadId);
      }}
      className={`inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-1.5 text-micro font-semibold transition-[opacity,color,background-color] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cafe-accent ${
        quiet
          ? 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 [@media(hover:none)_and_(pointer:coarse)]:pointer-events-auto [@media(hover:none)_and_(pointer:coarse)]:opacity-100'
          : ''
      } ${STATUS_TONE[descriptor.status]}`.trim()}
      title={`打开 invocation ${descriptor.invocationId} 的轨迹`}
      aria-label={`${STATUS_LABEL[descriptor.status]}：打开这轮 invocation 轨迹`}
    >
      <svg
        aria-hidden="true"
        className="h-3 w-3"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <circle cx="4" cy="4" r="1.5" />
        <circle cx="12" cy="12" r="1.5" />
        <path d="M4 5.5v3A3.5 3.5 0 0 0 7.5 12h3" />
      </svg>
      <span>{STATUS_LABEL[descriptor.status]}</span>
    </button>
  );
}
