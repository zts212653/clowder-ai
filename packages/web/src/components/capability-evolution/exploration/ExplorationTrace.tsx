import type { EvolutionExplorationRecordV1 } from '@cat-cafe/shared';
import { ExplorationIcon } from './ExplorationIcon';

type Trace = NonNullable<EvolutionExplorationRecordV1['trace']>;
export function explorationTraceBounds(traces: Trace[]) {
  const points = traces.flatMap((trace) => [...trace.points, ...(trace.target ? [trace.target] : [])]);
  const minX = Math.min(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const extent = Math.max(
    0.2,
    Math.max(...points.map((point) => point.x)) - minX,
    Math.max(...points.map((point) => point.y)) - minY,
  );
  return { minX: minX - extent * 0.08, minY: minY - extent * 0.08, extent: extent * 1.16 };
}

export function ExplorationTrace({
  trace,
  bounds,
  sideLabel,
}: {
  trace: Trace;
  bounds?: ReturnType<typeof explorationTraceBounds>;
  sideLabel?: string;
}) {
  const range = bounds ?? explorationTraceBounds([trace]);
  const x = (value: number) => 42 + ((value - range.minX) / range.extent) * 300;
  const y = (value: number) => 320 - ((value - range.minY) / range.extent) * 300;
  const first = trace.points[0]!;
  const last = trace.points.at(-1)!;
  return (
    <figure className="exploration-trace">
      <figcaption>
        <ExplorationIcon kind="experiment" />
        <strong>
          {sideLabel ? `${sideLabel} · ` : ''}
          {trace.label}
        </strong>
        <span>真实数据派生</span>
      </figcaption>
      <svg
        viewBox="0 0 380 358"
        role="img"
        aria-label={`${trace.label}，${trace.xLabel}/${trace.yLabel}，单位 ${trace.unit}；${first.seconds} 至 ${last.seconds} 秒的实际轨迹`}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((fraction) => (
          <g key={fraction}>
            <line
              className="exploration-trace-grid"
              x1="42"
              x2="342"
              y1={320 - fraction * 300}
              y2={320 - fraction * 300}
            />
            <line
              className="exploration-trace-grid"
              y1="20"
              y2="320"
              x1={42 + fraction * 300}
              x2={42 + fraction * 300}
            />
            <text x={42 + fraction * 300} y="336" textAnchor="middle">
              {(range.minX + fraction * range.extent).toFixed(2)}
            </text>
            <text x="35" y={324 - fraction * 300} textAnchor="end">
              {(range.minY + fraction * range.extent).toFixed(2)}
            </text>
          </g>
        ))}
        <polyline
          className={sideLabel === '阅读' ? 'exploration-trace-b' : 'exploration-trace-a'}
          points={trace.points.map((point) => `${x(point.x)},${y(point.y)}`).join(' ')}
        />
        <circle cx={x(first.x)} cy={y(first.y)} r="4" className="exploration-trace-start" />
        <text x={x(first.x) + 8} y={y(first.y) - 7}>
          起点
        </text>
        <circle cx={x(last.x)} cy={y(last.y)} r="4" className="exploration-trace-end" />
        {trace.target && (
          <g>
            <circle cx={x(trace.target.x)} cy={y(trace.target.y)} r="5" className="exploration-trace-target" />
            <text x={x(trace.target.x) + 8} y={y(trace.target.y) - 7}>
              {trace.target.label}
            </text>
          </g>
        )}
        <text x="190" y="355" textAnchor="middle">
          {trace.xLabel} / {trace.unit}
        </text>
        <text x="42" y="12">
          {trace.yLabel} / {trace.unit}
        </text>
      </svg>
      <details>
        <summary>
          {first.seconds}–{last.seconds} s · 来源与抽样方式
        </summary>
        <p>{trace.definition}</p>
      </details>
    </figure>
  );
}
