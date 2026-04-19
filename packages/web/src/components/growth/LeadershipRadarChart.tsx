'use client';

import type { LeadershipDimension, LeadershipStat } from '@cat-cafe/shared';
import { LEADERSHIP_LIVE_DIMS, LEADERSHIP_SHADOW_DIMS } from '@cat-cafe/shared';

const ALL_DIMS: LeadershipDimension[] = [...LEADERSHIP_LIVE_DIMS, ...LEADERSHIP_SHADOW_DIMS];

const DIM_LABELS: Record<LeadershipDimension, string> = {
  coordination: '协调力',
  delegation: '授权力',
  exploration: '开拓力',
  guidance: '引导力',
  decision: '决策力',
  feedback: '反馈力',
};

const shadowSet = new Set<string>(LEADERSHIP_SHADOW_DIMS);

interface Props {
  stats: Record<LeadershipDimension, LeadershipStat>;
  size?: number;
  color?: string;
}

/** Pure SVG leadership radar (六维领导力画像) — shadow dims rendered with dashed stroke. */
export function LeadershipRadarChart({ stats, size = 200, color = '#D4A574' }: Props) {
  const cx = size / 2;
  const cy = size / 2;
  const radius = size * 0.38;
  const angleStep = (2 * Math.PI) / ALL_DIMS.length;
  const labelOffset = radius + 22;
  const maxLevel = 10;

  function point(i: number, ratio: number): [number, number] {
    const angle = angleStep * i - Math.PI / 2;
    return [cx + radius * ratio * Math.cos(angle), cy + radius * ratio * Math.sin(angle)];
  }

  const rings = [0.25, 0.5, 0.75, 1];

  const dataPoints = ALL_DIMS.map((d, i) => {
    const level = stats[d]?.level ?? 0;
    return point(i, Math.min(level / maxLevel, 1));
  });

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="select-none">
      {rings.map((r) => (
        <polygon
          key={r}
          points={ALL_DIMS.map((_, i) => point(i, r).join(',')).join(' ')}
          fill="none"
          stroke="#e5e0d8"
          strokeWidth={r === 1 ? 1.5 : 0.8}
        />
      ))}

      {ALL_DIMS.map((d, i) => {
        const [ex, ey] = point(i, 1);
        return (
          <line
            key={d}
            x1={cx}
            y1={cy}
            x2={ex}
            y2={ey}
            stroke="#e5e0d8"
            strokeWidth={0.8}
            strokeDasharray={shadowSet.has(d) ? '3,3' : undefined}
          />
        );
      })}

      <polygon
        points={dataPoints.map((p) => p.join(',')).join(' ')}
        fill={`${color}25`}
        stroke={color}
        strokeWidth={2}
      />

      {dataPoints.map(([x, y], i) => (
        <circle key={ALL_DIMS[i]} cx={x} cy={y} r={3.5} fill={color} opacity={shadowSet.has(ALL_DIMS[i]!) ? 0.4 : 1} />
      ))}

      {ALL_DIMS.map((d, i) => {
        const angle = angleStep * i - Math.PI / 2;
        const lx = cx + labelOffset * Math.cos(angle);
        const ly = cy + labelOffset * Math.sin(angle);
        const level = stats[d]?.level ?? 0;
        const isShadow = shadowSet.has(d);
        return (
          <text
            key={d}
            x={lx}
            y={ly}
            textAnchor="middle"
            dominantBaseline="central"
            className={`text-[10px] font-medium ${isShadow ? 'fill-[#b0a898]' : 'fill-[#6b5e50]'}`}
          >
            {DIM_LABELS[d]} Lv.{level}
          </text>
        );
      })}
    </svg>
  );
}
