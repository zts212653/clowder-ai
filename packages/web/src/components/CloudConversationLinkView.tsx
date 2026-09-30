'use client';

import { type RefObject, useEffect, useRef } from 'react';
import type { AuthorizedConversationsRead } from './authorized-conversations';
import { ConversationDetails } from './CloudConversationChoices';
import { CloudConversationRouteChooser, routeGhostClass } from './CloudConversationRouteChooser';
import { type RouteOperation, RouteOperationNotice } from './CloudConversationRouteNotice';
import type { BoundConversation, RouteBinding } from './thread-cloud-route';

export type { AuthorizedConversationsRead } from './authorized-conversations';
export type { RouteOperation } from './CloudConversationRouteNotice';

/** The thread's own route, as the Host binding says. */
export type ThreadRouteRead =
  | { kind: 'loading' }
  | { kind: 'unauthorized' }
  | { kind: 'error' }
  | { kind: 'ready'; binding: RouteBinding };

/** Where focus goes after the owner opens or closes the chooser, or a write lands; `nonce` repeats it. */
export interface FocusRequest {
  target: 'change' | 'chooser';
  nonce: number;
}

export interface CloudConversationLinkViewProps {
  catLabel: string;
  radioName: string;
  route: ThreadRouteRead;
  authorized: AuthorizedConversationsRead;
  choosing: boolean;
  selectedConversationId: string | null;
  busy: 'connect' | 'disconnect' | null;
  operation: RouteOperation;
  copyState: 'idle' | 'copied' | 'failed';
  focusRequest?: FocusRequest | null;
  onCopy: () => void;
  onToggleChoosing: () => void;
  onSelect: (conversationId: string) => void;
  onConfirm: () => void;
  onDisconnect: () => void;
  /** Reads the thread's route again. */
  onReread: () => void;
  /** Reads the authorized conversations again. */
  onRetryList: () => void;
}

type Standing =
  | 'reading'
  | 'owner-only'
  | 'unreadable'
  | 'confirming'
  | 'unknown'
  | 'connected'
  | 'revoked'
  | 'invalid'
  | 'unconnected';

const STATUS: Record<Standing, { label: string; dot?: string }> = {
  reading: { label: '读取中…' },
  'owner-only': { label: '仅对话所有者可见' },
  unreadable: { label: '暂时读不到', dot: 'var(--semantic-critical)' },
  confirming: { label: '确认中…' },
  unknown: { label: '状态未知', dot: 'var(--semantic-warning)' },
  connected: { label: '已连接', dot: 'var(--semantic-success)' },
  revoked: { label: '授权已撤销', dot: 'var(--semantic-warning)' },
  invalid: { label: '连接记录无效', dot: 'var(--semantic-warning)' },
  unconnected: { label: '未连接', dot: 'var(--console-border-soft)' },
};

/** A standing without a working route puts the chooser in front: choosing is the task. */
const NEEDS_CHOICE: ReadonlySet<Standing> = new Set(['unconnected', 'revoked', 'invalid']);
const IDLE: RouteOperation = { kind: 'idle' };

function standingOf(
  route: ThreadRouteRead,
  authorized: AuthorizedConversationsRead,
  operation: RouteOperation,
): Standing {
  // Until a change of unknown outcome is read back, the route shown last may no longer be the route.
  if (operation.kind === 'reconciling') return 'confirming';
  if (operation.kind === 'unknown') return 'unknown';
  if (route.kind === 'loading') return 'reading';
  if (route.kind === 'unauthorized') return 'owner-only';
  if (route.kind === 'error') return 'unreadable';
  if (route.binding === 'invalid') return 'invalid';
  if (route.binding === null) return 'unconnected';
  const { conversationId } = route.binding;
  const revoked =
    authorized.kind === 'ready' &&
    !authorized.candidates.some((candidate) => candidate.conversationId === conversationId);
  return revoked ? 'revoked' : 'connected';
}

/** Moves focus as asked — but only focus that was in this card, or lost with the control that had it. */
function useRequestedFocus(sectionRef: RefObject<HTMLElement | null>, request: FocusRequest | null | undefined) {
  useEffect(() => {
    const section = sectionRef.current;
    if (!request || !section) return;
    const active = document.activeElement;
    if (active && active !== document.body && !section.contains(active)) return;
    const target =
      request.target === 'change'
        ? section.querySelector<HTMLElement>('[data-route-change]')
        : (section.querySelector<HTMLElement>('[data-route-chooser] input[type="radio"]:checked:enabled') ??
          section.querySelector<HTMLElement>(
            '[data-route-chooser] input[type="radio"]:enabled, [data-route-chooser] a, [data-route-chooser] button:enabled',
          ));
    target?.focus();
  }, [sectionRef, request]);
}

function Header({ catLabel, standing, onReread }: { catLabel: string; standing: Standing; onReread: () => void }) {
  const { label, dot } = STATUS[standing];
  return (
    <>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="min-w-0 truncate text-xs font-semibold text-cafe">
          ChatGPT 会话 <span className="font-normal text-cafe-muted">{catLabel}</span>
        </span>
        <span
          className="flex shrink-0 items-center gap-1.5 text-micro text-cafe-secondary"
          data-route-status={standing}
        >
          {dot ? <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: dot }} /> : null}
          {label}
        </span>
      </div>
      {standing === 'unreadable' ? (
        <button type="button" className={`${routeGhostClass} mt-1`} onClick={onReread}>
          重试
        </button>
      ) : null}
    </>
  );
}

