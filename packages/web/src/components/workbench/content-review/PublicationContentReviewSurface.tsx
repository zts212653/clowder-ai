'use client';
import { type ReviewedMediaAsset, reviewedMediaAssetSchema } from '@cat-cafe/shared';
import { type ReactNode, useEffect, useState } from 'react';
import { artworkActionsCopy } from '@/components/content-review/artwork-actions.shell-copy';
import { checked } from '@/components/content-review/modification-http';
import { useShellCopy } from '@/components/shell/shell-copy';
import type { WorkspaceFileNavigationOrigin } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import { useWorkspaceSurfaceVisibility } from '../WorkspaceSurfaceVisibility';
import { ContentLandingHeader } from './ContentLandingHeader';
import { ContentReviewSurface } from './ContentReviewSurface';
import { useWorkspaceContentReview } from './useWorkspaceContentReview';
import { VideoWorkReview } from './VideoWorkReview';

type Props = {
  contentRef: string;
  ownerRevision: number;
  title: string;
  onBack: () => void;
  onVersionChange?: (revision: number) => void;
  navigationOrigin?: WorkspaceFileNavigationOrigin;
  leadingAction?: ReactNode;
  fullWindowAction?: { active: boolean; onToggle: () => void };
};
function checkedPublication(
  value: { asset: unknown; currentOwnerRevision: number },
  contentRef: string,
  ownerRevision: number,
) {
  const asset = reviewedMediaAssetSchema.parse(value.asset);
  if (
    asset.contentRef !== contentRef ||
    asset.ownerRevision !== ownerRevision ||
    !Number.isSafeInteger(value.currentOwnerRevision) ||
    value.currentOwnerRevision < ownerRevision
  )
    throw new Error('作品版本暂时无法核对。');
  return asset;
}
export function PublicationContentReviewSurface(props: Props) {
  return <PublicationSelection key={JSON.stringify([props.contentRef, props.ownerRevision])} {...props} />;
}
function PublicationSelection(props: Props) {
  const [selected, setSelected] = useState(props.ownerRevision);
  return (
    <PublicationSurface
      key={`${props.contentRef}:${selected}`}
      {...props}
      ownerRevision={selected}
      onVersionChange={(revision) => {
        setSelected(revision);
        props.onVersionChange?.(revision);
      }}
    />
  );
}
function PublicationSurface({
  contentRef,
  ownerRevision,
  title,
  onBack,
  navigationOrigin,
  onVersionChange,
  leadingAction,
  fullWindowAction,
}: Props) {
  const titleInHost = false;
  const artworkCopy = useShellCopy(artworkActionsCopy);
  const review = useWorkspaceContentReview({ publication: { contentRef, ownerRevision } });
  const visible = useWorkspaceSurfaceVisibility();
  const [latest, setLatest] = useState(ownerRevision),
    [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [verifiedAsset, setVerifiedAsset] = useState<{ asset: ReviewedMediaAsset; attempt: number } | null>(null);
  useEffect(() => {
    if (!visible) {
      setVerifiedAsset(null);
      return;
    }
    const abort = new AbortController();
    const refresh = async () => {
      try {
        const value = await checked<{ asset: unknown; currentOwnerRevision: number }>(
          await apiFetch(`/api/content-publications/${encodeURIComponent(contentRef)}?ownerRevision=${ownerRevision}`, {
            signal: abort.signal,
          }),
        );
        const asset = checkedPublication(value, contentRef, ownerRevision);
        if (!abort.signal.aborted) {
          setLatest(value.currentOwnerRevision);
          setError(null);
          setVerifiedAsset({ asset, attempt });
        }
      } catch (failure) {
        if (!abort.signal.aborted) {
          setVerifiedAsset(null);
          setError(failure instanceof Error ? failure.message : '暂时无法核对作品。');
        }
      }
    };
    void refresh();
    const interval = setInterval(() => void refresh(), 5000);
    return () => {
      abort.abort();
      clearInterval(interval);
    };
  }, [contentRef, ownerRevision, visible, attempt]);
  if (error)
    return (
      <section data-content-opening-state="blocked">
        <ContentLandingHeader
          title={titleInHost ? undefined : title}
          leadingAction={leadingAction}
          fullWindowAction={fullWindowAction}
          navigationOrigin={navigationOrigin}
          onBack={onBack}
        />
        <p role="alert" className="text-sm text-cafe-error">
          {error}
        </p>
        <button type="button" onClick={() => setAttempt((n) => n + 1)} className="mt-2 text-sm text-cafe-accent">
          重新读取作品
        </button>
      </section>
    );
  const historical = latest !== ownerRevision;
  const effective =
    historical && review.view
      ? { ...review, view: { ...review.view, canWrite: false, historyReadOnly: true } }
      : review;
  if (
    contentRef.startsWith('work:') &&
    verifiedAsset?.attempt === attempt &&
    verifiedAsset.asset.media.kind === 'video'
  )
    return (
      <VideoWorkReview
        asset={verifiedAsset.asset}
        latest={latest}
        review={effective}
        title={title}
        onBack={onBack}
        onVersionChange={onVersionChange}
        leadingAction={leadingAction}
        fullWindowAction={fullWindowAction}
        navigationOrigin={navigationOrigin}
      />
    );
  return (
    <ContentReviewSurface
      review={effective}
      publication={{
        contentRef,
        ownerRevision,
        asset: verifiedAsset?.attempt === attempt ? verifiedAsset.asset : null,
      }}
      path={title}
      sourceText=""
      sourceTextRevision=""
      navigationOrigin={navigationOrigin}
      onBack={onBack}
      title={title}
      titleInHost={titleInHost}
      leadingAction={leadingAction}
      fullWindowAction={fullWindowAction}
      workflow={
        historical
          ? {
              status: (
                <p className="px-3 text-xs text-cafe-muted">
                  第 {ownerRevision} 版 · {effective.view?.canReply ? '可继续讨论，画面不可改。' : '历史只读。'}
                  <button type="button" onClick={() => onVersionChange?.(latest)} className="ml-2 text-cafe-accent">
                    查看最新版本
                  </button>
                </p>
              ),
            }
          : undefined
      }
      versionControl={
        <label className="shrink-0 text-xs text-cafe-muted">
          <span className="sr-only">作品版本</span>
          <select
            aria-label={artworkCopy.versionLabel}
            value={ownerRevision}
            onChange={(event) => onVersionChange?.(Number(event.target.value))}
            className="rounded bg-transparent p-1"
          >
            {Array.from({ length: latest }, (_, index) => index + 1).map((revision) => (
              <option key={revision} value={revision}>
                {artworkCopy.versionNumber(revision)} ·{' '}
                {revision === latest ? artworkCopy.current : artworkCopy.historyVersion}
              </option>
            ))}
          </select>
        </label>
      }
    />
  );
}
