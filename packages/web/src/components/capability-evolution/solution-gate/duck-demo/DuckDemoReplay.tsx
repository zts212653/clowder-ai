import { useState } from 'react';

/** A hand-authored diagram. It is explicitly not video or a physics-engine replay. */
export function DuckDemoReplay() {
  const [time, setTime] = useState(55);
  const [candidate, setCandidate] = useState(false);
  const ball = 140 + time * 1.9;
  const duck = candidate ? Math.min(ball - 22, 60 + time * 3) : Math.min(175, 60 + time * 3);
  return (
    <details className="duck-details duck-replay">
      <summary>看“球走了”的动作示意</summary>
      <p className="duck-small">手绘运动示意 · 非录屏、非物理仿真、不用于判分</p>
      <div className="duck-replay-controls">
        <button type="button" aria-pressed={!candidate} onClick={() => setCandidate(false)}>
          V1 · 接近后停下
        </button>
        <button type="button" aria-pressed={candidate} onClick={() => setCandidate(true)}>
          V2 · 持续修正
        </button>
      </div>
      <svg
        viewBox="0 0 420 120"
        role="img"
        aria-label={candidate ? '候选持续跟随滚动的球' : '鸭子停在旧位置，球继续滚走'}
      >
        <title>合成的移动球示意</title>
        <rect
          x="2"
          y="2"
          width="416"
          height="116"
          rx="12"
          fill="var(--cafe-surface-sunken)"
          stroke="var(--cafe-border)"
        />
        <path d="M20 94 H398 M140 60 H362" fill="none" stroke="var(--cafe-border-strong)" strokeDasharray="5 5" />
        <g transform={`translate(${duck} 65)`} fill="var(--evolution-focus)">
          <ellipse rx="17" ry="12" />
          <circle cx="9" cy="-15" r="10" />
          <path d="M17 -18 L28 -14 L17 -10 Z" />
          <path d="M-5 10 V18 H4 M8 9 V18 H18" stroke="var(--evolution-focus)" fill="none" strokeWidth="3" />
        </g>
        <circle cx={ball} cy="72" r="8" fill="var(--content-category-object)" />
        <text x="18" y="25" fill="var(--cafe-text-secondary)" fontSize="13">
          {candidate ? '跟着新位置修正；能否踢中还要测' : '鸭停了，球还在滚'}
        </text>
      </svg>
      <label>
        拖动看过程{' '}
        <input
          type="range"
          min="0"
          max="100"
          value={time}
          aria-label="动作示意进度"
          onChange={(e) => setTime(Number(e.target.value))}
        />
      </label>
    </details>
  );
}
