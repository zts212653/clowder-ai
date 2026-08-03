'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import {
  cancelActiveWorkspaceDocumentResolution,
  claimWorkspaceDocumentResolution,
  type WorkspaceDocumentResolutionClaim,
} from './workspace-document-resolution-claim';

export interface WorkspaceDocumentTarget {
  path: string;
  line: number | null;
}

const MARKDOWN_FILE_HREF_RE = /^(.*\.mdx?)(?::(\d+))?$/i;
const URI_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_ABSOLUTE_PATH_RE = /^[a-z]:\//i;

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

function isAbsoluteLocalMarkdownDocumentHref(href: string): boolean {
  const { pathname: withoutFragment, isWindowsUnc } = parseMarkdownHrefPathname(href);
  const candidate = withoutFragment.match(MARKDOWN_FILE_HREF_RE)?.[1] ?? '';
  return isWindowsUnc || candidate.startsWith('/') || WINDOWS_ABSOLUTE_PATH_RE.test(candidate);
}

async function resolveAbsoluteDocumentTarget(href: string): Promise<WorkspaceDocumentTarget & { worktreeId: string }> {
  const response = await apiFetch('/api/workspace/resolve-document-link', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ href }),
  });
  if (!response.ok) throw new Error('document resolution failed');
  const target = (await response.json()) as Partial<WorkspaceDocumentTarget> & {
    worktreeId?: unknown;
  };
  if (
    typeof target.worktreeId !== 'string' ||
    typeof target.path !== 'string' ||
    !(typeof target.line === 'number' || target.line === null)
  ) {
    throw new Error('invalid document target');
  }
  return { worktreeId: target.worktreeId, path: target.path, line: target.line };
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
  const setOpenFile = useChatStore((s) => s.setWorkspaceOpenFile);
  const setWorkspaceMode = useChatStore((s) => s.setWorkspaceMode);
  const workspaceTarget = resolveChatWorkspaceDocumentHref(href, projectRoot);
  const isLocalDocument = isLocalMarkdownDocumentHref(href);
  const requiresServerResolution = isLocalDocument && isAbsoluteLocalMarkdownDocumentHref(href);
  const [resolveState, setResolveState] = useState<'idle' | 'resolving' | 'error'>('idle');
  const resolutionClaimRef = useRef<WorkspaceDocumentResolutionClaim | null>(null);
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
    if (workspaceTarget && !requiresServerResolution) {
      setWorkspaceMode('dev');
      setOpenFile(workspaceTarget.path, workspaceTarget.line);
      return;
    }
    if (!href) return;
    const claim = claimWorkspaceDocumentResolution(useChatStore.getState().currentThreadId, () => {
      if (mountedRef.current) setResolveState('idle');
    });
    resolutionClaimRef.current = claim;
    setResolveState('resolving');
    try {
      const target = await resolveAbsoluteDocumentTarget(parseMarkdownHrefPathname(href).pathname);
      if (claim.cancelled) return;
      setWorkspaceMode('dev');
      setOpenFile(target.path, target.line, target.worktreeId);
      setResolveState('idle');
    } catch {
      if (claim.cancelled) return;
      setResolveState('error');
    } finally {
      if (claim.cancelled && mountedRef.current && resolutionClaimRef.current === claim) {
        setResolveState('idle');
      }
      claim.finish();
      if (resolutionClaimRef.current === claim) resolutionClaimRef.current = null;
    }
  };

  if (workspaceTarget || isLocalDocument) {
    const targetLabel = workspaceTarget?.path ?? href ?? '';
    return (
      <span>
        <button
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
            无法在工作区中打开
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
