'use client';

import type { Components } from 'react-markdown';
import { useChatStore } from '@/stores/chatStore';
import { API_URL } from '@/utils/api-client';
import { isRelativeMdLink, resolveRelativePath } from './MarkdownContent';

/** Highlight @mentions in text children */
type MentionFn = (children: import('react').ReactNode) => import('react').ReactNode;

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
export function createWorkspaceLinkComponent(basePath: string, withMentions: MentionFn): Components['a'] {
  return function WorkspaceLink({ href, children }) {
    const setOpenFile = useChatStore((s) => s.setWorkspaceOpenFile);

    if (isRelativeMdLink(href)) {
      const resolved = resolveRelativePath(basePath, href);
      return (
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setOpenFile(resolved);
          }}
          className="text-cocreator-primary hover:text-cocreator-dark hover:underline break-all cursor-pointer"
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
        className="text-cocreator-primary hover:text-cocreator-dark hover:underline break-all"
      >
        {withMentions(children)}
      </a>
    );
  };
}
