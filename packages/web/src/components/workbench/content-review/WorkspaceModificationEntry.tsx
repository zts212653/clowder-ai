'use client';

import type { ContentModificationRecord, ContentModificationRequest } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useArtworkChrome, useRegisterArtworkHistory } from '@/components/content-review/ArtworkChrome';
import { ContentModificationLanding } from '@/components/content-review/ContentModificationLanding';
import { modificationSourceVersion, modificationStorageKey } from '@/components/content-review/modification-draft';
import {
  clearModificationFocus,
  modificationFocusStanding,
  usePendingModificationFocus,
} from '@/components/content-review/modification-focus';
import { textModificationCopy } from '@/components/content-review/text-modification.shell-copy';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { useWorkspaceChatReveal } from '../WorkspaceChatReveal';
import type { PrivateContentReviewView } from './content-review-contract';
import { requestTextModificationInChat, type TextChatRequest } from './request-text-modification-in-chat';
import type { WorkspaceAnnotationTarget } from './useWorkspaceContentReview';
import { workspaceReviewRequestSource } from './workspace-modification-source';

function entryLabel(
  state: { preparing: boolean; disabled: boolean; canRequest: boolean; evolution: boolean; chat: boolean },
  copy: { preparing: string; ask: string; records: string },
) {
  if (state.preparing) return state.chat ? copy.preparing : '正在核对选区…';
  if (state.disabled || !state.canRequest) return state.chat ? copy.records : '修改记录';
  if (state.evolution) return '作为新作品修改';
  return state.chat ? copy.ask : '请猫修改';
}

