'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { WorkspaceFileNavigationOrigin } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { pushThreadRouteWithHistory } from './ThreadSidebar/thread-navigation';
import {
  cancelActiveWorkspaceDocumentResolution,
  claimWorkspaceDocumentResolution,
  type WorkspaceDocumentResolutionClaim,
} from './workspace-document-resolution-claim';

export interface WorkspaceDocumentTarget {
  path: string;
  line: number | null;
}

export interface WorkspacePathLinkTarget extends WorkspaceDocumentTarget {
  worktreeId: string;
  kind: 'file' | 'directory';
}

const MARKDOWN_FILE_HREF_RE = /^(.*\.mdx?)(?::(\d+))?$/i;
const URI_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_ABSOLUTE_PATH_RE = /^[a-z]:\//i;
const THREAD_HREF_RE = /^\/thread\/([^/?#]+)$/;

type WorkspaceLinkResolveState = 'idle' | 'resolving' | 'error';
type WorkspacePathOpenActions = Pick<
  ReturnType<typeof useChatStore.getState>,
  'setWorkspaceOpenFile' | 'setWorkspaceMode' | 'openWorkspacePath'
>;

export function resolveChatThreadHref(href: string | undefined): string | null {
  const encodedId = href?.match(THREAD_HREF_RE)?.[1];
  if (!encodedId) return null;
  try {
    const threadId = decodeURIComponent(encodedId);
    return /^thread_[a-zA-Z0-9_-]+$/.test(threadId) ? threadId : null;
  } catch {
    return null;
  }
}

function normalizeHrefPath(path: string): string {
  return path.replace(/\\/g, '/');
}

function decodeHrefPath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function parseMarkdownHrefPathname(href: string): { pathname: string; isWindowsUnc: boolean } {
  const decodedPathname = decodeHrefPath(href.split('#')[0] ?? '');
  return {
    pathname: normalizeHrefPath(decodedPathname),
    isWindowsUnc: decodedPathname.startsWith('\\\\'),
  };
}

function isLocalMarkdownDocumentHref(href: string | undefined): href is string {
  if (!href) return false;
  const { pathname: withoutFragment, isWindowsUnc } = parseMarkdownHrefPathname(href);
  const match = withoutFragment.match(MARKDOWN_FILE_HREF_RE);
  if (!match) return false;
  const candidate = match[1];
  const isWindowsAbsolute = WINDOWS_ABSOLUTE_PATH_RE.test(candidate);
  return (!URI_SCHEME_RE.test(candidate) && !candidate.startsWith('//')) || isWindowsAbsolute || isWindowsUnc;
}

function isAbsoluteLocalWorkspacePathHref(href: string | undefined): href is string {
  if (!href) return false;
  const { pathname, isWindowsUnc } = parseMarkdownHrefPathname(href);
  if (isWindowsUnc) return true;
  if (pathname.startsWith('//')) return false;
  return pathname.startsWith('/') || WINDOWS_ABSOLUTE_PATH_RE.test(pathname);
}

async function resolveAbsoluteWorkspaceTarget(href: string): Promise<WorkspacePathLinkTarget> {
  const response = await apiFetch('/api/workspace/resolve-document-link', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ href }),
  });
  if (!response.ok) {
    throw await workspacePathResolutionError(response);
  }
  const target: unknown = await response.json();
  if (!isWorkspacePathLinkTarget(target)) throw new Error('invalid Workspace path target');
  return target;
}

async function workspacePathResolutionError(response: Response): Promise<Error> {
  const errorBody = (await response.json().catch(() => null)) as { code?: unknown } | null;
  if (errorBody?.code === 'PATH_NOT_IN_REGISTERED_WORKSPACE') {
    return new Error('该路径不在已登记的工作区中，无法在 Workspace 中打开。');
  }
  if (errorBody?.code === 'PATH_NOT_FOUND') return new Error('该路径在已登记的工作区中不存在。');
  if (errorBody?.code === 'PATH_ACCESS_DENIED') return new Error('该路径无法安全地在 Workspace 中打开。');
  return new Error('无法在 Workspace 中打开此路径。');
}

