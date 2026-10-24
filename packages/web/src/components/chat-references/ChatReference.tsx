'use client';
import {
  type ChatGitHubReference,
  type ChatReferenceTarget,
  parseChatGitHubUrl,
  parseLegacyChatPathReference,
} from '@cat-cafe/shared';
import { type ReactNode, useCallback, useContext, useRef, useState, useSyncExternalStore } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { API_URL } from '@/utils/api-client';
import { hasPendingWorkspaceFileLink } from '@/utils/pending-workspace-file-link';
import { AppTooltip } from '../AppTooltip';
import { useChatArtworkLightbox } from '../content-review/useChatArtworkLightbox';
import { useShellCopy } from '../shell/shell-copy';
import { createCommitChangesSurface } from '../workbench/commit-changes-surface';
import { useF307ExperienceWorkbenchStore } from '../workbench/experience-workbench-store';
import { createPullRequestChangesSurface } from '../workbench/pull-request-changes-surface';
import type { WorkspaceSurfaceDescriptor } from '../workbench/workbench-contract';
import { readF284WorkspaceSnapshot } from '../workbench/workspace-legacy-snapshot';
import { rememberWorkspaceForeground } from '../workbench/workspace-presentation-lock';
import { ChatFileReferenceView } from './ChatFileReferenceView';
import { ChatGitHubReferenceView } from './ChatGitHubReferenceView';
import { ChatReferenceCardScope } from './ChatReferenceGroup';
import { ChatMissingFileIcon } from './ChatReferenceIcon';
import styles from './chat-reference.module.css';
import { chatReferenceCopy } from './chat-reference.shell-copy';
import { chatReferenceBatch } from './chat-reference-batch';
import { ChatReferenceDemand } from './useChatReferenceDemand';

function externalUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}
function openChangesSurface(surface: WorkspaceSurfaceDescriptor, threadId: string) {
  const workbench = useF307ExperienceWorkbenchStore.getState();
  // An explicit entry can precede the host mount: restore its topology before persisting the new tab.
  const chat = useChatStore.getState();
  if (!workbench.hydrated)
    workbench.hydrate(readF284WorkspaceSnapshot(chat, hasPendingWorkspaceFileLink(chat), threadId));
  useChatStore.getState().setWorkspaceMode('dev');
  workbench.dispatch({
    type: 'open-surface',
    surface,
    entitlement: { kind: 'user', reason: 'open-from-chat' },
    visitThreadId: threadId,
  });
  // Explicit entries also leave Home when the requested tab was already active.
  rememberWorkspaceForeground();
}
export function ChatReference({
  reference,
  format = 'text',
  layout: requestedLayout = 'inline',
  children,
  threadId,
}: {
  reference: string;
  format?: string;
  layout?: string;
  children: ReactNode;
  threadId: string;
}) {
  const verifiedGroup = useContext(ChatReferenceCardScope);
  const visible = useContext(ChatReferenceDemand);
  const layout = verifiedGroup ? requestedLayout : 'inline';
  const external = externalUrl(reference),
    github = parseChatGitHubUrl(reference);
  const needsRead = !external || external.hostname === 'github.com';
  const subscribe = useCallback(
    (listener: () => void) =>
      needsRead && threadId && visible ? chatReferenceBatch.subscribe(threadId, reference, listener) : () => {},
    [needsRead, threadId, reference, visible],
  );
  const snapshot = useCallback(
    () => (needsRead && threadId ? chatReferenceBatch.read(threadId, reference) : undefined),
    [needsRead, threadId, reference],
  );
  const target = useSyncExternalStore(subscribe, snapshot, () => undefined);
  const t = useShellCopy(chatReferenceCopy);
  const artwork = useChatArtworkLightbox();
  const ref = useRef<HTMLSpanElement>(null);
  const [error, setError] = useState('');
  function origin() {
    const messageId = ref.current?.closest<HTMLElement>('[data-message-id]')?.dataset.messageId;
    return messageId ? { kind: 'chat-file-link' as const, threadId, messageId } : undefined;
  }
  function open(value: ChatReferenceTarget) {
    const state = useChatStore.getState();
    if (state.currentThreadId !== threadId) {
      setError(t.changedThread);
      return;
    }
    setError('');
    if (value.kind === 'file') {
      if (value.entryType === 'directory')
        state.openWorkspacePath(threadId, {
          kind: 'reveal',
          worktreeId: value.worktreeId,
          path: value.path,
          navigationOrigin: origin(),
        });
      else if (value.mime.startsWith('image/'))
        void artwork.enlarge({
          url: `${API_URL}/api/workspace/file/raw?${new URLSearchParams({ worktreeId: value.worktreeId, path: value.path })}`,
          title: value.path.split('/').at(-1) ?? value.path,
          alt: value.path,
          mediaType: 'image',
          entry: { kind: 'workspace', worktreeId: value.worktreeId, path: value.path, messageId: origin()?.messageId },
        });
      else state.setWorkspaceOpenFile(value.path, value.line, value.worktreeId, threadId, origin(), 'permanent');
    } else if (value.kind === 'github' && value.objectType === 'pull' && value.worktreeId) {
      const surface = createPullRequestChangesSurface({
        artifact: { type: 'pr', ref: `${value.repo}#${value.number}`, name: value.title ?? `#${value.number}` },
        worktreeId: value.worktreeId,
        threadId,
        navigationOrigin: origin(),
      });
      if (surface) openChangesSurface(surface, threadId);
    } else if (value.kind === 'commit') {
      openChangesSurface(
        createCommitChangesSurface({ sha: value.sha, worktreeId: value.worktreeId, threadId }, origin()),
        threadId,
      );
    }
  }
  if (target?.kind === 'missing') {
    const filename =
      parseLegacyChatPathReference(reference)
        .reference.split('/')
        .filter(Boolean)
        .at(-1)
        ?.replace(/:[1-9]\d*(?::[1-9]\d*)?$/, '') ?? reference;
    return (
      <AppTooltip
        label={t.missing}
        detail={parseLegacyChatPathReference(reference).reference}
        intent="content"
        multiline
        showOnClick
      >
        <button
          type="button"
          aria-label={`${filename} · ${t.missing}`}
          data-chat-reference-kind="missing"
          className={`shell-focusable ${styles.reference} ${styles.chip} ${styles.missing}`}
        >
          <ChatMissingFileIcon />
          <span className={styles.filename}>{filename}</span>
        </button>
      </AppTooltip>
    );
  }
  if (target?.kind === 'file')
    return (
      <ChatFileReferenceView
        target={target}
        layout={layout}
        anchor={ref}
        onOpen={() => open(target)}
        error={error}
        lightbox={artwork.lightbox}
      />
    );
  if (target?.kind === 'github' || github) {
    const object: ChatGitHubReference = target?.kind === 'github' ? target : { kind: 'github', ...github! };
    return <ChatGitHubReferenceView target={object} layout={layout} anchor={ref} onOpen={() => open(object)} />;
  }
  if (target?.kind === 'commit')
    return (
      <AppTooltip label={`${target.sha} · ${target.title}`} intent="content" multiline>
        <span ref={ref} data-chat-reference-kind="commit" className={`${styles.reference} ${styles.chip}`}>
          <button
            type="button"
            aria-label={`${target.sha} · ${target.title}`}
            className={`shell-focusable ${styles.open} ${styles.commit}`}
            onClick={() => open(target)}
          >
            <span className={styles.icon}>
              <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                <circle cx="8" cy="8" r="2.6" />
                <path d="M1 8h4.4M10.6 8H15" />
              </svg>
            </span>
            <span className={styles.mono}>{reference}</span>
          </button>
          {error ? <span role="alert">{error}</span> : null}
        </span>
      </AppTooltip>
    );
  if (external)
    return (
      <AppTooltip label={external.href} intent="content" multiline>
        <a
          aria-label={`${external.hostname} · ${external.href}`}
          data-chat-reference-kind="website"
          href={external.href}
          target="_blank"
          rel="noopener noreferrer"
          className={`${styles.reference} ${styles.chip}`}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            className={styles.icon}
          >
            <circle cx="12" cy="12" r="9" />
            <ellipse cx="12" cy="12" rx="4" ry="9" />
            <path d="M3 12h18" />
          </svg>
          <span className={styles.filename}>{external.hostname}</span>
        </a>
      </AppTooltip>
    );
  return format === 'code' ? (
    <code className="rounded bg-[var(--code-bg)] px-1 py-0.5 font-mono text-[0.85em] text-[var(--code-text)]">
      {children}
    </code>
  ) : (
    <>{children}</>
  );
}
