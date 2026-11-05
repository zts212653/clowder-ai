export interface InvocationOwnerHealthInput {
  signature: string;
  silence: boolean;
  failed: boolean;
}
export interface InvocationOwnerHealthReceipt {
  changed: boolean;
  silenceNew: boolean;
  parked: boolean;
}
export interface InvocationOwnerHealthFacts {
  scope: string;
  recordStatus?: import('./InvocationRecordStore.js').InvocationStatus;
  signature?: string;
  silenceSignaled?: boolean;
  failures: number;
  disposition?: 'needs_attention';
  reasonCode?: string;
}

export function observeInvocationOwnerHealth(
  facts: InvocationOwnerHealthFacts,
  input: InvocationOwnerHealthInput,
): InvocationOwnerHealthReceipt {
  const wasParked = facts.disposition === 'needs_attention';
  let changed = facts.signature !== input.signature;
  const silenceNew = input.silence && !facts.silenceSignaled;
  facts.signature = input.signature;
  if (silenceNew) facts.silenceSignaled = true;
  facts.failures = input.failed ? facts.failures + 1 : 0;
  if (facts.failures >= 5) facts.disposition = 'needs_attention';
  if (!wasParked && facts.disposition) changed = true;
  return { changed, silenceNew, parked: facts.disposition === 'needs_attention' };
}
