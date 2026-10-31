'use client';

import { useEffect, useState } from 'react';
import { ChatContainer } from '@/components/ChatContainer';
import { useF307ExperienceWorkbenchStore } from '@/components/workbench/experience-workbench-store';
import { createWorkspaceDestinationSurface } from '@/components/workbench/real-surface-adapters';
import { DEFAULT_THREAD_STATE, type Thread, type ThreadState, useChatStore } from '@/stores/chatStore';
import {
  bindPostRunPreviewChild,
  finishPostRunPreview,
  preparePostRunPreview,
  startPostRunPreview,
} from './post-run-preview';

const THREAD_ID = 'f322-status-isolated-preview';

/** Development-only host. Session data still enters through the ordinary API read. */
export function StatusPreview() {
  const [ready, setReady] = useState(false);
  const [postRun, setPostRun] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const startedAt = useChatStore((state) => state.catInvocations['codex61-sol']?.startedAt);
  useEffect(() => {
    let cancelled = false;
    const now = Date.now();
    const panelMode = new URLSearchParams(window.location.search).get('panel') === 'status' ? 'status' : 'workspace';
    const cats = ['opus55', 'codex61-sol', 'gemini'];
    const thread: Thread = {
      id: THREAD_ID,
      title: '状态与会话 · 隔离作者预览',
      projectPath: '/isolated/preview',
      createdBy: 'preview',
      participants: cats,
      lastActiveAt: now,
      createdAt: now,
      bubbleCli: 'collapsed',
      bubbleThinking: 'collapsed',
    };
    const state: ThreadState = {
      ...DEFAULT_THREAD_STATE,
      messages: [
        {
          id: 'preview-message',
          type: 'assistant' as const,
          catId: 'codex61-sol',
          content: '状态与会话保留每段事实和完整 ID；未知用量如实显示。',
          timestamp: now - 60000,
        },
      ],
      hasMore: false,
      targetCats: cats,
      intentMode: 'execute' as const,
      catStatuses: { opus55: 'streaming' as const, 'codex61-sol': 'done' as const, gemini: 'done' as const },
      catInvocations: {
        opus55: {
          invocationId: 'preview-opus-run',
          startedAt: now - 252000,
          contextHealth: {
            usedTokens: 62000,
            windowTokens: 100000,
            fillRatio: 0.62,
            source: 'exact' as const,
            measuredAt: now,
          },
        },
        'codex61-sol': { invocationId: 'preview-sol-run', startedAt: now - 300000, durationMs: 120000 },
        gemini: {
          invocationId: 'preview-gemini-run',
          contextHealth: {
            usedTokens: 95000,
            windowTokens: 100000,
            fillRatio: 0.95,
            source: 'exact' as const,
            measuredAt: now,
          },
        },
      },
      activeInvocations: { 'preview-opus-run': { catId: 'opus55', mode: 'execute', startedAt: now - 252000 } },
      hasActiveInvocation: true,
      rightPanelOpen: true,
      rightPanelMode: panelMode,
    };
    const surface = createWorkspaceDestinationSurface(
      { kind: 'host', id: 'status', label: '状态与会话', description: '', searchTerms: '' },
      THREAD_ID,
    );
    const install = (snapshot: ThreadState) => {
      if (cancelled) return;
      useChatStore.setState({
        ...snapshot,
        currentThreadId: THREAD_ID,
        threads: [thread],
        threadStates: { [THREAD_ID]: snapshot },
        isLoadingThreads: false,
      });
      if (surface && panelMode === 'workspace')
        useF307ExperienceWorkbenchStore.getState().dispatch({
          type: 'open-surface',
          surface,
          entitlement: { kind: 'user', reason: 'workspace-home-selection' },
        });
      setReady(true);
    };
    const isPostRun = new URLSearchParams(window.location.search).get('scenario') === 'post-run';
    setPostRun(isPostRun);
    if (isPostRun) {
      void preparePostRunPreview(state, THREAD_ID)
        .then(install)
        .catch(() => {
          if (!cancelled) setPreviewError('Failed to read isolated preview messages');
        });
    } else install(state);
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <main
      data-testid="f322-status-real-host"
      data-ready={ready}
      data-post-run-started-at={postRun ? startedAt : undefined}
      style={{ height: '100vh' }}
    >
      {previewError && <p role="alert">{previewError}</p>}
      {ready && postRun && (
        <button
          type="button"
          data-testid="bind-preview-child"
          style={{ position: 'fixed', left: 450, top: 0, zIndex: 200 }}
          onClick={() => {
            void bindPostRunPreviewChild(THREAD_ID).catch(() => setPreviewError('Failed to bind isolated child'));
          }}
        >
          Bind isolated child
        </button>
      )}
      {ready && postRun && (
        <button
          type="button"
          data-testid="start-preview-run"
          style={{ position: 'fixed', left: 240, top: 0, zIndex: 200 }}
          onClick={() => startPostRunPreview(THREAD_ID)}
        >
          Start isolated preview run
        </button>
      )}
      {ready && postRun && (
        <button
          type="button"
          data-testid="finish-preview-run"
          style={{ position: 'fixed', left: 0, top: 0, zIndex: 200 }}
          onClick={() => {
            void finishPostRunPreview(THREAD_ID).catch(() => setPreviewError('Failed to finish isolated preview run'));
          }}
        >
          Finish isolated preview run
        </button>
      )}
      {ready && <ChatContainer threadId={THREAD_ID} />}
    </main>
  );
}
