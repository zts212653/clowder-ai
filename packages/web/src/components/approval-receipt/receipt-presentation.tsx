import { createContext, type ReactNode } from 'react';
import type { DecisionResultStatus } from '../rich/ApprovalResultRow';

/** Placement only. Producer result readers and action owners stay with the original card. */
export const ApprovalReceiptPresentation = createContext<{
  lead: ReactNode;
  suffix: ReactNode;
  status: DecisionResultStatus;
  decisionWord: string;
  time: string;
} | null>(null);

export function receiptOutcome(label: string, decision: string, time: string): string {
  let outcome = label === decision ? '' : label.startsWith(`${decision} · `) ? label.slice(decision.length + 3) : label;
  if (outcome === time) return '';
  if (outcome.endsWith(` · ${time}`)) outcome = outcome.slice(0, -(time.length + 3));
  return outcome;
}
