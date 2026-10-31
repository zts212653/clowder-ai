import { FEATURE_DEMOS } from '@cat-cafe/shared';
import type { CapabilityTipsUsageRow } from '../infrastructure/harness-eval/capability-tips/capability-tips-usage-adapter.js';

const ratio = (numerator: number, denominator: number) => (denominator === 0 ? null : numerator / denominator);

/** Aggregate observations in the chosen UTC event window; these are not unique people or causal lift. */
export function summarizeTipDemos(rows: readonly CapabilityTipsUsageRow[]) {
  const demos = Object.entries(FEATURE_DEMOS).map(([demoId, demo]) => {
    const count = (event: string) =>
      rows
        .filter((row) => row.tipId === demo.tipId && row.event === event && row.outcome !== 'failed')
        .reduce((sum, row) => sum + row.count, 0);
    const exposed = count('capability_tip_demo_exposed');
    const opened = count('capability_tip_demo_opened');
    const started = count('capability_tip_demo_started');
    const completed = count('capability_tip_demo_completed');
    const tried = count('capability_tip_demo_tried');
    // Only demos with a product use signal can count "used"; for the rest it is unknown, not zero.
    const used = demo.useSignal ? count('capability_tip_demo_used') : null;
    return {
      demoId,
      tipId: demo.tipId,
      exposed,
      opened,
      started,
      completed,
      tried,
      used,
      watchRate: ratio(opened, exposed),
      completionRate: ratio(completed, opened),
      useAfterCompletionRate: used === null ? null : ratio(used, completed),
    };
  });
  return {
    status: demos.every((demo) => demo.exposed + demo.opened + demo.completed + (demo.used ?? 0) === 0)
      ? 'no_data'
      : 'observed',
    demos,
    counting: {
      unit: 'displayed-tip-opportunity',
      completion: 'ended-and-at-least-90-percent-unique-media-time-played',
      use: 'successful-F128-approval-creation-after-latest-completion-in-same-tab-within-7-days',
      watchDenominator: 'exposures',
      completionDenominator: 'opened',
      useDenominator: 'completed',
    },
    limitations: [
      'event-time-window-can-split-funnels',
      'same-tab-latest-completion-only',
      'delivery-can-be-incomplete',
      'observations-not-causal-lift',
      'per-tip-not-per-video-version',
      'use-measured-only-for-demos-with-a-use-signal',
    ],
  };
}
