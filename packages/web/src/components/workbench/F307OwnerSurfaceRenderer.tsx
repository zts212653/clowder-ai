'use client';

import { type ReactNode, useCallback } from 'react';
import { EvolutionProgramSurface } from '@/components/capability-evolution/solution-gate/SolutionGateHost';
import { ArtifactReviewSurface } from '@/components/content-review/ArtifactReviewSurface';
import { TheaterReplayContent } from '@/components/story-player/TheaterReplayContent';
import type { WorkspaceSurfaceDescriptor } from '@/components/workbench/workbench-contract';
import { BrowserPanel } from '@/components/workspace/BrowserPanel';
import { TerminalTab } from '@/components/workspace/TerminalTab';
import type { WorkspaceFileNavigationOrigin } from '@/stores/chat-types';
import { CollectiveDocumentSurface } from '../collective/CollectiveDocumentSurface';
import { AgentRunOwnerSurface } from './AgentRunOwnerSurface';
import { ArtifactFileNavigator } from './ArtifactFileNavigator';
import { createArtifactReviewSurface, resolveArtifactReviewTarget } from './artifact-review-surface';
import { CanonicalWorkspaceFileSurface } from './CanonicalWorkspaceFileSurface';
import { ContentPublicationNavigator } from './ContentPublicationNavigator';
import { useResolveContentSurface } from './ContentSurfaceResolution';
import { resolveCollectiveDocumentTarget } from './collective-document-surface';
import { ContentEditorOwnerSurface } from './content-editor/ContentEditorOwnerSurface';
import { EvolutionContentReviewSurface } from './content-review/EvolutionContentReviewSurface';
import { PublicationContentReviewSurface } from './content-review/PublicationContentReviewSurface';
import { resolveEvolutionMediaTarget } from './evolution-media-surface';
import { F307ArtifactOwnerSurface } from './F307ArtifactOwnerSurface';
import { F307FileOwnerSurface } from './F307FileOwnerSurface';
import { F307OwnerUnavailable as OwnerUnavailable } from './F307OwnerUnavailable';
import { WorkspaceDestinationOwnerSurface } from './F307WorkspaceDestinationOwnerSurface';
import { MessagePublicationLandingResolver } from './MessagePublicationLandingResolver';
import { resolveMessagePublicationSource } from './message-publication-surface';
import { PublicationLandingResolver } from './PublicationLandingResolver';
import { createPublicationSurface, resolvePublicationTarget } from './publication-surface';
import {
  createBrowserSurface,
  resolveBrowserTarget,
  resolveContentEditorTarget,
  resolveEvolutionProgramId,
  resolveTerminalWorktreeId,
} from './real-surface-adapters';
import { resolveThreadReplayThreadId } from './thread-replay-surface';
import { VideoProjectReviewSurface } from './video-project/VideoProjectReviewSurface';
import { resolveVideoProjectTarget } from './video-project-surface';
import { WorkspacePreviewIntentProvider } from './WorkspacePreviewIntent';
import { WorkspaceSurfaceVisibilityProvider } from './WorkspaceSurfaceVisibility';

interface F307OwnerSurfaceRendererProps {
  surface: WorkspaceSurfaceDescriptor;
  surfaceVisible?: boolean;
  fullWindowAction?: { active: boolean; onToggle: () => void };
  hostWorktreeId?: string | null;
  hostThreadId?: string | null;
  focusMode?: boolean;
  statusSurface?: ReactNode;
  defaultCatId?: string;
  onOpenSurface: (surface: WorkspaceSurfaceDescriptor) => void;
  onOpenArtifactWithReturn: (input: {
    artifact: WorkspaceSurfaceDescriptor;
    returnSurface: WorkspaceSurfaceDescriptor;
  }) => void;
  onRefreshSurface: (surface: WorkspaceSurfaceDescriptor) => void;
  onRequestDetach: () => void;
  onReturnToFileOrigin?: (surface: WorkspaceSurfaceDescriptor, origin: WorkspaceFileNavigationOrigin) => void;
}

