import type { MessageSearchResponse, MessageSearchResult } from '@cat-cafe/shared';
import { HighlightedMessageSnippet } from './HighlightedMessageSnippet';
import { MessageResultSpeaker } from './MessageResultSpeaker';
import { MessageSourceContext } from './MessageSourceContext';
import { matchingDecisionSources, queryMatchRanges } from './message-query-presentation';
import { decisionLabel } from './message-source-read';
import { useMessageSourceActions } from './useMessageSourceActions';

export const searchButtonClass =
  'rounded-lg border border-[var(--console-border-soft)] px-3 py-1 text-xs text-cafe-secondary hover:bg-[var(--console-hover-bg)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-500)]';

export function MessageSearchResultRow({
  result,
  response,
  index,
  currentThreadId,
  speaker,
  journey6,
  readonly,
  onNavigate,
  resolveSpeaker,
  beforeAction,
}: {
  result: MessageSearchResult;
  response: MessageSearchResponse;
  index: number;
  currentThreadId: string;
  speaker: string;
  journey6: boolean;
  readonly: boolean;
  onNavigate: (result: MessageSearchResult, response: MessageSearchResponse) => void;
  resolveSpeaker: (speaker: string) => string;
  beforeAction?: (signal: AbortSignal) => Promise<boolean>;
}) {
  const action = useMessageSourceActions(result, currentThreadId, resolveSpeaker, beforeAction);
  const enhanced = journey6 && !readonly;
  const sourceDecision =
    queryMatchRanges(result.snippet.text, response.query).length === 0
      ? matchingDecisionSources(result, response.query)[0]
      : undefined;
  const labels = [...new Set(result.decisionSources?.map((fact) => decisionLabel(fact.status)) ?? [])];
  const conversation =
    response.meta.scope === 'global' ? (
      <span>{result.threadId === currentThreadId ? '当前对话' : result.threadTitle || '对话标题不可用'}</span>
    ) : null;
  return (
    <li data-message-search-result className={`flex gap-3 py-3 ${enhanced ? 'flex-col' : 'items-center'}`}>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-cafe-muted">
          <MessageResultSpeaker speaker={result.speaker} label={speaker} />
          {enhanced && conversation}
          <time dateTime={new Date(result.timestamp).toISOString()}>
            {new Intl.DateTimeFormat(undefined, {
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
            }).format(result.timestamp)}
          </time>
          {!enhanced && conversation}
          {enhanced &&
            labels.map((label) => (
              <span
                key={label}
                data-message-decision-label
                className="rounded bg-[var(--console-hover-bg)] px-1.5 py-0.5 text-cafe-secondary"
              >
                {label}
              </span>
            ))}
          {index === 0 && response.meta.sort === 'time' && <span>本次结果中最早</span>}
        </div>
        {enhanced ? (
          <button
            type="button"
            aria-label={`展开前后文：第${index + 1}处`}
            aria-expanded={action.expanded}
            onClick={() => void action.expand()}
            className="flex w-full items-start gap-2 rounded text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-500)]"
          >
            <span
              className={`${sourceDecision ? 'flex' : 'line-clamp-2'} min-w-0 flex-1 break-words text-sm leading-6 text-cafe-secondary`}
            >
              {sourceDecision ? (
                <>
                  <span className="shrink-0">这是「</span>
                  <span className="truncate" title={sourceDecision.conclusion}>
                    {sourceDecision.conclusion}
                  </span>
                  <span className="shrink-0">」这条决定的出处</span>
                </>
              ) : (
                <HighlightedMessageSnippet result={result} />
              )}
            </span>
            <span aria-hidden="true" className="shrink-0 text-xs leading-6 text-cafe-muted">
              {action.expanded ? '收起' : '展开'}
            </span>
          </button>
        ) : (
          <p className="break-words text-sm leading-6 text-cafe-secondary">
            <HighlightedMessageSnippet result={result} />
          </p>
        )}
      </div>
      {enhanced && action.expanded && (
        <div
          data-message-search-context
          className="space-y-3 rounded-lg border-l-2 border-[var(--console-border-soft)] pl-3 text-sm text-cafe-secondary"
        >
          {action.busy === 'expand' && <p role="status">正在读取原文…</p>}
          {action.context && (
            <MessageSourceContext
              context={action.context}
              query={response.query}
              result={result}
              resolveSpeaker={resolveSpeaker}
            />
          )}
        </div>
      )}
      {!readonly && (
        <div className="flex shrink-0 flex-wrap gap-2">
          <button
            type="button"
            className={searchButtonClass}
            onClick={() => onNavigate(result, response)}
            aria-label={`${enhanced ? '去原处' : '跳过去'}：${speaker} · 第${index + 1}处`}
          >
            {enhanced ? '去原处' : '跳过去 ›'}
          </button>
          {enhanced && (
            <button
              type="button"
              className={searchButtonClass}
              disabled={action.busy !== null || action.quoted}
              onClick={() => void action.quote()}
            >
              {action.busy === 'quote' ? '读取中…' : action.quoted ? '已引用' : '引用到聊天'}
            </button>
          )}
        </div>
      )}
      {enhanced && action.error && (
        <p role="alert" className="text-xs text-cafe-secondary">
          {action.error}
        </p>
      )}
    </li>
  );
}
