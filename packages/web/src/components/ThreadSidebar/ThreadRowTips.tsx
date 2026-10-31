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
    <AppTooltip label={label} side="right">
      {children}
    </AppTooltip>
  );
}

/**
 * Recover only a clipped title. Visible row facts do not need a second metadata card.
 */
export function RowTitleTip({
  enabled,
  title,
  children,
}: {
  enabled: boolean;
  title: string;
  children: ReactElement;
}): ReactElement {
  if (!enabled) return children;
  return (
    <AppTooltip label={title} side="right" intent="content" onlyWhenTruncated multiline>
      {children}
    </AppTooltip>
  );
}
