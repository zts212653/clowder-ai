'use client';

import type { CompositionEventHandler, KeyboardEventHandler, RefObject } from 'react';
import { RichBlocks } from '../rich/RichBlocks';
import { ConciergeMessageContent } from './ConciergeMessageContent';
import type { ConfirmationIndex } from './useConciergeConfirmations';
import type { ConciergeMessage } from './useConciergeMessages';
import type { ConciergeQueueStatus } from './useConciergeQueue';

type InvocationStatus = 'idle' | 'pending' | 'in_progress' | 'error';
type InlineAction = {
  action: string;
  label: string;
  handle?: string;
  verb?: string;
  payload: { threadId: string; messageId?: string };
};

function extractInlineActions(message: ConciergeMessage): InlineAction[] {
  return (
    message.richBlocks
      ?.flatMap((block) => ('actions' in block && Array.isArray(block.actions) ? block.actions : []))
      .filter(
        (action): action is InlineAction => typeof action.action === 'string' && typeof action.label === 'string',
      ) ?? []
  );
}

function MessageBubble({ message, confirmations }: { message: ConciergeMessage; confirmations: ConfirmationIndex }) {
  return (
    <div className={`flex ${message.isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        style={
          message.isUser
            ? { backgroundColor: 'var(--cafe-accent)', color: 'var(--cafe-surface-canvas)' }
            : {
                backgroundColor: 'var(--cafe-surface-elevated)',
                color: 'var(--cafe-text)',
                borderWidth: '1px',
                borderStyle: 'solid',
                borderColor: 'var(--cafe-border-subtle)',
              }
        }
        className={`max-w-[85%] overflow-hidden rounded-xl px-3 py-1.5 text-sm leading-snug break-words [overflow-wrap:anywhere] ${message.isUser ? 'whitespace-pre-wrap' : ''}`}
      >
        {message.isUser ? (
          message.content
        ) : (
          <ConciergeMessageContent
            content={message.content}
            actions={extractInlineActions(message)}
            messageId={message.id}
          />
        )}
        {!message.isUser && message.richBlocks && message.richBlocks.length > 0 && (
          <div className="mt-2">
            <RichBlocks
              blocks={message.richBlocks}
              messageId={message.id}
              confirmations={confirmations.get(message.id)}
              sendContext="concierge"
            />
          </div>
        )}
      </div>
    </div>
  );
}

function ConversationHistory({
  invocationStatus,
  isLoading,
  messages,
  confirmations,
  onStarter,
}: {
  invocationStatus: InvocationStatus;
  isLoading: boolean;
  messages: ConciergeMessage[];
  confirmations: ConfirmationIndex;
  onStarter: () => void;
}) {
  if (invocationStatus === 'error') {
    return (
      <p style={{ color: 'var(--cafe-text-secondary)' }} className="mt-4 text-center text-sm">
        无法加载对话，请重试
      </p>
    );
  }
  if (isLoading && messages.length === 0) {
    return (
      <p style={{ color: 'var(--cafe-text-muted)' }} className="mt-4 text-center text-sm">
        加载中…
      </p>
    );
  }
  if (messages.length === 0) {
    return (
      <div className="mt-4 flex flex-col items-center gap-3 text-center">
        <p style={{ color: 'var(--cafe-text-secondary)' }} className="text-sm">
          你好！我是猫猫球，有什么可以帮你？
        </p>
        <button
          type="button"
          aria-label="问问猫猫能帮什么"
          onClick={onStarter}
          style={{
            color: 'var(--cafe-text-secondary)',
            backgroundColor: 'var(--cafe-surface-elevated)',
            borderColor: 'var(--cafe-border-subtle)',
          }}
          className="rounded-full border px-3 py-1.5 text-xs transition-colors hover:border-[var(--cafe-accent)] hover:text-[var(--cafe-text)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--cafe-accent)]"
        >
          我能帮你做什么？
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {messages.map((message) => (
        <MessageBubble key={message.id} message={message} confirmations={confirmations} />
      ))}
    </div>
  );
}

export function ConciergePanelConversation({
  invocationStatus,
  isLoading,
  messages,
  confirmations,
  queueStatus,
  cancelLoading,
  sendError,
  inputValue,
  inputRef,
  messagesEndRef,
  onStarter,
  onCancel,
  onInputChange,
  onInputFocus,
  onInputBlur,
  onKeyDown,
  onCompositionStart,
  onCompositionEnd,
  onSend,
}: {
  invocationStatus: InvocationStatus;
  isLoading: boolean;
  messages: ConciergeMessage[];
  confirmations: ConfirmationIndex;
  queueStatus: ConciergeQueueStatus;
  cancelLoading: boolean;
  sendError: string | null;
  inputValue: string;
  inputRef: RefObject<HTMLTextAreaElement>;
  messagesEndRef: RefObject<HTMLDivElement>;
  onStarter: () => void;
  onCancel: () => void;
  onInputChange: (value: string) => void;
  onInputFocus: () => void;
  onInputBlur: () => void;
  onKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
  onCompositionStart: CompositionEventHandler<HTMLTextAreaElement>;
  onCompositionEnd: CompositionEventHandler<HTMLTextAreaElement>;
  onSend: () => void;
}) {
  const isBusy = invocationStatus === 'pending' || invocationStatus === 'in_progress';
  return (
    <>
      <section className="min-h-[120px] flex-1 overflow-y-auto px-3 py-3" aria-live="polite" aria-label="对话内容">
        <ConversationHistory
          invocationStatus={invocationStatus}
          isLoading={isLoading}
          messages={messages}
          confirmations={confirmations}
          onStarter={onStarter}
        />
        {invocationStatus === 'pending' && (
          <output style={{ color: 'var(--cafe-text-muted)' }} className="mt-2 block text-center text-xs animate-pulse">
            发送中…
          </output>
        )}
        {invocationStatus === 'in_progress' && (
          <output className="mt-2 flex items-center justify-center gap-2">
            <span style={{ color: 'var(--cafe-text-secondary)' }} className="text-xs animate-pulse">
              {queueStatus.isRunning ? '猫猫球处理中…' : '确认回复中…'}
            </span>
            <button
              type="button"
              aria-label="停止回复"
              disabled={cancelLoading || !queueStatus.dutyCatId}
              onClick={onCancel}
              style={{ color: 'var(--cafe-text-muted)', borderColor: 'var(--cafe-border-subtle)' }}
              className="rounded border px-2 py-0.5 text-xs transition-opacity duration-150 hover:opacity-70 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--cafe-accent)]"
            >
              {cancelLoading ? '停止中…' : '停止'}
            </button>
          </output>
        )}
        {sendError && (
          <p style={{ color: 'var(--semantic-critical)' }} className="mt-2 text-center text-xs">
            {sendError}
          </p>
        )}
        <div ref={messagesEndRef} />
      </section>

      <div style={{ borderTopColor: 'var(--cafe-border-subtle)' }} className="border-t px-3 py-2">
        <textarea
          ref={inputRef}
          rows={2}
          value={inputValue}
          onChange={(event) => onInputChange(event.target.value)}
          onKeyDown={onKeyDown}
          onCompositionStart={onCompositionStart}
          onCompositionEnd={onCompositionEnd}
          placeholder="发消息给猫猫球…"
          aria-label="消息输入框"
          style={{
            backgroundColor: 'var(--cafe-surface-elevated)',
            color: 'var(--cafe-text)',
            borderColor: 'transparent',
          }}
          className="w-full resize-none rounded-lg border px-3 py-2 text-sm placeholder-[color:var(--cafe-text-muted)] transition-colors duration-150 focus:outline-none"
          onFocus={onInputFocus}
          onBlur={onInputBlur}
        />
        <div className="mt-1.5 flex gap-2">
          <button
            type="button"
            aria-label="发送"
            disabled={!inputValue.trim() || isBusy || isLoading}
            onClick={onSend}
            style={{ backgroundColor: 'var(--cafe-accent)', color: 'var(--cafe-surface-canvas)' }}
            className="ml-auto rounded-lg px-3 py-1 text-xs font-medium transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--cafe-accent)]"
          >
            发送
          </button>
        </div>
      </div>
    </>
  );
}
