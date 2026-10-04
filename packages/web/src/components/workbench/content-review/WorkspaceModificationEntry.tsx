'use client';

import type { ContentModificationRequest } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { ContentModificationLanding } from '@/components/content-review/ContentModificationLanding';
import { modificationSourceVersion } from '@/components/content-review/modification-draft';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import type { ContentReviewView } from './content-review-contract';
import type { WorkspaceAnnotationTarget } from './useWorkspaceContentReview';

export function WorkspaceModificationEntry({
  view,
  path,
  target,
  disabled,
  onApplied,
  onExpanded,
}: {
  view: ContentReviewView;
  path: string;
  target: WorkspaceAnnotationTarget | null;
  disabled: boolean;
  onApplied?: (writtenRevision?: string) => Promise<void> | void;
  onExpanded?: () => void;
}) {
  const [intent, setIntent] = useState<{
    sourceVersion: string;
    value: Omit<ContentModificationRequest['intent'], 'body'>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const source = view.review.source;
  const requestSource: ContentModificationRequest['source'] =
    source.kind === 'publication'
      ? {
          kind: 'publication',
          contentRef: source.publication.contentRef,
          ownerRevision: source.publication.ownerRevision,
          ledgerRef: view.review.reviewId,
          expectedLedgerRevision: view.review.revision,
        }
      : source.kind === 'evolution'
        ? {
            kind: 'evolution',
            locator: source.locator,
            expectedSourceRevision: source.revision,
            reviewId: view.review.reviewId,
            expectedReviewRevision: view.review.revision,
          }
        : {
            kind: 'workspace',
            locator: source.locator,
            expectedSourceRevision: source.revision,
            reviewId: view.review.reviewId,
            expectedReviewRevision: view.review.revision,
          };
  const sourceVersion = modificationSourceVersion(requestSource);
  const openKey = JSON.stringify([view.review.ownerUserId, sourceVersion, target]);
  const currentOpenKey = useRef(openKey);
  currentOpenKey.current = openKey;
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const open = async () => {
    if (preparing || view.sourceState === 'unavailable') return;
    setError(null);
    setPreparing(true);
    const ticket = ++generation.current;
    try {
      let next: Omit<ContentModificationRequest['intent'], 'body'>;
      if (!disabled && target?.kind === 'text_quote') {
        const response = await apiFetch('/api/content-modifications/selection', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ source: requestSource, quote: target.quote }),
        });
        if (!response.ok)
          throw new Error('选中文字暂时无法唯一定位。请重新选择更多上下文，或取消选区后明确修改整份文件。');
        const result = (await response.json()) as { selection: ContentModificationRequest['intent']['selection'] };
        next = { selection: result.selection };
      } else next = target?.kind === 'media_anchor' ? { selection: target.anchor } : {};
      if (generation.current === ticket && currentOpenKey.current === openKey) {
        setIntent({ sourceVersion, value: next });
        onExpanded?.();
      }
    } catch (error) {
      if (generation.current === ticket && currentOpenKey.current === openKey)
        setError(error instanceof Error ? error.message : '暂时无法打开修改请求。');
    } finally {
      if (generation.current === ticket) setPreparing(false);
    }
  };
  return (
    <>
      <div className="flex shrink-0 items-center justify-end gap-2 bg-cafe-surface px-3 py-2">
        {error ? (
          <p role="alert" className="text-xs text-cafe-error">
            {error}
          </p>
        ) : null}
        <button
          type="button"
          data-testid="content-modification-entry"
          disabled={view.sourceState === 'unavailable' || preparing}
          onClick={() => void open()}
          className="shrink-0 rounded-md border border-cafe-subtle px-3 py-1.5 text-xs font-semibold text-cafe-accent"
        >
          {preparing
            ? '正在核对选区…'
            : disabled
              ? '修改记录'
              : source.kind === 'evolution'
                ? '作为新作品修改'
                : '请猫修改'}
        </button>
      </div>
      {intent && view.sourceState !== 'unavailable' ? (
        <>
          {source.kind === 'evolution' ? (
            <p className="px-3 text-xs text-cafe-muted">
              修改结果会作为新作品返回，实验原件和原讨论保留。
              {source.mime === 'video/webm'
                ? ' 新作品使用 MP4，并转换本次选区的时间坐标。'
                : source.mime === 'image/jpeg' || source.mime === 'image/webp'
                  ? ' 新作品使用 PNG，保留显示方向。'
                  : ''}
            </p>
          ) : null}
          <ContentModificationLanding
            allowNewRequest={!disabled}
            title={path.split('/').at(-1) || path}
            ownerUserId={view.review.ownerUserId}
            source={requestSource}
            mediaType={source.mime}
            initialIntent={intent.value}
            initialIntentSourceVersion={intent.sourceVersion}
            suggestedThreadId={useChatStore.getState().currentThreadId}
            onClose={() => {
              generation.current++;
              setPreparing(false);
              setIntent(null);
            }}
            onApplied={onApplied}
          />
        </>
      ) : null}
    </>
  );
}
