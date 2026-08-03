'use client';

import { type ReactNode, useCallback } from 'react';
import { type Components, defaultUrlTransform } from 'react-markdown';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { API_URL } from '@/utils/api-client';
import { fetchWorkspaceWorktrees, isPathWithinProject, workspaceWorktreesUrl } from '@/utils/workspace-worktrees';
import { isRelativeMdLink, resolveRelativePath } from './MarkdownContent';

/** Highlight @mentions in text children */
type MentionFn = (children: ReactNode) => ReactNode;

interface WindowsFileTarget {
  path: string;
  line: number | null;
}

interface WorktreeRoot {
  id: string;
  root: string;
}

function decodeHref(href: string): string | null {
  try {
    return decodeURIComponent(href);
  } catch {
    return null;
  }
}

export function parseWindowsAbsoluteFileHref(href: string | undefined): WindowsFileTarget | null {
  if (!href) return null;
  const decoded = decodeHref(href);
  if (!decoded) return null;

  let normalized = decoded.replaceAll('\\', '/');
  if (/^\/[a-zA-Z]:\//.test(normalized)) normalized = normalized.slice(1);
  if (!/^[a-zA-Z]:\//.test(normalized)) return null;

  const lineMatch = /:(\d+)$/.exec(normalized);
  const line = lineMatch ? Number.parseInt(lineMatch[1], 10) : null;
  const path = lineMatch ? normalized.slice(0, lineMatch.index) : normalized;
  return path.length > 3 ? { path, line } : null;
}

export function isWindowsAbsoluteFileHref(href: string | undefined): href is string {
  return parseWindowsAbsoluteFileHref(href) != null;
}

export function workspaceMarkdownUrlTransform(url: string, key: string): string {
  return key === 'href' && isWindowsAbsoluteFileHref(url) ? url : defaultUrlTransform(url);
}

export function resolveWindowsFileTarget(
  target: WindowsFileTarget,
  worktrees: WorktreeRoot[],
): { worktreeId: string; path: string; line: number | null } | null {
  const absolutePath = target.path.replaceAll('\\', '/');
  const comparablePath = absolutePath.toLowerCase();
  const candidates = worktrees
    .map((worktree) => ({ ...worktree, normalizedRoot: worktree.root.replaceAll('\\', '/').replace(/\/$/, '') }))
    .filter(({ normalizedRoot }) => comparablePath.startsWith(`${normalizedRoot.toLowerCase()}/`))
    .sort((a, b) => b.normalizedRoot.length - a.normalizedRoot.length);
  const match = candidates[0];
  if (!match) return null;

  return {
    worktreeId: match.id,
    path: absolutePath.slice(match.normalizedRoot.length + 1),
    line: target.line,
  };
}

async function resolveWindowsFileTargetFromWorkspace(
  target: WindowsFileTarget,
  projectPath: string,
): Promise<{ worktreeId: string; path: string; line: number | null } | null> {
  const { url, isScoped } = workspaceWorktreesUrl(projectPath === 'lobby' ? null : projectPath);
  const scopedWorktrees = (await fetchWorkspaceWorktrees<WorktreeRoot>(url)) ?? [];
  const resolved = resolveWindowsFileTarget(target, scopedWorktrees);
  if (resolved || !isScoped) return resolved;

  const defaultWorktrees = (await fetchWorkspaceWorktrees<WorktreeRoot>('/api/workspace/worktrees')) ?? [];
  return resolveWindowsFileTarget(
    target,
    defaultWorktrees.filter((worktree) => isPathWithinProject(worktree.root, projectPath)),
  );
}

export function WindowsAbsoluteWorkspaceLink({
  href,
  children,
  withMentions,
}: {
  href: string;
  children: ReactNode;
  withMentions: MentionFn;
}) {
  const setOpenFile = useChatStore((s) => s.setWorkspaceOpenFile);
  const setWorkspaceMode = useChatStore((s) => s.setWorkspaceMode);
  const projectPath = useChatStore((s) => s.currentProjectPath);
  const addToast = useToastStore((s) => s.addToast);
  const target = parseWindowsAbsoluteFileHref(href);

  const handleClick = useCallback(
    async (event: React.MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      if (!target) return;

      try {
        const resolved = await resolveWindowsFileTargetFromWorkspace(target, projectPath);
        if (!resolved) throw new Error('file is outside the available worktrees');

        setWorkspaceMode('dev');
        setOpenFile(resolved.path, resolved.line, resolved.worktreeId);
      } catch {
        addToast({
          type: 'error',
          title: '无法打开文件',
          message: '这个文件不在当前项目可用的工作区中。',
          duration: 5000,
        });
      }
    },
    [addToast, projectPath, setOpenFile, setWorkspaceMode, target],
  );

  if (!target) return null;

  return (
    <a
      href={href}
      onClick={(event) => void handleClick(event)}
      className="text-conn-blue-text hover:underline break-all cursor-pointer"
      title={`在工作区中打开 ${target.path}${target.line ? `:${target.line}` : ''}`}
    >
      {withMentions(children)}
    </a>
  );
}

export function createChatLinkComponent(withMentions: MentionFn): Components['a'] {
  return function ChatLink({ href, children }) {
    if (isWindowsAbsoluteFileHref(href)) {
      return (
        <WindowsAbsoluteWorkspaceLink href={href} withMentions={withMentions}>
          {children}
        </WindowsAbsoluteWorkspaceLink>
      );
    }

    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-conn-blue-text hover:underline break-all"
      >
        {withMentions(children)}
      </a>
    );
  };
}

/** Create an `img` override that resolves workspace-relative image paths */
export function createWorkspaceImageComponent(basePath: string, worktreeId: string): Components['img'] {
  return function WorkspaceImage({ src, alt }) {
    const isRelative =
      src &&
      !src.startsWith('http://') &&
      !src.startsWith('https://') &&
      !src.startsWith('data:') &&
      !src.startsWith('/') &&
      !src.startsWith('blob:');
    const resolvedUrl = isRelative
      ? `${API_URL}/api/workspace/file/raw?worktreeId=${encodeURIComponent(worktreeId)}&path=${encodeURIComponent(resolveRelativePath(basePath, src))}`
      : src;
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={resolvedUrl} alt={alt ?? ''} className="max-w-full rounded my-2" loading="lazy" />;
  };
}

/** Create an `a` override that intercepts relative .md links → workspace navigation */
export function createWorkspaceLinkComponent(
  basePath: string,
  withMentions: MentionFn,
  worktreeId?: string,
): Components['a'] {
  return function WorkspaceLink({ href, children }) {
    const setOpenFile = useChatStore((s) => s.setWorkspaceOpenFile);

    if (href && isWindowsAbsoluteFileHref(href)) {
      return (
        <WindowsAbsoluteWorkspaceLink href={href} withMentions={withMentions}>
          {children}
        </WindowsAbsoluteWorkspaceLink>
      );
    }

    if (isRelativeMdLink(href)) {
      const resolved = resolveRelativePath(basePath, href);
      return (
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            // F226 云端 P2: navigate within the given worktree (symmetric with the image resolver),
            // so a torn-off float's relative links stay correct even after the docked workspace
            // switches to another worktree.
            setOpenFile(resolved, null, worktreeId ?? null);
          }}
          className="text-cafe-accent hover:text-cafe-interactive hover:underline break-all cursor-pointer"
          title={`在工作区中打开 ${resolved}`}
        >
          {withMentions(children)}
        </a>
      );
    }

    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-cafe-accent hover:text-cafe-interactive hover:underline break-all"
      >
        {withMentions(children)}
      </a>
    );
  };
}
