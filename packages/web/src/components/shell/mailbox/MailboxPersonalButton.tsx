import { type ButtonHTMLAttributes, useId } from 'react';
import { AppTooltip } from '@/components/AppTooltip';
import { useShellCopy } from '../shell-copy';
import { personalActionCopy } from './personal-action.shell-copy';
import type { PersonalActionRefusal } from './personal-action-eligibility';

/** Keep disabled actions inert while their explanation remains reachable by pointer, keyboard and touch. */
export function MailboxPersonalButton({
  refusal,
  label,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'disabled'> & {
  refusal: PersonalActionRefusal | null;
  label: string;
}) {
  const t = useShellCopy(personalActionCopy);
  const descriptionId = useId();
  if (!refusal) return <button type="button" {...props} />;
  const reason = refusal === 'source' ? t.source(label) : t[refusal];
  return (
    <>
      <AppTooltip label={reason} side="bottom" multiline showOnClick>
        <span
          role="button"
          tabIndex={0}
          aria-disabled="true"
          aria-label={label}
          aria-describedby={descriptionId}
          className="shell-focusable inline-flex rounded-lg"
        >
          <button
            type="button"
            {...props}
            disabled
            aria-hidden="true"
            tabIndex={-1}
            aria-describedby={descriptionId}
            style={{ ...props.style, pointerEvents: 'none' }}
          />
        </span>
      </AppTooltip>
      <span id={descriptionId} className="sr-only">
        {reason}
      </span>
    </>
  );
}
