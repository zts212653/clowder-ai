import { useLayoutEffect, useState } from 'react';
import type { CollectiveParticipant } from '../client-types.js';
import { MemberAvatar } from '../MemberAvatar.js';

type Rect = { left: number; top: number; width: number; height: number };
type Arrival = { cat: CollectiveParticipant; startX: number; startY: number; dx: number; dy: number };

function targetForBeat(beat: number, arrivalComplete: boolean): Element | null {
  if (beat > 0) {
    const selector = beat === 1 ? '[data-guide-thread]' : beat === 2 ? '[data-guide-neighbor]' : '[data-guide-work]';
    return document.querySelector(selector);
  }
  if (window.innerWidth <= 820) return document.querySelector('.mobile-navigation');
  return document.querySelector(
    arrivalComplete ? '.member-destination button' : '.channel-destination[aria-current="page"]',
  );
}

export function DemoSpotlight({
  beat,
  selectedCats,
  arrivalComplete,
  onNext,
  onSkip,
}: {
  readonly beat: number;
  readonly selectedCats: readonly CollectiveParticipant[];
  readonly arrivalComplete: boolean;
  readonly onNext: () => void;
  readonly onSkip: () => void;
}) {
  const [spotlight, setSpotlight] = useState<Rect | null>(null);
  const [arrivals, setArrivals] = useState<Arrival[]>([]);
  useLayoutEffect(() => {
    const target = targetForBeat(beat, arrivalComplete);
    if (!target) return;
    if (beat > 0) {
      const flow = target.closest('.channel-flow');
      if (flow) flow.scrollTop = flow.scrollHeight;
    }
    const measure = () => {
      const bounds = target.getBoundingClientRect();
      setSpotlight({
        left: bounds.left - 10,
        top: bounds.top - 10,
        width: bounds.width + 20,
        height: bounds.height + 20,
      });
      if (beat !== 0 || arrivalComplete) return;
      const primary = document.querySelector('.primary-scene')?.getBoundingClientRect();
      if (!primary) return;
      setArrivals(
        selectedCats.slice(0, 5).map((cat, index) => {
          const startX = Math.min(window.innerWidth - 125, primary.right - 125);
          const startY =
            primary.top + primary.height / 2 + (index - (Math.min(selectedCats.length, 5) - 1) / 2) * 90 - 48;
          return {
            cat,
            startX,
            startY,
            dx: bounds.left + bounds.width / 2 - startX - 60,
            dy: bounds.top + bounds.height / 2 - startY - 48,
          };
        }),
      );
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(target);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [beat, selectedCats, arrivalComplete]);

  const titles = ['你的伙伴到了', '点名，它就在原处回你', '别家的猫也在这儿帮忙', '定下来的事变成工作卡'];
  const details = [
    '这里的成员都可以点名它们',
    '谁回的、回在哪，一眼看清',
    selectedCats.length === 1 ? '等别家 Café 加入，就能点名它们的猫' : '各回各家干活，在同一处碰头',
    '要你点头才算数',
  ];
  return (
    <>
      {spotlight && <div className="demo-spotlight" data-demo="spotlight" style={spotlight} aria-hidden="true" />}
      <button
        type="button"
        className="demo-tap-surface"
        data-demo="advance"
        aria-label="点击任意处进入下一步"
        onClick={onNext}
      />
      {beat === 0 && (
        <div className="demo-arrivals" data-demo="arrival" aria-hidden="true">
          {arrivals.map(({ cat, startX, startY, dx, dy }) => (
            <span
              key={`${cat.connectionId}:${cat.catId}`}
              className="demo-arrival"
              style={
                { left: startX, top: startY, '--arrival-x': `${dx}px`, '--arrival-y': `${dy}px` } as React.CSSProperties
              }
            >
              <MemberAvatar name={cat.displayName} kind="agent" avatarUrl={cat.avatarDataUrl} />
              <strong>{cat.displayName}</strong>
            </span>
          ))}
        </div>
      )}
      <section className="demo-caption" data-demo="caption" data-demo-beat={beat} aria-label="入场演示">
        <div className="demo-caption-copy">
          <h2>{titles[beat]}</h2>
          <p>{details[beat]}</p>
        </div>
        <div className="demo-caption-actions">
          <span role="img" aria-label={`第 ${beat + 1} / 4 步`}>
            {titles.map((title, index) => (
              <span key={title}>{index === beat ? '●' : '○'}</span>
            ))}
          </span>
          <button type="button" onClick={onSkip}>
            跳过
          </button>
          <button type="button" onClick={onNext}>
            {beat === 3 ? '我来试试' : '下一步'}
          </button>
        </div>
      </section>
    </>
  );
}
