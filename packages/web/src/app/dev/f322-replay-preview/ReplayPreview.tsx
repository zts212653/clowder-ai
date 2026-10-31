'use client';

import { useEffect, useState } from 'react';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { TheaterReplayContent } from '@/components/story-player/TheaterReplayContent';
import { useThemeStore } from '@/stores/themeStore';

/** Development-only content preview. The actual owner reads isolated HTTP fixtures; no playback is mocked. */
export function ReplayPreview() {
  const [ready, setReady] = useState(false);
  const [width, setWidth] = useState(420);
  const [thread, setThread] = useState('fixture-replay');
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    writeShellPresentation(params.get('shell') === 'classic' ? 'classic' : 'v2');
    setThread(
      params.get('scenario') === 'empty'
        ? 'fixture-empty'
        : params.get('scenario') === 'denied'
          ? 'fixture-denied'
          : 'fixture-replay',
    );
    setReady(true);
  }, []);
  return (
    <main
      style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--cafe-surface-elevated)' }}
    >
      <header style={{ padding: 12, display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 'var(--console-font-xs)' }}>
        <span>隔离内容预览 · 原播放引擎 / HTTP 夹具 · 非 Alpha 验收</span>
        {[200, 225, 420, 960].map((value) => (
          <button type="button" key={value} onClick={() => setWidth(value)}>
            {value}px
          </button>
        ))}
        <button type="button" onClick={() => useThemeStore.getState().setActive('light')}>
          浅色
        </button>
        <button type="button" onClick={() => useThemeStore.getState().setActive('dark')}>
          暗色
        </button>
      </header>
      <div
        data-testid="replay-preview-frame"
        style={{ width, maxWidth: '100%', flex: 1, minHeight: 0, margin: '0 auto' }}
      >
        {ready && <TheaterReplayContent threadId={thread} />}
      </div>
    </main>
  );
}
