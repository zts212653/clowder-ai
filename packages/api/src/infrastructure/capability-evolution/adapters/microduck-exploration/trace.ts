import type { EvolutionExplorationRecordV1 } from '@cat-cafe/shared';
import { archiveRef } from './archive-reader.js';
import type { FootballCapture } from './archive-schema.js';

/** Fixed stride preserves the original time/order and endpoints; never fits or smooths the motion. */
export function projectFootballTrace(
  capture: FootballCapture,
  captureSha256: string,
): NonNullable<EvolutionExplorationRecordV1['trace']> {
  const stride = Math.max(1, Math.ceil(capture.samples.length / 240));
  const points = capture.samples
    .filter((_, index) => index % stride === 0 || index === capture.samples.length - 1)
    .map((sample) => ({ x: sample.robotPositionM[0], y: sample.robotPositionM[1], seconds: sample.seconds }));
  const first = capture.samples[0];
  return {
    sourceRef: archiveRef('capture', captureSha256),
    label: '实际躯干 XY 轨迹',
    definition: `从完整 capture 每 ${stride} 个真实状态点保留一点，并保留起终点；未平滑、未改时间，不是几何规划路径。完整记录用于上方数值计算。`,
    xLabel: '世界 X',
    yLabel: '世界 Y',
    unit: 'm',
    points,
    ...(first ? { target: { x: first.ballPositionM[0], y: first.ballPositionM[1], label: '球的初始位置' } } : {}),
  };
}
