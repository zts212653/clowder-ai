'use client';

import type { AuthorizedConversationCandidate } from './authorized-conversations';

function authorizationTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

export function ConversationSummary({
  candidate,
  connected = false,
}: {
  candidate: AuthorizedConversationCandidate;
  connected?: boolean;
}) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block break-words text-sm font-semibold text-cafe" title={candidate.displayTitle}>
        {candidate.displayTitle ?? candidate.conversationId}
      </span>
      <span className="mt-0.5 block text-xs text-cafe-muted">
        {connected
          ? '已连接当前对话'
          : candidate.displayTitle
            ? '已授权，可连接当前对话'
            : candidate.authorizedAt
              ? `授权于 ${authorizationTime(candidate.authorizedAt)}`
              : '已授权会话'}
      </span>
    </span>
  );
}

export function OpenConversation({ candidate }: { candidate: AuthorizedConversationCandidate }) {
  return (
    <a
      data-recovery-inspect-conversation
      href={candidate.chatUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="shrink-0 py-2 text-xs font-semibold text-cafe-secondary hover:text-cafe"
    >
      打开原对话
    </a>
  );
}

export function ConversationDetails({ candidate }: { candidate: AuthorizedConversationCandidate }) {
  return (
    <details className="mt-1 text-xs text-cafe-muted">
      <summary className="cursor-pointer py-1">授权信息</summary>
      {candidate.authorizedAt && <p>授权于 {authorizationTime(candidate.authorizedAt)}</p>}
      <code title={candidate.conversationId} className="block break-all font-mono">
        {candidate.conversationId}
      </code>
    </details>
  );
}

/**
 * `cards` stands alone inside a message; `rows` sits inside a card that already frames it (the thread
 * panel), so its choices are hairline-separated rows rather than cards within a card, and a long list
 * scrolls inside the panel so the actions below it stay in reach. Every chooser on a page needs its
 * own radio `name`: a message's recovery card and the thread panel can be open at the same time.
 */
export function CloudConversationChoices({
  candidates,
  selectedConversationId,
  boundConversationId,
  busy,
  onSelect,
  name,
  layout = 'cards',
}: {
  candidates: AuthorizedConversationCandidate[];
  selectedConversationId: string | null;
  boundConversationId: string | null;
  busy: boolean;
  onSelect: (id: string) => void;
  /** The radio group's name, unique on the page. */
  name: string;
  layout?: 'cards' | 'rows';
}) {
  const rows = layout === 'rows';
  const itemClass = (selected: boolean) =>
    rows
      ? `min-w-0 px-1 py-1.5 ${selected ? 'bg-[var(--console-hover-bg)]' : ''}`
      : `min-w-0 rounded-lg border px-3 py-2 ${selected ? 'border-cafe-accent bg-[var(--console-hover-bg)]' : 'border-[var(--console-border-soft)] bg-[var(--console-card-bg)]'}`;
  return (
    <fieldset
      className={
        rows
          ? 'mt-2 grid max-h-72 divide-y divide-[var(--console-border-soft)] overflow-y-auto overscroll-contain border-y border-[var(--console-border-soft)]'
          : 'mt-3 grid gap-2'
      }
    >
      <legend className="sr-only">选择 ChatGPT 会话</legend>
      {candidates.map((candidate) => (
        <div key={candidate.conversationId} className={itemClass(selectedConversationId === candidate.conversationId)}>
          <div className="flex items-start gap-3">
            <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 py-1">
              <input
                className="mt-1 shrink-0"
                type="radio"
                name={name}
                value={candidate.conversationId}
                checked={selectedConversationId === candidate.conversationId}
                disabled={busy}
                onChange={() => onSelect(candidate.conversationId)}
              />
              <ConversationSummary candidate={candidate} connected={candidate.conversationId === boundConversationId} />
            </label>
            <OpenConversation candidate={candidate} />
          </div>
          {/* In a panel's rows the choice stays one line each; "打开原对话" identifies the conversation. */}
          {rows ? null : <ConversationDetails candidate={candidate} />}
        </div>
      ))}
    </fieldset>
  );
}
