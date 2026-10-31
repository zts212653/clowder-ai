'use client';

import { useEffect, useRef } from 'react';
import type { UseThreadReplayResult } from '@/lib/story-player/useThreadReplay';
import { ReplayControlsV2 } from './ReplayControlsV2';
import { ReplayMessageV2 } from './ReplayMessageV2';
import './thread-replay-v2.css';

/** The host mounts one TheaterReplayContent; dimensions are CSS-only, so resize cannot recreate its engine. */
export function ThreadReplayViewV2({ replay }: { replay: UseThreadReplayResult }) {
  const bottom = useRef<HTMLDivElement>(null);
  const { engine, messages, isLoading, error } = replay;
  const contentSignature = messages
    .map(
      (message) =>
        `${message.id}:${message.content.length}:${message.thinking?.length ?? 0}:${message.toolEvents?.length ?? 0}:${message.cliStdout?.length ?? 0}`,
    )
    .join('|');
  useEffect(() => {
    if (engine.state === 'playing') bottom.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [contentSignature, engine.state]);
  return (
    <section data-testid="thread-replay-v2" className="thread-replay-v2" data-playback-state={engine.state}>
      <div className="replay-v2-mode" role="group" aria-label="回放显示方式">
        <button
          type="button"
          aria-pressed={engine.displayMode === 'cinematic'}
          onClick={() => {
            if (engine.displayMode !== 'cinematic') replay.doToggleDisplayMode();
          }}
        >
          电影效果
        </button>
        <button
          type="button"
          aria-pressed={engine.displayMode === 'faithful'}
          onClick={() => {
            if (engine.displayMode !== 'faithful') replay.doToggleDisplayMode();
          }}
        >
          保真
        </button>
      </div>
      <div className="replay-v2-messages">
        {isLoading ? (
          <p className="replay-v2-empty" role="status">
            正在读取回放…
          </p>
        ) : error ? (
          <div className="replay-v2-empty" role="alert">
            <p>回放暂不可用</p>
            <p>{error}</p>
            <p>关闭回放后重新打开</p>
          </div>
        ) : engine.totalEvents === 0 ? (
          <p className="replay-v2-empty">暂无可回放的记录</p>
        ) : (
          <div className="replay-v2-message-column">
            {messages.map((message, index) => (
              <ReplayMessageV2
                key={message.id}
                message={message}
                mode={engine.displayMode}
                current={index === messages.length - 1}
              />
            ))}
            <div ref={bottom} />
          </div>
        )}
      </div>
      {!isLoading && !error && <ReplayControlsV2 replay={replay} />}
    </section>
  );
}
