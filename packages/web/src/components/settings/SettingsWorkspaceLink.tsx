'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { captureFileCardOrigin } from '../workbench/file-card-origin';
import { requestWorktrees } from '../workbench/files-tree';
import { useFileCardReturn } from '../workbench/useFileCardReturn';
import { SettingsHubLink } from './primitives';

/** The one worktree whose root is exactly `projectRoot`; anything else is a reason, not a guess. */
async function resolveExactWorktreeId(projectRoot: string, noun: string): Promise<string> {
  // The same reader the Files header uses: an unreadable listing is unavailable, never an empty one.
  const listed = await requestWorktrees(projectRoot).catch(() => {
    throw new Error('工作区目录暂不可用，请重试。');
  });
  const matches = listed.filter((item) => item.root === projectRoot);
  const [match] = matches;
  if (matches.length !== 1 || !match) throw new Error(`未能唯一定位此${noun}的工作区。`);
  return match.id;
}

const WORDING = {
  file: { request: 'file', noun: '文件', owner: '配置文件' },
  directory: { request: 'reveal', noun: '目录', owner: '目录' },
} as const;

type PageAtClick = { threadId: string; projectPath: string; href: string };

function capturePage(): PageAtClick {
  const state = useChatStore.getState();
  return { threadId: state.currentThreadId, projectPath: state.currentProjectPath, href: window.location.href };
}

/** The person moved on while the lookup ran: a late answer must not pull them somewhere else. */
function pageMoved(before: PageAtClick): boolean {
  const now = capturePage();
  return now.threadId !== before.threadId || now.projectPath !== before.projectPath || now.href !== before.href;
}

/** Stay in the clicked thread when it belongs to this project; otherwise open in the lobby thread. */
function enterTargetThread(threadId: string, projectRoot: string): string {
  const state = useChatStore.getState();
  const sameProject = state.threads.find((item) => item.id === threadId)?.projectPath === projectRoot;
  const target = sameProject && threadId !== 'default' ? threadId : 'default';
  if (target !== threadId) state.setCurrentThread(target);
  return target;
}

/**
 * "在 Hub 中查看" for a project path shown in Settings. A file opens in the Hub; a directory is shown in
 * its worktree's file tree. Either way the exact worktree is resolved first, and the page never changes
 * unless the Hub has recorded where to go.
 */
export function SettingsWorkspaceLink({
  relPath,
  projectRoot,
  kind,
}: {
  relPath: string;
  projectRoot: string;
  kind: 'file' | 'directory';
}) {
  const router = useRouter();
  const anchorId = `${kind === 'file' ? 'settings-file' : 'settings-dir'}:${relPath}`;
  const ref = useFileCardReturn<HTMLSpanElement>(anchorId);
  const mounted = useRef(false),
    pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const wording = WORDING[kind];
  const open = async () => {
    if (pending.current) return;
    pending.current = true;
    setOpening(true);
    setError(null);
    const before = capturePage();
    const origin = captureFileCardOrigin(ref.current, anchorId, before.threadId, 'status');
    try {
      const worktreeId = await resolveExactWorktreeId(projectRoot, wording.owner);
      if (!mounted.current || pageMoved(before)) return;
      const targetThreadId = enterTargetThread(before.threadId, projectRoot);
      // The destination page restores its own project and mounts a fresh Workbench, so the exact
      // target travels as a consume-once open request instead of a project switch plus file stamp.
      // The id was minted by listing `projectRoot`; the tree reads its identity through that same coordinate.
      const recorded = useChatStore
        .getState()
        .openWorkspacePath(
          targetThreadId,
          wording.request === 'reveal'
            ? { kind: 'reveal', worktreeId, path: relPath, navigationOrigin: origin, repoRoot: projectRoot }
            : { kind: 'file', worktreeId, path: relPath, navigationOrigin: origin },
        );
      if (!recorded) throw new Error(`未能切换到此${wording.noun}所在的对话，请重试。`);
      router.push(targetThreadId === 'default' ? '/' : `/thread/${encodeURIComponent(targetThreadId)}`);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : '暂时无法在 Hub 中打开。');
    } finally {
      pending.current = false;
      if (mounted.current) setOpening(false);
    }
  };
  return (
    <span ref={ref} tabIndex={-1}>
      <SettingsHubLink
        onClick={(e) => {
          e.preventDefault();
          void open();
        }}
        title={kind === 'file' ? `在 Hub 工作区中查看\n${relPath}` : `在 Hub 工作区的文件树中找到:\n${relPath}`}
      >
        {opening ? '正在打开…' : '在 Hub 中查看'}
      </SettingsHubLink>
      {error && (
        <span role="alert" className="ml-2 text-xs text-conn-red-text">
          {error}
        </span>
      )}
    </span>
  );
}