function Conversation({
  binding,
  authorized,
}: {
  binding: BoundConversation;
  authorized: AuthorizedConversationsRead;
}) {
  const candidate =
    authorized.kind === 'ready'
      ? authorized.candidates.find((item) => item.conversationId === binding.conversationId)
      : undefined;
  return (
    <div className="mt-1.5 min-w-0">
      <p className="break-words text-sm font-medium text-cafe" title={candidate?.displayTitle}>
        {candidate?.displayTitle ?? <code className="font-mono text-xs">{binding.conversationId}</code>}
      </p>
      {candidate ? <ConversationDetails candidate={candidate} /> : null}
    </div>
  );
}

function StandingNote({ standing, catLabel, choices }: { standing: Standing; catLabel: string; choices: boolean }) {
  // With nothing authorized yet, the chooser's own guidance says what to do; no "pick one" above it.
  const note =
    standing === 'revoked'
      ? `它已不在扩展的授权列表里，回复送不到这里。${choices ? '请换一个会话。' : ''}`
      : standing === 'invalid'
        ? '这个对话记着的连接读不出来。重新选一个会话即可。'
        : standing === 'unconnected' && choices
          ? `选一个已授权的会话，这个对话里 ${catLabel} 的消息就会发到那里。`
          : null;
  return note ? <p className="mt-1 text-xs text-cafe-secondary">{note}</p> : null;
}

function ConnectedActions(props: CloudConversationLinkViewProps & { binding: BoundConversation }) {
  const copyLabel = props.copyState === 'copied' ? '已复制' : props.copyState === 'failed' ? '复制失败' : '复制链接';
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1" aria-live="polite">
      <a className={routeGhostClass} href={props.binding.chatUrl} target="_blank" rel="noopener noreferrer">
        打开会话
      </a>
      <button type="button" className={routeGhostClass} onClick={props.onCopy}>
        {copyLabel}
      </button>
      <button type="button" className={routeGhostClass} data-route-change onClick={props.onToggleChoosing}>
        更换
      </button>
    </div>
  );
}

interface Layout {
  standing: Standing;
  /** No write of unknown outcome is waiting on a read. */
  settled: boolean;
  binding: BoundConversation | null;
  showConversation: boolean;
  showActions: boolean;
  showChooser: boolean;
}

function layoutOf(props: CloudConversationLinkViewProps): Layout {
  const standing = standingOf(props.route, props.authorized, props.operation);
  const settled = standing !== 'confirming' && standing !== 'unknown';
  const binding = props.route.kind === 'ready' && props.route.binding !== 'invalid' ? props.route.binding : null;
  // While choosing, a working connection is marked in the list itself — once the list is there.
  const markedInList = standing === 'connected' && props.choosing && props.authorized.kind === 'ready';
  // A route whose change is being confirmed keeps its chooser (and the selection) in view, inert.
  const lastRead = standingOf(props.route, props.authorized, IDLE);
  return {
    standing,
    settled,
    binding,
    showConversation: binding !== null && settled && !markedInList,
    showActions: binding !== null && standing === 'connected' && !props.choosing,
    showChooser: props.route.kind === 'ready' && (props.choosing || NEEDS_CHOICE.has(lastRead)),
  };
}

/**
 * The thread's ChatGPT conversation, and the place to change it: folded to the conversation and three
 * quiet actions while it works; unfolded to the choice of authorized conversations when there is none,
 * when it stopped working, or when the owner asks to change it.
 */
export function CloudConversationLinkView(props: CloudConversationLinkViewProps) {
  const sectionRef = useRef<HTMLElement>(null);
  useRequestedFocus(sectionRef, props.focusRequest);
  const { standing, settled, binding, showConversation, showActions, showChooser } = layoutOf(props);
  return (
    <section
      ref={sectionRef}
      aria-label={props.catLabel ? `${props.catLabel} 的 ChatGPT 会话` : 'ChatGPT 会话'}
      className="console-list-card mt-2 min-w-0 rounded-xl p-2.5"
      data-testid="cloud-conversation-link"
    >
      <Header catLabel={props.catLabel} standing={standing} onReread={props.onReread} />
      {binding && showConversation ? <Conversation binding={binding} authorized={props.authorized} /> : null}
      <StandingNote
        standing={standing}
        catLabel={props.catLabel}
        choices={props.authorized.kind === 'ready' && props.authorized.candidates.length > 0}
      />
      {binding && showActions ? <ConnectedActions {...props} binding={binding} /> : null}
      {showChooser ? (
        <CloudConversationRouteChooser
          radioName={props.radioName}
          authorized={props.authorized}
          boundId={binding?.conversationId ?? null}
          hasRecord={props.route.kind === 'ready' && props.route.binding !== null}
          boundUsable={standing === 'connected'}
          selectedConversationId={props.selectedConversationId}
          busy={settled ? props.busy : 'reconcile'}
          cancellable={standing === 'connected'}
          onSelect={props.onSelect}
          onConfirm={props.onConfirm}
          onCancel={props.onToggleChoosing}
          onDisconnect={props.onDisconnect}
          onRetry={props.onRetryList}
        />
      ) : null}
      <RouteOperationNotice operation={props.operation} onReread={props.onReread} />
    </section>
  );
}
