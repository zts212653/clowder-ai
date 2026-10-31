'use client';

import type { ReactNode } from 'react';
import { AppTooltip } from '@/components/AppTooltip';
import { conversationViewCopy } from '@/components/shell/conversation-view.shell-copy';
import { useShellCopy } from '@/components/shell/shell-copy';
import type { ChatMessage } from '@/stores/chat-types';
import type { SingleCatConversationInput, SingleCatConversationProjection } from './single-cat-conversation-projection';

function formatTimelineTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

function messageCount(projection: SingleCatConversationProjection): number {
  return projection.blocks.reduce((count, block) => {
    if (block.kind === 'execution') return count + block.readInputs.length + block.unconfirmedInputs.length + 1;
    if (block.kind === 'pending-inputs') return count + block.inputs.length;
    return count + 1;
  }, 0);
}

function EvidenceInput({
  input,
  index,
  total,
  renderMessage,
  readLabel,
}: {
  input: SingleCatConversationInput;
  index: number;
  total: number;
  renderMessage: (message: ChatMessage, index: number, total: number) => ReactNode;
  readLabel: (time: string) => string;
}) {
  const rendered = renderMessage(input.message, index, total);
  if (input.evidence === 'read' && input.readAt !== undefined) {
    const time = formatTimelineTime(input.readAt);
    const label = readLabel(time);
    return (
      <div data-conversation-input-evidence="read" data-read-at={input.readAt}>
        {rendered}
        <div className="flex justify-end px-3 pt-0.5 text-[length:var(--console-font-micro)] text-cafe-muted">
          <AppTooltip label={label} intent="content" side="top" showOnClick>
            <button
              type="button"
              data-conversation-read-receipt
              aria-label={label}
              className="inline-flex items-center gap-1 rounded-sm tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cafe-accent"
            >
              <svg
                aria-hidden="true"
                width="11"
                height="11"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m2 6 2.2 2.2L9.5 3" />
              </svg>
              <time dateTime={new Date(input.readAt).toISOString()}>{time}</time>
            </button>
          </AppTooltip>
        </div>
      </div>
    );
  }
  return (
    <div data-conversation-input-evidence="unconfirmed" className="opacity-65">
      {rendered}
    </div>
  );
}

export function SingleCatConversationTimeline(_props: {
  projection: SingleCatConversationProjection;
  renderMessage: (message: ChatMessage, index: number, total: number) => ReactNode;
}) {
  const { projection, renderMessage } = _props;
  const copy = useShellCopy(conversationViewCopy);
  const total = messageCount(projection);
  let index = 0;

  const renderInput = (input: SingleCatConversationInput) => (
    <EvidenceInput
      key={input.message.id}
      input={input}
      index={index++}
      total={total}
      renderMessage={renderMessage}
      readLabel={copy.readConfirmed}
    />
  );

  return (
    <div data-single-cat-conversation-timeline className="space-y-3">
      {projection.blocks.map((block) => {
        if (block.kind === 'standalone-output') {
          return (
            <div key={block.key} data-conversation-output="standalone">
              {renderMessage(block.message, index++, total)}
            </div>
          );
        }

        if (block.kind === 'pending-inputs') {
          return (
            <section key={block.key} data-conversation-pending className="space-y-1.5">
              <EvidenceDivider label={copy.unconfirmedRead} />
              {block.inputs.map(renderInput)}
            </section>
          );
        }

        const executionTime = formatTimelineTime(block.startedAt);
        return (
          <section
            key={block.key}
            data-conversation-execution={block.response.id}
            data-invocation-id={block.invocationId}
            className="space-y-1.5"
          >
            <div className="flex items-center gap-2 px-3 text-[length:var(--console-font-label)] text-cafe-muted">
              <span aria-hidden="true" className="h-px flex-1 bg-cafe-border" />
              <span className="sr-only">{copy.executionStarted(executionTime)}</span>
              <time
                data-conversation-execution-time
                dateTime={new Date(block.startedAt).toISOString()}
                aria-hidden="true"
                className="tabular-nums"
              >
                {executionTime}
              </time>
              <span aria-hidden="true" className="h-px flex-1 bg-cafe-border" />
            </div>
            {block.readInputs.map(renderInput)}
            {block.unconfirmedInputs.length > 0 ? (
              <>
                <EvidenceDivider label={copy.unconfirmedRead} />
                {block.unconfirmedInputs.map(renderInput)}
              </>
            ) : null}
            <div data-conversation-output="response">{renderMessage(block.response, index++, total)}</div>
          </section>
        );
      })}
    </div>
  );
}

function EvidenceDivider({ label }: { label: string }) {
  return (
    <div
      data-conversation-unconfirmed-divider
      className="flex items-center gap-2 px-3 text-[length:var(--console-font-label)] text-cafe-muted"
    >
      <span aria-hidden="true" className="h-px flex-1 border-t border-dashed border-cafe" />
      <span>{label}</span>
      <span aria-hidden="true" className="h-px flex-1 border-t border-dashed border-cafe" />
    </div>
  );
}
