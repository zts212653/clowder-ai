'use client';

import { type ReactNode, useState } from 'react';
import { type CatData, formatCatName } from '@/hooks/useCatData';
import { catColorVar } from '@/lib/cat-slug';
import type { ChatMessage } from '@/stores/chat-types';
import { dispatchChatLayoutChanged } from '@/utils/chat-layout-change';
import { CatNameplate } from '../CatNameplate';
import { MessageActions } from '../MessageActions';
import { useShellPresentation } from '../shell/shell-presentation';
import { useMessageNavigation } from '../thread-chat/MessageNavigationContext';
import { causalContinuationId, focusCausalContinuation, useCausalReplies } from './CausalReplyContext';
import type { CausalReplySlice } from './causal-reply-projection';
import { NativeReplyText } from './NativeReplyText';
import { ReplyOutputBody } from './ReplyOutputBody';
import { REPLY_BODY_CLASS } from './reply-body';
import type { ReplyOutputText } from './reply-output';
import { canRenderReplyLayers } from './reply-presentation';

function sliceRun(response: ChatMessage, start: number, end: number) {
  // Cutting inside Markdown syntax must not swallow or invent source text. The
  // complete, formatted original remains available at the execution anchor.
  const paragraphBoundary = (offset: number) =>
    offset === 0 || offset === response.content.length || response.content.slice(0, offset).endsWith('\n\n');
  const inFence = (offset: number) => {
    let fence = '';
    response.content
      .slice(0, offset)
      .split('\n')
      .forEach((line) => {
        const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
        if (!marker) return;
        if (!fence) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length) fence = '';
      });
    return Boolean(fence);
  };
  return {
    kind: 'text' as const,
    id: `causal:${response.id}:${start}`,
    start,
    end,
    text: response.content.slice(start, end),
    literal: !paragraphBoundary(start) || !paragraphBoundary(end) || inFence(start) || inFence(end),
  };
}

/** Only the original body is clipped; execution records and canonical actions stay on R. */
function CausalReplyText({
  response,
  start,
  end,
  layered,
}: {
  response: ChatMessage;
  start: number;
  end: number;
  layered: boolean;
}) {
  const presentation = useCausalReplies();
  const native = layered ? presentation?.nativeOutputs.get(response.id) : undefined;
  if (!native) return <NativeReplyText run={sliceRun(response, start, end)} className={REPLY_BODY_CLASS} />;
  const clip = (run: ReplyOutputText) => {
    const from = Math.max(start, run.start),
      to = Math.min(end, run.end);
    return from < to ? [sliceRun(response, from, to)] : [];
  };
  const record = native.record.flatMap((entry) => (entry.kind === 'text' ? clip(entry) : []));
  return (
    <ReplyOutputBody
      output={{ ...native, answers: native.answers.flatMap(clip), record, processCount: record.length }}
      className={REPLY_BODY_CLASS}
    />
  );
}

export function CausalReplyOriginal({
  response,
  layered,
  children,
}: {
  response: ChatMessage;
  layered: boolean;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const original = useCausalReplies()?.originals.get(response.id);
  if (!original) return children;
  const { end, inputMessageId } = original;
  return (
    <div data-causal-original={response.id}>
      {expanded ? null : end > 0 ? (
        <CausalReplyText response={response} start={0} end={end} layered={layered} />
      ) : (
        <p className="text-sm text-cafe-muted">本轮正文接续在下方</p>
      )}
      <a
        className="mt-2 inline-block text-sm text-cafe-secondary hover:underline"
        href={`#${causalContinuationId(inputMessageId, response.id)}`}
        onClick={(event) => {
          event.preventDefault();
          focusCausalContinuation(inputMessageId, response.id);
        }}
      >
        查看接续正文 ↓
      </a>
      <div className="mt-2">
        <button
          type="button"
          className="text-sm text-cafe-secondary hover:underline"
          aria-expanded={expanded}
          data-reading-disclosure
          onClick={() => {
            setExpanded((value) => !value);
            requestAnimationFrame(() => dispatchChatLayoutChanged());
          }}
        >
          {expanded ? '收起完整原文' : '查看完整原文'}
        </button>
        {expanded ? (
          <div className="mt-2 border-t border-cafe pt-2" data-causal-full-text>
            <NativeReplyText
              className={REPLY_BODY_CLASS}
              run={{
                kind: 'text',
                id: `causal-full:${response.id}`,
                start: 0,
                end: response.content.length,
                text: response.content,
              }}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** This action scope belongs to R, never to the input S above it. */
function Continuation({
  slice,
  threadId,
  getCatById,
  forwardingDisabled,
  compact = false,
}: {
  slice: CausalReplySlice;
  threadId: string;
  getCatById: (id: string) => CatData | undefined;
  forwardingDisabled: boolean;
  compact?: boolean;
}) {
  const { response, inputMessageId, start, end } = slice;
  const navigate = useMessageNavigation();
  const shellPresentation = useShellPresentation();
  const layered = canRenderReplyLayers(response, { shellPresentation, compact, currentThreadId: threadId });
  const cat = response.catId ? getCatById(response.catId) : undefined;
  return (
    <div
      id={causalContinuationId(inputMessageId, response.id)}
      data-causal-continuation={response.id}
      className="mb-4 scroll-mt-4"
      data-causal-input={inputMessageId}
      data-causal-next-input={start === end ? slice.nextInputMessageId : undefined}
      tabIndex={-1}
    >
      <MessageActions message={response} threadId={threadId} forwardingDisabled={forwardingDisabled}>
        {response.catId ? (
          <CatNameplate catId={response.catId} name={cat ? formatCatName(cat) : response.catId} />
        ) : null}
        <div className="mb-2 text-xs text-cafe-muted" data-quote-exclude>
          同一轮 · 接续上文
          <button type="button" className="ml-2 hover:underline" onClick={() => navigate(response.id)}>
            查看原执行
          </button>
        </div>
        <div className="pl-4" style={{ borderLeft: `3px solid ${catColorVar(response.catId, 'primary')}` }}>
          {start < end ? (
            <CausalReplyText response={response} start={start} end={end} layered={layered} />
          ) : slice.nextInputMessageId ? (
            <p className="text-sm text-cafe-muted">
              后续正文接续在下一条补充下方。
              <button
                type="button"
                className="ml-1 hover:underline"
                onClick={() => {
                  if (slice.nextInputMessageId) focusCausalContinuation(slice.nextInputMessageId, response.id);
                }}
              >
                查看接续
              </button>
            </p>
          ) : (
            <p className="text-sm text-cafe-muted">
              {response.lifecycle?.kind === 'response' && response.lifecycle.status === 'processing'
                ? '本条已接入，等待后续正文…'
                : '本条之后没有新增正文，可查看原执行记录。'}
            </p>
          )}
        </div>
      </MessageActions>
    </div>
  );
}

export function CausalReplyContinuations({
  inputMessageId,
  ...props
}: {
  inputMessageId: string;
  threadId: string;
  getCatById: (id: string) => CatData | undefined;
  forwardingDisabled: boolean;
  compact?: boolean;
}) {
  const projection = useCausalReplies();
  return (
    projection?.continuations
      .get(inputMessageId)
      ?.map((slice) => <Continuation key={slice.response.id} slice={slice} {...props} />) ?? null
  );
}
