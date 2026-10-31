interface SwitchVisual {
  readonly assetVersionRef?: string;
  readonly startTick: number;
  readonly endTick: number;
}

interface SwitchSegment {
  readonly durationTicks: number;
  readonly switchMode?: 'even' | 'explicit';
  readonly visuals: readonly SwitchVisual[];
}

/** Inputs already passed tick/count validation. BigInt avoids index × tick overflow. */
export function evenAssetSwitchStarts(durationTicks: number, count: number): number[] {
  const duration = BigInt(durationTicks);
  const divisor = BigInt(count);
  return Array.from({ length: count }, (_, index) => Number((BigInt(index) * duration + divisor - 1n) / divisor));
}

export interface VideoProjectSwitchIssue {
  readonly visualIndex: number;
  readonly field: 'startTick' | 'endTick';
  readonly message: string;
}

/** Asset cuts form one sequence; generated layers have their own independent intervals. */
export function assetSwitchSequenceIssues(segment: SwitchSegment): VideoProjectSwitchIssue[] {
  // Zod runs refinements for numeric values already marked invalid by int/safe checks.
  if (segment.switchMode === undefined || !Number.isSafeInteger(segment.durationTicks) || segment.durationTicks <= 0)
    return [];
  const assets = segment.visuals
    .map((visual, index) => ({ visual, index }))
    .filter(({ visual }) => visual.assetVersionRef !== undefined);
  const starts =
    segment.switchMode === 'even'
      ? evenAssetSwitchStarts(segment.durationTicks, assets.length)
      : assets.map(({ visual }, index) => (index === 0 ? 0 : visual.startTick));
  const issues: VideoProjectSwitchIssue[] = [];
  assets.forEach(({ visual, index }, assetIndex) => {
    if (
      visual.startTick !== starts[assetIndex] ||
      (assetIndex > 0 && visual.startTick <= (starts[assetIndex - 1] ?? -1))
    ) {
      issues.push({
        visualIndex: index,
        field: 'startTick',
        message: 'Asset switches must follow the selected mode from zero in strictly increasing order',
      });
    }
    if (visual.endTick !== (starts[assetIndex + 1] ?? segment.durationTicks)) {
      issues.push({
        visualIndex: index,
        field: 'endTick',
        message: 'Asset end is derived from the next switch or segment duration',
      });
    }
  });
  return issues;
}
