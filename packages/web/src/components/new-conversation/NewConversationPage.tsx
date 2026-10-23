'use client';

import type { GlobalArtifactDTO } from '@cat-cafe/shared';
import Image from 'next/image';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { useChatStore } from '@/stores/chatStore';
import { useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import { scrollToMessage } from '@/utils/scrollToMessage';
import { kickTeleportResolve, planTeleport } from '@/utils/teleport';
import { AppTooltip } from '../AppTooltip';
import { ChatInput } from '../ChatInput';
import { buildCatOptions } from '../chat-input-options';
import { useArtworkLightboxScope } from '../content-review/ArtworkLightboxScope';
import { useArtifactLightbox } from '../content-review/useArtifactLightbox';
import { DemoEntryActions } from '../onboarding-demo/DemoEntryActions';
import { ShellGlyph } from '../shell/ShellIcons';
import { useShellCopy } from '../shell/shell-copy';
import { getProjectPaths } from '../ThreadSidebar/thread-utils';
import { ThreadComposerHost } from '../thread-chat/ThreadComposerHost';
import { NewConversationComposerContext } from './NewConversationComposerContext';
import { newConversationCopy } from './new-conversation.shell-copy';
import { queueWorkDiscussion } from './queue-work-discussion';
import { RecentWorks } from './RecentWorks';
import { SessionImportPanel } from './SessionImportPanel';
import { useNewConversationAdmission } from './useNewConversationAdmission';

export type LandingArtwork = 'dusk' | 'night';

export function landingArtworkForHour(hour: number): LandingArtwork {
  return hour >= 22 || hour < 6 ? 'night' : 'dusk';
}

function LandingHeader({
  sidebarOpen,
  statusPanelOpen,
  hasWorkspaceActivity,
  onToggleSidebar,
  onToggleStatusPanel,
}: {
  sidebarOpen: boolean;
  statusPanelOpen: boolean;
  hasWorkspaceActivity: boolean;
  onToggleSidebar: () => void;
  onToggleStatusPanel: () => void;
}) {
  const copy = useShellCopy(newConversationCopy);
  return (
    <header className="safe-area-top absolute inset-x-0 top-0 z-20">
      <div className="flex h-[52px] items-center gap-2 px-3 text-white sm:px-6">
        {!sidebarOpen && (
          <AppTooltip label={copy.expandSidebar} side="bottom">
            <button
              type="button"
              onClick={onToggleSidebar}
              aria-label={copy.expandSidebar}
              className="shell-focusable flex h-8 w-8 items-center justify-center rounded-lg text-white/85 hover:bg-black/15 hover:text-white"
            >
              <ShellGlyph name="panelLeft" />
            </button>
          </AppTooltip>
        )}
        <span className="text-sm font-medium text-white/90">{copy.pageTitle}</span>
        <span className="flex-1" />
        <AppTooltip label={statusPanelOpen ? copy.closeWorkspace : copy.openWorkspace} side="bottom">
          <button
            type="button"
            onClick={onToggleStatusPanel}
            aria-label={statusPanelOpen ? copy.closeWorkspace : copy.openWorkspace}
            className={`shell-focusable relative flex h-8 w-8 items-center justify-center rounded-full text-white/85 hover:bg-black/15 hover:text-white ${
              statusPanelOpen ? 'bg-black/15 text-white' : ''
            }`}
            data-testid="new-conversation-workspace-toggle"
          >
            <ShellGlyph name="panelRight" />
            {hasWorkspaceActivity && (
              <span className="absolute right-1 top-1 h-2 w-2 rounded-full border-2 border-white/70 bg-[var(--semantic-success)]" />
            )}
          </button>
        </AppTooltip>
      </div>
    </header>
  );
}

function admissionMessage(
  phase: ReturnType<typeof useNewConversationAdmission>['phase'],
  localSaveFailed: boolean,
  copy: typeof newConversationCopy.zh,
): string | null {
  if (localSaveFailed) return copy.saveFailed;
  switch (phase) {
    case 'creating':
      return copy.creating;
    case 'sending':
      return copy.sending;
    case 'draft_recovered':
      return copy.draftRecovered;
    case 'draft_recovery_blocked':
      return copy.draftRecoveryBlocked;
    case 'create_failed':
      return copy.createFailed;
    case 'create_rejected':
      return copy.createRejected;
    case 'import_failed':
      return copy.importFailed;
    case 'send_failed':
      return copy.sendFailed;
    default:
      return null;
  }
}

function AdmissionNotice({
  phase,
  loadFailed,
  localSaveFailed,
  onRetry,
}: Pick<ReturnType<typeof useNewConversationAdmission>, 'phase' | 'loadFailed' | 'localSaveFailed'> & {
  onRetry: () => void;
}) {
  const copy = useShellCopy(newConversationCopy);
  const message = admissionMessage(phase, localSaveFailed, copy);
  if (loadFailed) {
    return (
      <div
        className="mt-3 flex flex-wrap items-center justify-center gap-2 rounded-xl border border-conn-red-ring bg-[var(--shell-paper)] px-4 py-3 text-sm text-conn-red-text"
        role="alert"
      >
        <span>{copy.identityFailed}</span>
        <button type="button" className="shell-focusable rounded-lg px-2 py-1 font-medium" onClick={onRetry}>
          {copy.retryPage}
        </button>
      </div>
    );
  }
  return message ? (
    <p
      className={`mt-3 rounded-xl border px-4 py-2.5 text-center text-sm ${
        phase === 'draft_recovered' ||
        phase === 'draft_recovery_blocked' ||
        phase === 'create_failed' ||
        phase === 'create_rejected' ||
        phase === 'send_failed' ||
        localSaveFailed
          ? 'border-conn-amber-ring bg-conn-amber-bg text-conn-amber-text'
          : 'border-[var(--shell-hairline)] bg-[var(--shell-paper)] text-[var(--shell-muted)]'
      }`}
      role={
        phase === 'draft_recovered' ||
        phase === 'draft_recovery_blocked' ||
        phase === 'create_failed' ||
        phase === 'create_rejected' ||
        phase === 'send_failed' ||
        localSaveFailed
          ? 'alert'
          : 'status'
      }
    >
      {message}
    </p>
  ) : null;
}

export interface NewConversationPageProps {
  sidebarOpen: boolean;
  statusPanelOpen: boolean;
  hasWorkspaceActivity: boolean;
  onToggleSidebar: () => void;
  onToggleStatusPanel: () => void;
  onNavigate: (threadId: string) => void;
  onShowCollaboration?: () => void;
}

export function NewConversationPage(props: NewConversationPageProps) {
  const copy = useShellCopy(newConversationCopy);
  const { cats } = useCatData();
  const [discussionNotice, setDiscussionNotice] = useState<string | null>(null);
  const floating = useArtifactLightbox('default');
  const floatingScope = useArtworkLightboxScope();
  const admission = useNewConversationAdmission(props.onNavigate);
  const sidebarRows = useSidebarProjectionStore((state) => state.rows);
  const existingProjects = useMemo(() => getProjectPaths(sidebarRows), [sidebarRows]);
  const [artwork, setArtwork] = useState<LandingArtwork>('dusk');
  const openPublishedArtifact = useChatStore((state) => state.openPublishedArtifact);
  const setWorkspaceMode = useChatStore((state) => state.setWorkspaceMode);
  useEffect(() => setArtwork(landingArtworkForHour(new Date().getHours())), []);

  const openWork = useCallback(
    (artifact: GlobalArtifactDTO) => {
      if (!floating.open(artifact, undefined)) openPublishedArtifact('default', artifact);
    },
    [openPublishedArtifact, floating.open],
  );
  const discussWork = (artifact: GlobalArtifactDTO) => {
    const messageId = artifact.sourceMessageId;
    if (!messageId) {
      setDiscussionNotice(copy.discussionFailed);
      return;
    }
    const cat = buildCatOptions(cats).find((item) => item.id === artifact.catId && !item.isGroup);
    if (
      !cat ||
      !queueWorkDiscussion(artifact, cat.insert, { title: copy.worksFailed, message: copy.discussionDraftFailed })
    ) {
      setDiscussionNotice(copy.discussionFailed);
      return;
    }
    setDiscussionNotice(null);
    const plan = planTeleport({
      threadId: artifact.threadId,
      messageId,
      currentThreadId: useChatStore.getState().currentThreadId,
    });
    // Restore the target first: closing the landing panel would leave its saved Works pane covering Chat.
    useChatStore.getState().setCurrentThread(artifact.threadId);
    useChatStore.getState().closeRightPanel();
    if (plan.navigateTo) props.onNavigate(plan.navigateTo);
    else if (plan.scrollNow) {
      scrollToMessage(plan.scrollNow);
      kickTeleportResolve();
    }
  };
  const busy = admission.phase === 'creating' || admission.phase === 'sending';
  const titleBreak = copy.heroTitle.indexOf('，');

  return (
    <main
      className="relative min-h-0 flex-1 overflow-y-auto bg-[var(--shell-work)]"
      data-testid="new-conversation-page"
      data-artwork={artwork}
    >
      <div className="relative h-[clamp(360px,52vh,500px)] min-h-[360px] overflow-hidden">
        <Image
          src={`/shell/cafe-landing-${artwork}.png`}
          alt={copy.artworkAlt}
          fill
          priority
          sizes="(max-width: 768px) 100vw, 80vw"
          className="object-cover object-center"
          draggable={false}
        />
        <div className="absolute inset-x-0 top-0 h-44 bg-gradient-to-b from-black/40 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-b from-transparent to-[var(--shell-work)]" />
        <LandingHeader {...props} />
        <div className="absolute inset-x-4 top-[88px] z-10 text-center text-white sm:top-[92px]">
          <h1
            className="text-3xl font-normal tracking-wide drop-shadow-[0_2px_14px_rgba(20,12,40,0.45)] sm:text-4xl"
            style={{ fontFamily: 'var(--evolution-title-font)' }}
          >
            {titleBreak >= 0 ? (
              <>
                <span data-testid="new-conversation-title-lead" className="max-sm:block">
                  {copy.heroTitle.slice(0, titleBreak + 1)}
                </span>
                <span data-testid="new-conversation-title-rest">{copy.heroTitle.slice(titleBreak + 1)}</span>
              </>
            ) : (
              copy.heroTitle
            )}
          </h1>
          <p className="mt-3 text-sm text-white/85 drop-shadow-[0_1px_8px_rgba(20,12,40,0.45)] sm:text-reading">
            {copy.heroSubtitle}
          </p>
        </div>
      </div>

      <div className="relative z-10 mx-auto -mt-10 w-full max-w-[752px] px-4 pb-16 sm:px-4">
        {admission.ready && admission.intent ? (
          <ThreadComposerHost threadId="default">
            <div ref={floatingScope?.setToolsSlot} data-artwork-tools-slot />
            <ChatInput
              key="new-conversation-default-draft"
              presentation="v2"
              threadId="default"
              disabled={busy}
              uploadStatus={admission.uploadStatus}
              uploadError={admission.uploadError}
              placeholder={copy.composerPlaceholder}
              composerHeader={
                <label className="block">
                  <span className="sr-only">{copy.conversationNameOptional}</span>
                  <input
                    type="text"
                    value={admission.intent.title ?? ''}
                    maxLength={200}
                    disabled={admission.optionsLocked}
                    data-testid="new-conversation-title"
                    aria-label={copy.conversationNameOptional}
                    placeholder={copy.conversationNameOptional}
                    className="block h-8 w-full border-0 bg-transparent px-1 text-sm text-[var(--shell-ink)] outline-none placeholder:text-[var(--shell-muted)] disabled:cursor-not-allowed disabled:opacity-60 max-sm:pr-14"
                    onChange={(event) => admission.updateTitle(event.target.value)}
                  />
                </label>
              }
              onDraftChange={admission.onDraftChange}
              prospectiveThread={{
                preferredCats: admission.intent.preferredCats,
                optionsLocked: admission.optionsLocked,
                onPreferredCatsChange: admission.updatePreferredCats,
              }}
              composerContext={
                <NewConversationComposerContext
                  projectPath={admission.intent.projectPath}
                  existingProjects={existingProjects}
                  locked={admission.optionsLocked}
                  pinned={admission.intent.pinned ?? false}
                  onProjectChange={admission.updateProject}
                  onPinnedChange={admission.updatePinned}
                />
              }
              onSend={(content, images, whisper, replyToId, contextAttachments, explicitTargetCats) =>
                admission.send({
                  content,
                  images,
                  whisper,
                  replyToId,
                  explicitTargetCats,
                  contextAttachments,
                })
              }
            />
          </ThreadComposerHost>
        ) : (
          <div
            className="mx-4 h-[112px] animate-pulse rounded-2xl border border-[var(--shell-hairline-strong)] bg-[var(--shell-paper)] shadow-sm"
            aria-busy={!admission.loadFailed}
          />
        )}
        <SessionImportPanel admission={admission} onNavigate={props.onNavigate} />
        <AdmissionNotice
          phase={admission.phase}
          loadFailed={admission.loadFailed}
          localSaveFailed={admission.localSaveFailed}
          onRetry={admission.retryLoad}
        />
        {props.onShowCollaboration && <DemoEntryActions onShowCollaboration={props.onShowCollaboration} />}
        {floating.error && <p role="alert">{floating.error}</p>}
        <div className="mt-8">
          <RecentWorks
            ownerUserId={admission.ownerUserId}
            onOpen={openWork}
            onOpenAll={() => setWorkspaceMode('artifacts')}
            onDiscuss={discussWork}
          />
          {discussionNotice && <p role="alert">{discussionNotice}</p>}
        </div>
      </div>
    </main>
  );
}
