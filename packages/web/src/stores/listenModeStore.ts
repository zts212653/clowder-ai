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

export interface ListenDocumentCacheProjection {
  identity: ListenDocumentIdentity;
  synthesisFingerprint?: string;
  cachedAnchors: string[];
  cacheBytes: number;
  totalSentences: number;
  active: boolean;
  error: string | null;
}

interface ListenModeStore {
  session: ListenModeSession | null;
  cacheByDocument: Record<string, ListenDocumentCacheProjection>;
}

export const useListenModeStore = create<ListenModeStore>(() => ({ session: null, cacheByDocument: {} }));

export function listenDocumentCacheKey(identity: ListenDocumentIdentity): string {
  return JSON.stringify([identity.projectPath, identity.relativePath, identity.contentDigest]);
}

export function isListenDocumentActive(projectPath: string, relativePath: string): boolean {
  const session = useListenModeStore.getState().session;
  return session?.identity.projectPath === projectPath && session.identity.relativePath === relativePath;
}
