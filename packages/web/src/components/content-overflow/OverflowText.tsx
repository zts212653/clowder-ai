'use client';

import { AppTooltip } from '@/components/AppTooltip';
import { useMeasuredOverflow } from './useMeasuredOverflow';

/** Use the shell's existing tip only when the rendered label actually loses text. */
export function OverflowText({
  text,
  className,
  multiline = false,
}: {
  text: string;
  className?: string;
  multiline?: boolean;
}) {
  const { ref, overflowing } = useMeasuredOverflow<HTMLSpanElement>({ axis: multiline ? 'block' : 'inline' });
  return (
    <AppTooltip label={text} disabled={!overflowing} multiline side="bottom">
      <span ref={ref} className={className} tabIndex={overflowing ? 0 : undefined}>
        {text}
      </span>
    </AppTooltip>
  );
}
