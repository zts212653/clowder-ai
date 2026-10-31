import type { RowStatus } from './row-model';

export type ExecutionRowTone = 'info' | 'warning' | 'critical' | 'neutral';

const TONE_BY_STATUS: Record<RowStatus, ExecutionRowTone> = {
  working: 'info',
  stopping: 'info',
  blocked: 'info',
  silent: 'warning',
  confirming: 'neutral',
  unverified: 'warning',
  waiting: 'neutral',
};

export const executionRowTone = (status: RowStatus): ExecutionRowTone => TONE_BY_STATUS[status];

export const executionRowToneColor = (tone: ExecutionRowTone): string =>
  tone === 'neutral' ? 'var(--shell-muted)' : `var(--semantic-${tone})`;

export const executionRowToneSurface = (tone: ExecutionRowTone): string =>
  tone === 'neutral' ? 'var(--shell-paper)' : `var(--semantic-${tone}-surface)`;
