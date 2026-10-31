import { hasHighValueSignal, SUMMARY_CONFIG } from './summary-config.js';

export interface SummaryEligibilityState {
  pending_message_count: number;
  pending_token_count: number;
  pending_signal_flags: number;
  carry_over: number;
  last_abstractive_at: string | null;
}

function householdDate(time: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(time);
}

/** Once a day, the existing half-hour tick also picks up quiet, small conversations. */
export function dailyCurationDue(state: SummaryEligibilityState, timezone: string, now = Date.now()): boolean {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hourCycle: 'h23' }).format(now),
  );
  return (
    state.pending_message_count > 0 &&
    hour >= 4 &&
    (!state.last_abstractive_at ||
      householdDate(Date.parse(state.last_abstractive_at), timezone) !== householdDate(now, timezone))
  );
}

export function isSummaryEligible(
  state: SummaryEligibilityState,
  activity: { lastMessageAt: number } | null,
  config: typeof SUMMARY_CONFIG = SUMMARY_CONFIG,
  options: { daily?: boolean; now?: () => number; startedAt?: () => number | null } = {},
): boolean {
  const now = options.now?.() ?? Date.now();
  const since = options.startedAt?.();
  if (since && (!activity || activity.lastMessageAt < since)) return false;
  if (options.daily) return state.pending_message_count > 0;
  if (activity && now - activity.lastMessageAt < config.quietWindowMinutes * 60_000) return false;
  const bypass = hasHighValueSignal(state.pending_signal_flags) || state.carry_over === 1;
  if (
    !bypass &&
    state.pending_message_count < config.pendingMessageThreshold &&
    state.pending_token_count < config.pendingTokenThreshold
  )
    return false;
  return (
    bypass ||
    !state.last_abstractive_at ||
    now - Date.parse(state.last_abstractive_at) >= config.cooldownHours * 3_600_000
  );
}
