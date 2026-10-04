/** The slice of the Approval Hub store the decision actions read and write. */
import type { ApprovalHubItem } from '@cat-cafe/shared';
import type { DecisionAttemptsSlice } from './approval-decision-attempts';
import type { DecidingMap } from './approval-decision-http';

export interface DecisionStoreSlice extends DecisionAttemptsSlice {
  items: ApprovalHubItem[];
  count: number;
  error: string | null;
  deciding: DecidingMap;
}

export type SliceUpdate = (
  update: Partial<DecisionStoreSlice> | ((state: DecisionStoreSlice) => Partial<DecisionStoreSlice>),
) => void;
