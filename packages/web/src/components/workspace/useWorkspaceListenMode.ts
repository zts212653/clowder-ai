'use client';

import { useCallback, useMemo } from 'react';
import type { FileData } from '@/hooks/useWorkspace';
import { extractListenSentences } from '@/lib/listen-mode/markdown-sentences';
import { documentListenController } from '@/services/DocumentListenController';
import { useChatStore } from '@/stores/chatStore';
import { useListenModeStore } from '@/stores/listenModeStore';

interface WorkspaceListenModeInput {
  file: FileData;
  openFilePath: string | null;
  worktreeId: string | null;
  enabled: boolean;
}

export function useWorkspaceListenMode({ file, openFilePath, worktreeId, enabled }: WorkspaceListenModeInput) {
  const currentProjectPath = useChatStore((state) => state.currentProjectPath);
  const listenSession = useListenModeStore((state) => state.session);
  const sentences = useMemo(() => (enabled ? extractListenSentences(file.content) : []), [enabled, file.content]);
  const descriptor = useMemo(
    () =>
      openFilePath
        ? {
            identity: {
              projectPath: currentProjectPath,
              relativePath: openFilePath,
              contentDigest: file.sha256,
            },
            title: openFilePath.split('/').pop() ?? openFilePath,
            worktreeId,
            sentences,
          }
        : null,
    [currentProjectPath, file.sha256, openFilePath, sentences, worktreeId],
  );
  const active =
    listenSession?.identity.projectPath === currentProjectPath && listenSession.identity.relativePath === openFilePath;
  const start = useCallback(
    (index?: number) => {
      if (descriptor) void documentListenController.startDocument(descriptor, index);
    },
    [descriptor],
  );

  return {
    sentences,
    active,
    activeAnchor: active ? listenSession?.sentences[listenSession.currentIndex]?.anchor : undefined,
    start,
  };
}
