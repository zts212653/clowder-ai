'use client';

import type React from 'react';
import type { AuthorizedConversationsRead } from './authorized-conversations';
import { CloudConversationChoices } from './CloudConversationChoices';

export const routePrimaryClass =
  'rounded-lg bg-cafe-accent px-3 py-1.5 text-xs font-semibold text-[var(--cafe-accent-foreground)] hover:bg-cafe-accent-hover disabled:cursor-not-allowed disabled:opacity-50';
export const routeGhostClass =
  'rounded-md px-1.5 py-1 text-xs font-medium text-cafe-secondary hover:bg-[var(--console-hover-bg)] hover:text-cafe disabled:opacity-50';

export interface RouteChooserProps {
  radioName: string;
  authorized: AuthorizedConversationsRead;
  /** The conversation the thread routes to now, if any — revoked or not. */
  boundId: string | null;
  /**
   * The thread has a stored route, whether or not it reads as a conversation: disconnecting clears it.
   * A record that cannot be read has no `boundId`, and must still be removable.
   */
  hasRecord: boolean;
  /** Whether that conversation is still authorized, so it can be marked as the current one. */
  boundUsable: boolean;
  selectedConversationId: string | null;
  /** A write in flight, or a write whose outcome is being re-read: either way, no other write. */
  busy: 'connect' | 'disconnect' | 'reconcile' | null;
  /** Only a working route can be kept by backing out of the chooser. */
  cancellable: boolean;
  onSelect: (conversationId: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  onDisconnect: () => void;
  onRetry: () => void;
}

function NothingAuthorized({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="mt-2 text-xs text-cafe-secondary">
      <p>还没有已授权的会话。在 ChatGPT 打开要用的会话，点扩展里的「授权此会话」，再回来刷新。</p>
      <div className="mt-1.5 flex gap-1">
        <a className={routeGhostClass} href="https://chatgpt.com/" target="_blank" rel="noopener noreferrer">
          打开 ChatGPT
        </a>
        <button type="button" className={routeGhostClass} onClick={onRetry}>
          刷新
        </button>
      </div>
    </div>
  );
}

/**
 * The actions that manage what the thread has now. They never depend on the list of candidates: a
 * revoked route can be disconnected even when nothing is authorized, or the list cannot be read.
 */
function ChooserFooter({ props, primary }: { props: RouteChooserProps; primary?: React.ReactNode }) {
  const { busy } = props;
  if (!primary && !props.cancellable && !props.hasRecord) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {primary}
      {props.cancellable ? (
        <button type="button" className={routeGhostClass} disabled={busy !== null} onClick={props.onCancel}>
          取消
        </button>
      ) : null}
      {props.hasRecord ? (
        <button
          type="button"
          className={`${routeGhostClass} ml-auto`}
          disabled={busy !== null}
          onClick={props.onDisconnect}
        >
          {busy === 'disconnect' ? '断开中…' : '断开连接'}
        </button>
      ) : null}
    </div>
  );
}

function ChooserBody(props: RouteChooserProps) {
  const { authorized, busy } = props;
  if (authorized.kind === 'loading') return <p className="mt-2 text-xs text-cafe-muted">正在读取已授权的会话…</p>;
  if (authorized.kind === 'error') {
    return (
      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-cafe-secondary">
        <span>暂时读不到已授权的会话。</span>
        <button type="button" className={routeGhostClass} disabled={busy !== null} onClick={props.onRetry}>
          重试
        </button>
      </div>
    );
  }
  if (authorized.candidates.length === 0) return <NothingAuthorized onRetry={props.onRetry} />;
  return (
    <CloudConversationChoices
      candidates={authorized.candidates}
      selectedConversationId={props.selectedConversationId}
      boundConversationId={props.boundUsable ? props.boundId : null}
      busy={busy !== null}
      onSelect={props.onSelect}
      name={props.radioName}
      layout="rows"
    />
  );
}

/** Pick one authorized conversation and confirm it; or disconnect the thread altogether. Esc backs out. */
export function CloudConversationRouteChooser(props: RouteChooserProps) {
  const { authorized, busy } = props;
  const listed = authorized.kind === 'ready' && authorized.candidates.length > 0;
  const changes = props.selectedConversationId !== null && props.selectedConversationId !== props.boundId;
  const primary = listed ? (
    <button type="button" className={routePrimaryClass} disabled={!changes || busy !== null} onClick={props.onConfirm}>
      {busy === 'connect' ? '连接中…' : props.boundId ? '改用这个会话' : '连接这个会话'}
    </button>
  ) : undefined;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Esc is a shortcut for the chooser's own 取消 button.
    <div
      data-route-chooser
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !props.cancellable || busy !== null) return;
        event.preventDefault();
        props.onCancel();
      }}
    >
      <ChooserBody {...props} />
      <ChooserFooter props={props} primary={primary} />
    </div>
  );
}