function isWorkspacePathLinkTarget(value: unknown): value is WorkspacePathLinkTarget {
  if (typeof value !== 'object' || value === null) return false;
  const target = value as Record<string, unknown>;
  return (
    typeof target.worktreeId === 'string' &&
    typeof target.path === 'string' &&
    (typeof target.line === 'number' || target.line === null) &&
    (target.kind === 'file' || target.kind === 'directory')
  );
}

function resolveChatFileNavigationOrigin(
  threadId: string,
  link: HTMLButtonElement | null,
): WorkspaceFileNavigationOrigin | undefined {
  const messageId = link?.closest<HTMLElement>('[data-message-id]')?.dataset.messageId;
  return messageId ? { kind: 'chat-file-link', threadId, messageId } : undefined;
}

function openResolvedWorkspaceTarget(
  target: WorkspacePathLinkTarget,
  threadId: string,
  navigationOrigin: WorkspaceFileNavigationOrigin | undefined,
  actions: WorkspacePathOpenActions,
): void {
  if (target.kind === 'directory') {
    const opened = actions.openWorkspacePath(threadId, {
      kind: 'reveal',
      worktreeId: target.worktreeId,
      path: target.path,
      ...(navigationOrigin ? { navigationOrigin } : {}),
    });
    if (!opened) throw new Error('无法在当前会话的 Workspace 中打开此目录。');
    return;
  }
  actions.setWorkspaceMode('dev');
  actions.setWorkspaceOpenFile(target.path, target.line, target.worktreeId, threadId, navigationOrigin, 'permanent');
}

function finishWorkspacePathResolution(
  claim: WorkspaceDocumentResolutionClaim,
  claimRef: { current: WorkspaceDocumentResolutionClaim | null },
  mountedRef: { current: boolean },
  setResolveState: (state: WorkspaceLinkResolveState) => void,
): void {
  if (claim.cancelled && mountedRef.current && claimRef.current === claim) setResolveState('idle');
  claim.finish();
  if (claimRef.current === claim) claimRef.current = null;
}

async function resolveAndOpenWorkspacePath(
  href: string,
  claim: WorkspaceDocumentResolutionClaim,
  openTarget: (target: WorkspacePathLinkTarget) => void,
  setResolveState: (state: WorkspaceLinkResolveState) => void,
  setResolveError: (message: string) => void,
  finish: () => void,
): Promise<void> {
  try {
    const target = await resolveAbsoluteWorkspaceTarget(parseMarkdownHrefPathname(href).pathname);
    if (claim.cancelled) return;
    openTarget(target);
    setResolveState('idle');
  } catch (error) {
    if (claim.cancelled) return;
    setResolveError(error instanceof Error ? error.message : '无法在 Workspace 中打开此路径。');
    setResolveState('error');
  } finally {
    finish();
  }
}

