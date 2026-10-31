import type { EntrustedWorkOwnerReadV1 } from '@cat-cafe/shared';
import { useShellCopy } from '@/components/shell/shell-copy';
import { scheduleCopy } from './product-schedule.shell-copy';
import { ScheduleAskProgress } from './ScheduleAskProgress';

/** These controls change only the owner's view; the Work and its producer receipts remain intact. */
export function SchedulePersonalActions({
  ownerRead,
  ignored,
  disabled,
  onChange,
}: {
  ownerRead: EntrustedWorkOwnerReadV1;
  ignored: boolean;
  disabled: boolean;
  onChange: (ignored: boolean) => void;
}) {
  const t = useShellCopy(scheduleCopy);
  return (
    <>
      <ScheduleAskProgress ownerRead={ownerRead} />
      <button
        type="button"
        data-testid={ignored ? 'schedule-restore' : 'schedule-ignore'}
        disabled={disabled}
        onClick={() => onChange(!ignored)}
        className="rounded-lg border border-cafe-subtle px-3 py-2 text-xs font-medium text-cafe-secondary disabled:opacity-50"
        aria-label={
          ignored
            ? t.restoreWork(ownerRead.work?.title ?? ownerRead.envelope.subjectRef)
            : t.ignoreWork(ownerRead.work?.title ?? ownerRead.envelope.subjectRef)
        }
      >
        {ignored ? t.restore : t.ignore}
      </button>
    </>
  );
}