export function WorkspaceModificationEntry({
  view,
  path,
  target,
  disabled,
  allowNewRequest = true,
  onApplied,
  onExpanded,
  onComparing,
  openRequest = 0,
  hideTrigger = false,
  compact = false,
  chatRequest,
}: {
  view: PrivateContentReviewView;
  path: string;
  target: WorkspaceAnnotationTarget | null;
  disabled: boolean;
  allowNewRequest?: boolean;
  onApplied?: (writtenRevision?: string) => Promise<void> | void;
  onExpanded?: () => void;
  /**
   * Whether the Workspace is asked to show one returned candidate next to the original, and for which navigation:
   * the revision of the one that carried a receipt's ask for a candidate of this file. A receipt that only asks for
   * the file, and closing the panel, say `null`. The revision is how a newer navigation is told apart later.
   */
  onComparing?: (navigationRevision: number | null) => void;
  openRequest?: number;
  hideTrigger?: boolean;
  compact?: boolean;
  /** New text requests use the sole Chat; the original candidate/history consumer stays here. */
  chatRequest?: TextChatRequest;
}) {
  const [intent, setIntent] = useState<{
    sourceVersion: string;
    value: Omit<ContentModificationRequest['intent'], 'body'>;
  } | null>(null);
  // A request (and candidate) a conversation receipt asked to see; the landing selects it instead of guessing.
  const [focused, setFocused] = useState<{ record: ContentModificationRecord; candidateRef?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [chatNotice, setChatNotice] = useState<string | null>(null);
  const copy = useShellCopy(textModificationCopy);
  const revealChat = useWorkspaceChatReveal();
  const currentThreadId = useChatStore((state) => state.currentThreadId);
  const source = view.review.source;
  const requestSource = workspaceReviewRequestSource(view);
  const sourceVersion = modificationSourceVersion(requestSource);
  const objectKey = modificationStorageKey(view.review.ownerUserId, requestSource);
  const openKey = JSON.stringify([
    view.review.ownerUserId,
    sourceVersion,
    target,
    chatRequest?.revision,
    currentThreadId,
  ]);
  const currentOpenKey = useRef(openKey);
  currentOpenKey.current = openKey;
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const pendingFocus = usePendingModificationFocus();
  const openRevision = useChatStore((state) => state.workspaceOpenRevision);
  useEffect(() => {
    if (!pendingFocus) return;
    // The ask belongs to the one Workspace navigation that made it. A newer navigation retires it; another
    // conversation never takes it. No clock is involved, so a slow mount cannot lose an accepted click.
    const standing = modificationFocusStanding(pendingFocus, { threadId: currentThreadId, revision: openRevision });
    if (standing === 'superseded') return clearModificationFocus(pendingFocus);
    if (standing === 'elsewhere') return;
    if (view.sourceState === 'unavailable') return;
    const { record } = pendingFocus;
    // Same object (owner + file), whatever version each side last saw; another file's ask is never ours to take.
    if (objectKey !== modificationStorageKey(record.ownerUserId, record.payload.source)) return;
    generation.current++;
    setPreparing(false);
    setError(null);
    setFocused({ record, ...(pendingFocus.candidateRef ? { candidateRef: pendingFocus.candidateRef } : {}) });
    setIntent({ sourceVersion, value: {} });
    onExpanded?.();
    onComparing?.(pendingFocus.candidateRef ? pendingFocus.navigation.revision : null);
    clearModificationFocus(pendingFocus);
  }, [
    pendingFocus,
    currentThreadId,
    openRevision,
    view.sourceState,
    objectKey,
    sourceVersion,
    onExpanded,
    onComparing,
  ]);
  const open = useCallback(async () => {
    if (preparing || view.sourceState === 'unavailable') return;
    setError(null);
    setChatNotice(null);
    setPreparing(true);
    const ticket = ++generation.current;
    try {
      let next: Omit<ContentModificationRequest['intent'], 'body'>;
      if (!allowNewRequest && !chatRequest) next = {};
      else if (!disabled && target?.kind === 'text_quote') {
        const response = await apiFetch('/api/content-modifications/selection', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ source: requestSource, quote: target.quote }),
        });
        if (!response.ok)
          throw new Error(
            chatRequest
              ? copy.selectionFailed
              : '选中文字暂时无法唯一定位。请重新选择更多上下文，或取消选区后明确修改整份文件。',
          );
        const result = (await response.json()) as { selection: ContentModificationRequest['intent']['selection'] };
        next = { selection: result.selection };
      } else next = target?.kind === 'media_anchor' ? { selection: target.anchor } : {};
      if (generation.current === ticket && currentOpenKey.current === openKey) {
        if (chatRequest && !disabled && source.kind === 'text') {
          if (requestSource.kind !== 'workspace' || chatRequest.revision !== requestSource.expectedSourceRevision)
            return;
          const outcome = requestTextModificationInChat(
            currentThreadId,
            requestSource.locator,
            chatRequest,
            next.selection,
            target?.kind === 'text_quote' ? target.quote : undefined,
          );
          if (currentThreadId && (outcome === 'added' || outcome === 'existing')) revealChat?.(currentThreadId);
          setChatNotice(outcome === 'existing' ? null : copy[outcome]);
          return;
        }
        setIntent({ sourceVersion, value: next });
        onExpanded?.();
      }
    } catch (error) {
      if (generation.current === ticket && currentOpenKey.current === openKey)
        setError(error instanceof Error ? error.message : '暂时无法打开修改请求。');
    } finally {
      if (generation.current === ticket) setPreparing(false);
    }
  }, [
    preparing,
    view.sourceState,
    allowNewRequest,
    chatRequest,
    copy,
    revealChat,
    currentThreadId,
    source,
    disabled,
    target,
    requestSource,
    openKey,
    sourceVersion,
    onExpanded,
  ]);
  const openedRequest = useRef(0);
  useEffect(() => {
    if (!openRequest || openedRequest.current === openRequest) return;
    openedRequest.current = openRequest;
    void open();
  }, [openRequest, open]);
  useRegisterArtworkHistory(() => void open());
  const chrome = useArtworkChrome();
  const isV2 = useShellPresentation() === 'v2';
  const unifiedHistory = !!chrome && isV2 && compact && !allowNewRequest;
  return (
    <>
      {!hideTrigger && !unifiedHistory && (allowNewRequest || chatRequest || !intent) ? (
        <div
          className={
            compact
              ? 'absolute left-3 top-2 z-10 flex items-center gap-2 text-cafe-muted'
              : 'flex shrink-0 items-center justify-end gap-2 bg-cafe-surface px-3 py-2'
          }
        >
          {error ? (
            <p role="alert" className="text-xs text-cafe-error">
              {error}
            </p>
          ) : null}
          <button
            type="button"
            data-testid={allowNewRequest || chatRequest ? 'content-modification-entry' : 'content-modification-records'}
            disabled={view.sourceState === 'unavailable' || preparing}
            onClick={() => void open()}
            className={
              compact
                ? 'rounded-md px-2 py-1.5 text-xs hover:bg-cafe-surface'
                : 'shrink-0 rounded-md border border-cafe-subtle px-3 py-1.5 text-xs font-semibold text-cafe-accent'
            }
          >
            {entryLabel(
              {
                preparing,
                disabled,
                canRequest: allowNewRequest || !!chatRequest,
                evolution: source.kind === 'evolution',
                chat: !!chatRequest,
              },
              copy,
            )}
          </button>
        </div>
      ) : null}
      {chatNotice ? <output className="block px-3 py-2 text-xs text-cafe-muted">{chatNotice}</output> : null}
      {hideTrigger && error ? (
        <p role="alert" className="px-3 text-xs text-cafe-error">
          {error}
        </p>
      ) : null}
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
            allowNewRequest={allowNewRequest && !disabled && !chatRequest}
            title={path.split('/').at(-1) || path}
            ownerUserId={view.review.ownerUserId}
            source={requestSource}
            mediaType={source.mime}
            initialIntent={intent.value}
            initialIntentSourceVersion={intent.sourceVersion}
            initialRequest={focused?.record}
            focusCandidateRef={focused?.candidateRef}
            suggestedThreadId={useChatStore.getState().currentThreadId}
            onClose={() => {
              generation.current++;
              setPreparing(false);
              setIntent(null);
              setFocused(null);
              onComparing?.(null);
            }}
            onApplied={onApplied}
          />
        </>
      ) : null}
    </>
  );
}