function F307OwnerSurfaceContent({
  surface,
  focusMode = false,
  statusSurface,
  defaultCatId,
  hostWorktreeId,
  hostThreadId,
  onOpenSurface,
  onOpenArtifactWithReturn,
  onRefreshSurface,
  onRequestDetach,
  onReturnToFileOrigin,
  leadingAction,
  fullWindowAction,
}: Omit<F307OwnerSurfaceRendererProps, 'surfaceVisible'> & { leadingAction?: ReactNode }) {
  const resolveSurface = useResolveContentSurface(surface.id);
  const browserTarget = resolveBrowserTarget(surface);
  const returnToOrigin = () =>
    surface.navigationOrigin && onReturnToFileOrigin
      ? onReturnToFileOrigin(surface, surface.navigationOrigin)
      : onRequestDetach();
  const handleBrowserNavigate = useCallback(
    (port: number, path: string) => {
      if (!browserTarget || (browserTarget.port === port && browserTarget.path === path)) return;
      onRefreshSurface(createBrowserSurface({ ownerKey: browserTarget.ownerKey, port, path }));
    },
    [browserTarget, onRefreshSurface],
  );

  if (surface.renderer === 'thread-replay') {
    const threadId = resolveThreadReplayThreadId(surface);
    return threadId ? (
      <div className="flex h-full min-h-0 min-w-0 flex-col" data-owner-thread-replay={threadId}>
        <TheaterReplayContent threadId={threadId} />
      </div>
    ) : (
      <OwnerUnavailable message="线程回放没有一致的对话引用。" />
    );
  }
  if (surface.renderer === 'video-project-review') {
    const target = resolveVideoProjectTarget(surface);
    return target ? (
      <VideoProjectReviewSurface target={target} onRefreshSurface={onRefreshSurface} />
    ) : (
      <OwnerUnavailable message="审片项目没有一致的成片引用。" />
    );
  }
  const collectiveDocument = resolveCollectiveDocumentTarget(surface);
  if (collectiveDocument) return <CollectiveDocumentSurface source={collectiveDocument} />;
  if (surface.renderer === 'file-preview' || surface.renderer === 'code-editor') {
    return (
      <CanonicalWorkspaceFileSurface
        surface={surface}
        onBack={() =>
          surface.navigationOrigin && onReturnToFileOrigin
            ? onReturnToFileOrigin(surface, surface.navigationOrigin)
            : onRequestDetach()
        }
      >
        <ArtifactFileNavigator surface={surface}>
          <F307FileOwnerSurface
            surface={surface}
            focusMode={focusMode}
            onRequestDetach={onRequestDetach}
            onReturnToNavigationOrigin={
              onReturnToFileOrigin ? (origin) => onReturnToFileOrigin(surface, origin) : undefined
            }
          />
        </ArtifactFileNavigator>
      </CanonicalWorkspaceFileSurface>
    );
  }
  if (surface.renderer === 'content-editor') {
    const contentEditorTarget = resolveContentEditorTarget(surface);
    return contentEditorTarget ? (
      <ContentEditorOwnerSurface target={contentEditorTarget} />
    ) : (
      <OwnerUnavailable message="Content editor descriptor 没有合法的 F309 content/session owner 引用。" />
    );
  }
  if (surface.renderer === 'browser-preview') {
    return browserTarget ? (
      <div
        className="flex min-h-0 min-w-0 w-full flex-1"
        data-owner-preview={browserTarget.ownerKey}
        data-owner-port={browserTarget.port}
        data-owner-path={browserTarget.path}
      >
        <BrowserPanel
          initialPort={browserTarget.port}
          initialPath={browserTarget.path}
          onNavigate={handleBrowserNavigate}
          previewOnly={focusMode}
        />
      </div>
    ) : (
      <OwnerUnavailable message="Browser descriptor 没有合法的 F120 owner/result target。" />
    );
  }
  if (surface.renderer === 'terminal-session') {
    const terminalWorktreeId = resolveTerminalWorktreeId(surface);
    return terminalWorktreeId ? (
      <TerminalTab worktreeId={terminalWorktreeId} />
    ) : (
      <OwnerUnavailable message="Terminal descriptor 没有合法 worktree owner。" />
    );
  }
  if (surface.renderer === 'review-summary' && surface.ownerStateRef.owner === 'f309-content-review') {
    const target = resolveArtifactReviewTarget(surface);
    return target ? (
      <ArtifactReviewSurface
        reviewId={target.reviewId}
        initialRound={target.round}
        leadingAction={leadingAction}
        titleInHost={false}
        title={surface.title}
        navigationOrigin={surface.navigationOrigin}
        fullWindowAction={fullWindowAction}
        onContextChange={(context) =>
          resolveSurface(createArtifactReviewSurface(context.reviewId, context.threadId, context.title, context.round))
        }
        onVersionChange={(round) =>
          onRefreshSurface({
            ...surface,
            ownerStateRef: createArtifactReviewSurface(target.reviewId, target.threadId, surface.title, round)
              .ownerStateRef,
          })
        }
        onBack={() =>
          surface.navigationOrigin && onReturnToFileOrigin
            ? onReturnToFileOrigin(surface, surface.navigationOrigin)
            : onRequestDetach()
        }
      />
    ) : (
      <OwnerUnavailable message="审阅引用已不可用。" />
    );
  }
  if (surface.renderer === 'artifact-view' || surface.renderer === 'review-summary') {
    if (surface.ownerStateRef.owner === 'f311-media') {
      const locator = resolveEvolutionMediaTarget(surface);
      return locator ? (
        <EvolutionContentReviewSurface
          key={surface.id}
          locator={locator}
          title={surface.title}
          navigationOrigin={surface.navigationOrigin}
          onBack={() =>
            surface.navigationOrigin && onReturnToFileOrigin
              ? onReturnToFileOrigin(surface, surface.navigationOrigin)
              : onRequestDetach()
          }
        />
      ) : (
        <OwnerUnavailable message="实验原件引用已不可用。" />
      );
    }
    if (surface.ownerStateRef.owner === 'f138-message-source') {
      const source = resolveMessagePublicationSource(surface);
      return source ? (
        <MessagePublicationLandingResolver
          key={surface.id}
          source={source}
          surface={surface}
          onBack={returnToOrigin}
          onResolved={(resolved) => resolveSurface(resolved)}
        />
      ) : (
        <OwnerUnavailable message="原发布消息坐标已不可用。" />
      );
    }
    if (surface.ownerStateRef.owner === 'f138-publication') {
      const target = resolvePublicationTarget(surface);
      return target ? (
        <PublicationLandingResolver
          sourceSurface={surface}
          target={target}
          leadingAction={leadingAction}
          onBack={returnToOrigin}
          onResolved={(resolved) => resolveSurface(resolved)}
        >
          <PublicationContentReviewSurface
            {...target}
            leadingAction={leadingAction}
            title={surface.title}
            fullWindowAction={fullWindowAction}
            navigationOrigin={surface.navigationOrigin}
            onVersionChange={(ownerRevision) =>
              onRefreshSurface({
                ...surface,
                ...createPublicationSurface({
                  ...target,
                  ownerRevision,
                  title: surface.title,
                  navigationOrigin: surface.navigationOrigin,
                }),
                ...(surface.returnTargetRef ? { returnTargetRef: surface.returnTargetRef } : {}),
              })
            }
            onBack={() =>
              surface.navigationOrigin && onReturnToFileOrigin
                ? onReturnToFileOrigin(surface, surface.navigationOrigin)
                : onRequestDetach()
            }
          />
        </PublicationLandingResolver>
      ) : (
        <OwnerUnavailable message="作品引用已不可用。" />
      );
    }
    return (
      <F307ArtifactOwnerSurface
        surface={surface}
        onRequestDetach={() =>
          surface.navigationOrigin && onReturnToFileOrigin
            ? onReturnToFileOrigin(surface, surface.navigationOrigin)
            : onRequestDetach()
        }
        onOpenSurface={onOpenSurface}
      />
    );
  }
  if (surface.renderer === 'agent-run') return <AgentRunOwnerSurface surface={surface} />;
  if (surface.renderer === 'evolution-program') {
    const programId = resolveEvolutionProgramId(surface);
    return programId ? (
      <EvolutionProgramSurface programId={programId} />
    ) : (
      <OwnerUnavailable message="Evolution Program descriptor 没有合法的 F311 owner 引用。" />
    );
  }
  if (surface.renderer === 'workspace-destination') {
    return (
      <WorkspaceDestinationOwnerSurface
        surface={surface}
        hostWorktreeId={hostWorktreeId}
        hostThreadId={hostThreadId}
        onOpenSurface={onOpenSurface}
        onOpenArtifactWithReturn={onOpenArtifactWithReturn}
        onRefreshSurface={onRefreshSurface}
        onReturnToNavigationOrigin={
          surface.navigationOrigin && onReturnToFileOrigin
            ? () => {
                if (surface.navigationOrigin) onReturnToFileOrigin(surface, surface.navigationOrigin);
              }
            : undefined
        }
        statusSurface={statusSurface}
        defaultCatId={defaultCatId}
      />
    );
  }
  return <OwnerUnavailable message="未知 renderer 已 fail closed。" />;
}

export function F307OwnerSurfaceRenderer({ surfaceVisible = true, ...props }: F307OwnerSurfaceRendererProps) {
  return (
    <WorkspaceSurfaceVisibilityProvider visible={surfaceVisible}>
      <WorkspacePreviewIntentProvider surfaceId={props.surface.id}>
        <ContentPublicationNavigator key={props.surface.id} surface={props.surface}>
          {(leadingAction) => <F307OwnerSurfaceContent {...props} leadingAction={leadingAction} />}
        </ContentPublicationNavigator>
      </WorkspacePreviewIntentProvider>
    </WorkspaceSurfaceVisibilityProvider>
  );
}
