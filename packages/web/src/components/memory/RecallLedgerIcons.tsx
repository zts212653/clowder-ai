import type { ReactNode } from 'react';

interface LedgerIconProps {
  className?: string;
}

function LedgerIconFrame({ name, className, children }: LedgerIconProps & { name: string; children: ReactNode }) {
  return (
    <svg
      data-recall-ledger-icon={name}
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** A bound notebook: the Recall Ledger's canonical mark. */
export function LedgerBookIcon(props: LedgerIconProps) {
  return (
    <LedgerIconFrame name="ledger" {...props}>
      <rect x="4" y="3" width="16" height="18" rx="2.5" />
      <path d="M8 3v18" />
      <path d="M11 8h6" />
      <path d="M11 12h6" />
      <path d="M11 16h4" />
      <path d="M5.5 7h1" />
      <path d="M5.5 11h1" />
      <path d="M5.5 15h1" />
    </LedgerIconFrame>
  );
}

/** A crossed-out food bowl: consumed memory that caused harm. */
export function HarmfulConsumptionIcon(props: LedgerIconProps) {
  return (
    <LedgerIconFrame name="harmful-consumption" {...props}>
      <path d="M4 10.5h16c0 4.7-3.6 8-8 8s-8-3.3-8-8Z" />
      <path d="M7 18.5h10" />
      <path d="M8.5 7.5c0-1.4 1-2.2 2-3" />
      <path d="m4 4 16 16" />
    </LedgerIconFrame>
  );
}

/** A search lens with an empty center: demand that found no usable memory. */
export function UnmetDemandIcon(props: LedgerIconProps) {
  return (
    <LedgerIconFrame name="unmet-demand" {...props}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.2 15.2 5.3 5.3" />
      <path d="M8 10.5h1.5" />
      <path d="M12 10.5h1.5" />
    </LedgerIconFrame>
  );
}

/** An eye with a clock: the attention time paid by You and the cats. */
export function AttentionCostIcon(props: LedgerIconProps) {
  return (
    <LedgerIconFrame name="attention-cost" {...props}>
      <path d="M2.5 11.5s3.4-5 9.5-5 9.5 5 9.5 5-3.4 5-9.5 5-9.5-5-9.5-5Z" />
      <circle cx="12" cy="11.5" r="2.5" />
      <circle cx="18.5" cy="18.5" r="3" />
      <path d="M18.5 17v1.7l1.1.7" />
    </LedgerIconFrame>
  );
}
