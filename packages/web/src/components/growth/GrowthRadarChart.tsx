'use client';

import type { DimensionStat, GrowthDimension } from '@cat-cafe/shared';

const DIMENSION_LABELS: Record<GrowthDimension, string> = {
  architecture: '架构力',
  review: '审查力',
  aesthetics: '审美力',
  execution: '执行力',
  collaboration: '协作力',
  insight: '洞察力',
};

const DIMENSIONS: GrowthDimension[] = ['architecture', 'review', 'aesthetics', 'execution', 'collaboration', 'insight'];

interface Props {
  stats: Record<GrowthDimension, DimensionStat>;
  size?: number;
  color?: string;
}

/** Pure SVG traits portrait (特质画像) radar chart — no external dependency. */
export function GrowthRadarChart({ stats, size = 200, color = '#9B7EBD' }: Props) {
  const cx = size / 2;
  const cy = size / 2;
  const radius = size * 0.38;
  const angleStep = (2 * Math.PI) / DIMENSIONS.length;
  const labelOffset = radius + 22;

  // Max level for normalization (capped at 10 for visual balance)
  const maxLevel = 10;

  /** Convert (dimension index, value 0–1) to SVG coordinates. */
  function point(i: number, ratio: number): [number, number] {
    const angle = angleStep * i - Math.PI / 2;
    return [cx + radius * ratio * Math.cos(angle), cy + radius * ratio * Math.sin(angle)];
  }

  // Grid rings at 25%, 50%, 75%, 100%
  const rings = [0.25, 0.5, 0.75, 1];

  // Data polygon
  const dataPoints = DIMENSIONS.map((d, i) => {
    const level = stats[d]?.level ?? 0;
    return point(i, Math.min(level / maxLevel, 1));
  });
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="select-none">
      {/* Grid rings */}
      {rings.map((r) => (
        <polygon
          key={r}
          points={DIMENSIONS.map((_, i) => point(i, r).join(',')).join(' ')}
          fill="none"
          stroke="#e5e0d8"
          strokeWidth={r === 1 ? 1.5 : 0.8}
        />
      ))}

      {/* Axis lines */}
      {DIMENSIONS.map((_, i) => {
        const [ex, ey] = point(i, 1);
        return <line key={i} x1={cx} y1={cy} x2={ex} y2={ey} stroke="#e5e0d8" strokeWidth={0.8} />;
      })}

      {/* Data fill + border */}
      <polygon
        points={dataPoints.map((p) => p.join(',')).join(' ')}
        fill={`${color}25`}
        stroke={color}
        strokeWidth={2}
      />

      {/* Data dots */}
      {dataPoints.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={3.5} fill={color} />
      ))}

      {/* Labels */}
      {DIMENSIONS.map((d, i) => {
        const angle = angleStep * i - Math.PI / 2;
        const lx = cx + labelOffset * Math.cos(angle);
        const ly = cy + labelOffset * Math.sin(angle);
        const level = stats[d]?.level ?? 0;
        return (
          <text
            key={d}
            x={lx}
            y={ly}
            textAnchor="middle"
            dominantBaseline="central"
            className="fill-[#6b5e50] text-[10px] font-medium"
          >
            {DIMENSION_LABELS[d]} Lv.{level}
          </text>
        );
      })}
    </svg>
  );
}
