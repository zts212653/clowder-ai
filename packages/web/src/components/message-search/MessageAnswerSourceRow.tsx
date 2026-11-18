import type { MessageSearchResponse, MessageSearchResult } from '@cat-cafe/shared';
import { HighlightedMessageSnippet } from './HighlightedMessageSnippet';
import { MessageResultSpeaker } from './MessageResultSpeaker';
import { MessageSelectedSource } from './MessageSelectedSource';
import { MessageSourceContext } from './MessageSourceContext';
import { decisionLabel } from './message-source-read';
import type { useMessageSourceActions } from './useMessageSourceActions';

const inlineAction =
  'rounded-md px-1.5 py-0.5 text-xs hover:bg-[var(--console-hover-bg)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-500)]';

/** Compact answer presentation; the shared row still owns validation and source actions. */
export function MessageAnswerSourceRow({
  result,
  response,
  index,
  currentThreadId,
  speaker,
  readonly,
  onNavigate,
  resolveSpeaker,
  action,
  showSelectionReason,
}: {
  result: MessageSearchResult;
  response: MessageSearchResponse;
  index: number;
  currentThreadId: string;
  speaker: string;
  readonly: boolean;
  onNavigate: (result: MessageSearchResult, response: MessageSearchResponse) => void;
  resolveSpeaker: (id: string) => string;
  action: ReturnType<typeof useMessageSourceActions>;
  showSelectionReason: boolean;
}) {
  const labels = [...new Set(result.decisionSources?.map((fact) => decisionLabel(fact.status)) ?? [])];
  const selected = result.selection;
  return (
    <li data-message-search-result className="min-w-0 py-2.5 first:pt-0 last:pb-0">
      <div
        className={`mb-1.5 grid items-center gap-x-2 [@container(max-width:26rem)]:gap-y-1 ${readonly ? 'grid-cols-[minmax(0,max-content)_minmax(0,1fr)] [@container(max-width:26rem)]:grid-cols-1' : 'grid-cols-[minmax(0,max-content)_minmax(0,1fr)_auto] [@container(max-width:26rem)]:grid-cols-[minmax(0,1fr)_auto]'}`}
      >
        <div className="min-w-0 max-w-full overflow-hidden">
          <MessageResultSpeaker speaker={result.speaker} label={speaker} />
        </div>
        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden text-xs text-cafe-muted [@container(max-width:26rem)]:col-span-full [@container(max-width:26rem)]:row-start-2">
          {selected?.part.kind === 'comment' && (
            <span className="shrink-0 rounded-full bg-[var(--console-hover-bg)] px-1.5 py-0.5">引用批注</span>
          )}
          {labels.map((label) => (
            <span
              key={label}
              data-message-decision-label
              className="shrink-0 rounded-full bg-[var(--console-hover-bg)] px-1.5 py-0.5 text-cafe-secondary"
            >
              {label}
            </span>
          ))}
          <span className="min-w-0 truncate">
            {result.threadId === currentThreadId ? '当前对话' : result.threadTitle || '对话标题不可用'}
          </span>
          <time className="shrink-0" dateTime={new Date(result.timestamp).toISOString()}>
            ·{' '}
            {new Intl.DateTimeFormat('zh-CN', {
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
            }).format(result.timestamp)}
          </time>
        </div>
        {!readonly && (
          <div className="flex shrink-0 items-center gap-1 justify-self-end [@container(max-width:26rem)]:col-start-2 [@container(max-width:26rem)]:row-start-1">
            <button
              type="button"
              aria-label="引用到聊天"
              className={`${inlineAction} text-cafe-muted`}
              disabled={action.busy !== null || action.quoted}
              onClick={() => void action.quote()}
            >
              {action.busy === 'quote' ? '读取中…' : action.quoted ? '已引用' : '引用'}
            </button>
            <button
              type="button"
              aria-label={`去原处：${speaker} · 第${index + 1}处`}
              className={`${inlineAction} text-[var(--accent-600)]`}
              onClick={() => void action.navigate(() => onNavigate(result, response))}
            >
              去原处 ›
            </button>
          </div>
        )}
      </div>
      {selected ? (
        <MessageSelectedSource result={result} speaker={speaker} resolveSpeaker={resolveSpeaker} />
      ) : (
        <div className="line-clamp-3 border-l-2 border-[var(--console-border-strong)] pl-2.5 text-sm leading-[1.55] text-cafe-secondary">
          <HighlightedMessageSnippet result={result} />
        </div>
      )}
      {!readonly && (
        <div className="mt-1.5 flex min-w-0 items-center justify-between gap-2">
          <button
            type="button"
            aria-label={`${action.expanded ? '收起' : '展开'}前后文：第${index + 1}处`}
            aria-expanded={action.expanded}
            onClick={() => void action.expand()}
            className="flex shrink-0 items-center gap-1 py-0.5 text-xs text-cafe-muted hover:text-cafe focus-visible:outline"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 12 12"
              className={`h-3 w-3 ${action.expanded ? 'rotate-90' : ''}`}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
            >
              <path d="m4 2 4 4-4 4" />
            </svg>
            {action.expanded ? '收起前后文' : '展开前后文'}
          </button>
          {selected && showSelectionReason && (
            <p
              title={selected.reason}
              className="min-w-0 truncate text-xs text-cafe-muted [@container(max-width:26rem)]:hidden"
            >
              {response.meta.answerSelection && resolveSpeaker(response.meta.answerSelection.catId)} 选用理由：
              {selected.reason}
            </p>
          )}
        </div>
      )}
      {!readonly && action.expanded && (
        <div
          data-message-search-context
          className="mt-2 max-h-64 space-y-3 overflow-y-auto rounded-lg border border-[var(--console-border-soft)] bg-[var(--console-hover-bg)] p-3 text-sm text-cafe-secondary"
        >
          {action.busy === 'expand' && <p role="status">正在读取原文…</p>}
          {action.context && (
            <MessageSourceContext
              context={action.context}
              query={response.query}
              result={result}
              resolveSpeaker={resolveSpeaker}
              markdown
            />
          )}
          {selected && response.meta.answerSelection && (
            <p className="text-xs text-cafe-muted">
              选材说明（非原文）：{resolveSpeaker(response.meta.answerSelection.catId)} · {selected.reason}
            </p>
          )}
        </div>
      )}
      {action.error && (
        <p role="alert" className="mt-1 text-xs text-cafe-secondary">
          {action.error}
        </p>
      )}
    </li>
  );
}