/** Resolve only Markdown files that are safely inside the active project. */
export function resolveChatWorkspaceDocumentHref(
  href: string | undefined,
  projectRoot: string,
): WorkspaceDocumentTarget | null {
  if (!href || !projectRoot || projectRoot === 'default' || projectRoot === 'lobby') return null;

  const { pathname: withoutFragment } = parseMarkdownHrefPathname(href);
  const match = withoutFragment.match(MARKDOWN_FILE_HREF_RE);
  if (!match) return null;

  const candidate = match[1];
  const isWindowsAbsolute = WINDOWS_ABSOLUTE_PATH_RE.test(candidate);
  if (URI_SCHEME_RE.test(candidate) && !isWindowsAbsolute) return null;

  const normalizedRoot = normalizeHrefPath(projectRoot).replace(/\/+$/, '');
  const isAbsolute = candidate.startsWith('/') || isWindowsAbsolute;
  let relativePath = candidate.replace(/^\.\//, '');

  if (isAbsolute) {
    const rootPrefix = `${normalizedRoot}/`;
    if (!candidate.startsWith(rootPrefix)) return null;
    relativePath = candidate.slice(rootPrefix.length);
  }

  const segments = relativePath.split('/');
  if (!relativePath || segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;

  return {
    path: relativePath,
    line: match[2] ? Number.parseInt(match[2], 10) : null,
  };
}

export function ChatWorkspaceLink({ href, children }: { href?: string; children: ReactNode }) {
  const projectRoot = useChatStore((s) => s.currentProjectPath);
  const currentThreadId = useChatStore((s) => s.currentThreadId);
  const setOpenFile = useChatStore((s) => s.setWorkspaceOpenFile);
  const setWorkspaceMode = useChatStore((s) => s.setWorkspaceMode);
  const openWorkspacePath = useChatStore((s) => s.openWorkspacePath);
  const workspaceTarget = resolveChatWorkspaceDocumentHref(href, projectRoot);
  const isLocalDocument = isLocalMarkdownDocumentHref(href);
  const requiresServerResolution = isAbsoluteLocalWorkspacePathHref(href);
  const threadTarget = resolveChatThreadHref(href);
  const [resolveState, setResolveState] = useState<WorkspaceLinkResolveState>('idle');
  const [resolveError, setResolveError] = useState<string | null>(null);
  const resolutionClaimRef = useRef<WorkspaceDocumentResolutionClaim | null>(null);
  const linkRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      resolutionClaimRef.current?.cancel();
    };
  }, []);

  const handleWorkspaceClick = async () => {
    cancelActiveWorkspaceDocumentResolution();
    setResolveState('idle');
    setResolveError(null);
    const originThreadId = currentThreadId;
    const navigationOrigin = resolveChatFileNavigationOrigin(originThreadId, linkRef.current);
    if (workspaceTarget && !requiresServerResolution) {
      setWorkspaceMode('dev');
      setOpenFile(workspaceTarget.path, workspaceTarget.line, undefined, originThreadId, navigationOrigin, 'permanent');
      return;
    }
    if (!href) return;
    const claim = claimWorkspaceDocumentResolution(originThreadId, () => {
      if (mountedRef.current) setResolveState('idle');
    });
    resolutionClaimRef.current = claim;
    setResolveState('resolving');
    await resolveAndOpenWorkspacePath(
      href,
      claim,
      (target) =>
        openResolvedWorkspaceTarget(target, originThreadId, navigationOrigin, {
          openWorkspacePath,
          setWorkspaceMode,
          setWorkspaceOpenFile: setOpenFile,
        }),
      setResolveState,
      setResolveError,
      () => finishWorkspacePathResolution(claim, resolutionClaimRef, mountedRef, setResolveState),
    );
  };

  if (threadTarget) {
    return (
      <a
        href={href}
        onClick={(event) => {
          event.preventDefault();
          pushThreadRouteWithHistory(threadTarget, typeof window !== 'undefined' ? window : undefined);
        }}
        className="text-conn-blue-text hover:underline break-all"
        title={`打开 Thread ${threadTarget}`}
      >
        {children}
      </a>
    );
  }

  if (isLocalDocument || requiresServerResolution) {
    const targetLabel = workspaceTarget?.path ?? href ?? '';
    return (
      <span>
        <button
          ref={linkRef}
          type="button"
          disabled={resolveState === 'resolving'}
          onClick={async (event) => {
            event.preventDefault();
            await handleWorkspaceClick();
          }}
          className="text-conn-blue-text hover:underline break-all cursor-pointer text-left disabled:opacity-60"
          title={`在工作区中打开 ${targetLabel}`}
        >
          {children}
        </button>
        {resolveState === 'error' && (
          <span role="alert" className="ml-1 text-xs text-conn-red-text">
            {resolveError ?? '无法在 Workspace 中打开此路径。'}
          </span>
        )}
      </span>
    );
  }

  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-conn-blue-text hover:underline break-all">
      {children}
    </a>
  );
}
