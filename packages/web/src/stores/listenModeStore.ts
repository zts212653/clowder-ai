import type { ListenDocumentIdentity, ListenPlaybackRate, ListenRetention } from '@cat-cafe/shared';
import { create } from 'zustand';
import type { ListenSentence } from '@/lib/listen-mode/markdown-sentences';

export type ListenModePhase = 'loading' | 'buffering' | 'playing' | 'paused' | 'idle' | 'error';

export interface ListenDocumentDescriptor {
  identity: ListenDocumentIdentity;
  title: string;
  worktreeId: string | null;
  sentences: ListenSentence[];
}

export interface ListenModeSession extends ListenDocumentDescriptor {
  phase: ListenModePhase;
  currentIndex: number;
  currentTime: number;
  duration: number;
  playbackRate: ListenPlaybackRate;
  retention: ListenRetention;
  cachedAnchors: string[];
  cacheBytes: number;
  error: string | null;
}

interface ListenModeStore {
  session: ListenModeSession | null;
}

export const useListenModeStore = create<ListenModeStore>(() => ({ session: null }));

export function isListenDocumentActive(projectPath: string, relativePath: string): boolean {
  const session = useListenModeStore.getState().session;
  return session?.identity.projectPath === projectPath && session.identity.relativePath === relativePath;
}
