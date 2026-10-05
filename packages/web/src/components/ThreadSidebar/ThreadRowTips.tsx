'use client';

import type { ReactElement } from 'react';
import { AppTooltip } from '../AppTooltip';

/** v2 rows use the app tip (keyboard + touch reachable, no native `title`); classic rows are left untouched. */
export function RowTip({
  enabled,
  label,
  children,
}: {
  enabled: boolean;
  label: string;
  children: ReactElement;
}): ReactElement {
  if (!enabled) return children;
  return (
    <AppTooltip label={label} side="bottom">
      {children}
    </AppTooltip>
  );
}

/**
 * The row shows a clamped title; the tip is how the FULL title, the roster, the path and the time stay
 * recoverable by keyboard focus, long-press and hover (AC-A2 / B2) once the native `title` is gone.
 */
export function RowTitleTip({
  enabled,
  title,
  lines,
  children,
}: {
  enabled: boolean;
  title: string;
  lines: readonly string[];
  children: ReactElement;
}): ReactElement {
  if (!enabled) return children;
  return (
    <AppTooltip label={title} detail={lines.join('\n')} side="bottom" multiline>
      {children}
    </AppTooltip>
  );
}
