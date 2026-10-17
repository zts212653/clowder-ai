'use client';

import { useEffect, useRef, useState } from 'react';
import { DEMO_TEAM, type DemoEvent } from './demo-story';

function TaskText({ text, active, playing }: { text: string; active: boolean; playing: boolean }) {
  const [length, setLength] = useState(() => (playing ? 0 : text.length));
  useEffect(() => {
    if (!active || !playing) return;
    const timer = setInterval(() => setLength((current) => Math.min(text.length, current + 3)), 35);
    return () => clearInterval(timer);
  }, [active, playing, text]);
  return <>{active ? text.slice(0, length) : text}</>;
}

export function DemoTranscript({
  events,
  playing,
  phase = 'complete',
  characters,
}: {
  events: readonly DemoEvent[];
  playing: boolean;
  phase?: 'thinking' | 'typing' | 'complete';
  characters?: number;
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [events.length]);
  return (
    <div
      ref={list}
      data-testid="demo-transcript"
      className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-5 sm:px-6"
    >
      {events.length === 0 && (
        <div className="mx-auto max-w-md py-6 text-center">
          <div className="text-3xl" aria-hidden="true">
            ☕
          </div>
          <h3 className="mt-3 text-lg font-semibold">一个目标，三位伙伴一起完成</h3>
          <p className="mt-3 text-sm leading-6 text-cafe-secondary">
            做一个能用的待办页。看看猫猫如何分工、传球、互审和交付，全程约 40 秒，随时可以暂停。
          </p>
        </div>
      )}
      {events.map((event, index) => {
        const cat = event.speaker !== 'user' && event.speaker !== 'system' ? DEMO_TEAM[event.speaker] : null;
        const currentPhase = index === events.length - 1 && cat ? phase : 'complete';
        if (event.speaker === 'system')
          return (
            <p
              key={event.id}
              className="rounded-xl bg-[var(--console-panel-bg)] px-4 py-3 text-xs leading-5 text-cafe-secondary"
            >
              {event.text}
            </p>
          );
        return (
          <article
            key={event.id}
            className={event.speaker === 'user' ? 'ml-5 rounded-2xl bg-[var(--console-active-bg)] p-4' : ''}
          >
            <div className="mb-2 flex items-center gap-2">
              {cat && <img src={cat.avatar} alt="" className="h-7 w-7 rounded-full" />}
              <span className="text-sm font-semibold">{cat?.name ?? '你的小目标'}</span>
              <span className="text-xs text-cafe-secondary">{event.title}</span>
            </div>
            <p className="whitespace-pre-wrap text-sm leading-6" data-demo-phase={cat ? currentPhase : undefined}>
              {event.speaker === 'user' ? (
                <TaskText text={event.text} active={index === events.length - 1} playing={playing} />
              ) : currentPhase === 'thinking' ? (
                <span role="status" className="text-cafe-secondary">
                  正在思考
                  <span aria-hidden="true" className="motion-safe:animate-pulse">
                    …
                  </span>
                </span>
              ) : currentPhase === 'typing' ? (
                <>
                  {event.text.slice(0, characters)}
                  <span aria-hidden="true" className="text-cafe-accent">
                    ▍
                  </span>
                  <span className="sr-only">正在输入</span>
                </>
              ) : (
                event.text
              )}
            </p>
            {event.to && currentPhase === 'complete' && (
              <div
                data-demo-handoff={event.to}
                className="mt-3 inline-flex rounded-full bg-[var(--console-xray-bg)] px-3 py-1 text-xs text-[var(--console-xray-text)]"
              >
                ↗ {cat?.name} 传球给 {DEMO_TEAM[event.to].name}
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
