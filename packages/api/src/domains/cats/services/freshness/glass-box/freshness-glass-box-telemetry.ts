import { freshnessGlassBoxTransition } from '../../../../../infrastructure/telemetry/instruments.js';

export type FreshnessGlassBoxTransition =
  | 'published_with_unseen'
  | 'supplement_offered'
  | 'supplement_produced'
  | 'supplement_declined'
  | 'supplement_decline_protocol_recovered';

const totals: Record<FreshnessGlassBoxTransition, number> = {
  published_with_unseen: 0,
  supplement_offered: 0,
  supplement_produced: 0,
  supplement_declined: 0,
  supplement_decline_protocol_recovered: 0,
};

export function recordFreshnessGlassBoxTransition(transition: FreshnessGlassBoxTransition): void {
  totals[transition] += 1;
  freshnessGlassBoxTransition.add(1, { transition });
}

export function getFreshnessGlassBoxTelemetrySnapshot(): Record<FreshnessGlassBoxTransition, number> {
  return { ...totals };
}

export function resetFreshnessGlassBoxTelemetryForTest(): void {
  for (const transition of Object.keys(totals) as FreshnessGlassBoxTransition[]) totals[transition] = 0;
}
