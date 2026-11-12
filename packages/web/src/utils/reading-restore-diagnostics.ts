import type { ReadingRestoreDiagnostic } from '@cat-cafe/shared';
import { connectionDiagnosticId, recordConnectionDiagnostic } from './connection-diagnostics';

export type ReadingDiagnosticRequest = Pick<ReadingRestoreDiagnostic, 'bridgeId' | 'operationId'>;
export type ReadingDiagnosticContext = ReadingDiagnosticRequest & Pick<ReadingRestoreDiagnostic, 'readerId'>;
export type ReadingCancelSource = NonNullable<ReadingRestoreDiagnostic['cancelSource']>;
export type ReadingInputDiagnostic = Pick<ReadingRestoreDiagnostic, 'inputKind' | 'inputTrusted'>;
export type ReadingDiagnosticState = Pick<
  ReadingRestoreDiagnostic,
  'readerMounted' | 'refreshPending' | 'restorePending' | 'settlementPending'
>;
type Receipt = { status: 'settled' | 'interrupted' | 'unavailable'; exact?: boolean };

/** Diagnostic UUIDs are coordinates only; failure must not affect the reader. */
export function readingDiagnosticId(): string | undefined {
  try {
    return connectionDiagnosticId();
  } catch {
    return undefined;
  }
}

function record(
  context: ReadingDiagnosticContext,
  state: (context: ReadingDiagnosticContext) => ReadingDiagnosticState,
  detail: Pick<ReadingRestoreDiagnostic, 'phase' | 'cancelSource' | 'inputKind' | 'inputTrusted' | 'status' | 'exact'>,
): void {
  try {
    recordConnectionDiagnostic({
      kind: 'reading_restore',
      bridgeId: context.bridgeId,
      operationId: context.operationId,
      readerId: context.readerId,
      ...state(context),
      ...detail,
    });
  } catch {
    /* Diagnostics never alter restore results or exceptions. */
  }
}

export async function observeReadingRestore<T extends Receipt>(
  context: ReadingDiagnosticContext | undefined,
  state: (context: ReadingDiagnosticContext) => ReadingDiagnosticState,
  restore: () => Promise<T>,
): Promise<T> {
  if (!context) return restore();
  record(context, state, { phase: 'start' });
  try {
    const receipt = await restore();
    record(context, state, {
      phase: 'complete',
      status: receipt.status,
      ...(receipt.exact === undefined ? {} : { exact: receipt.exact }),
    });
    return receipt;
  } catch (error) {
    record(context, state, { phase: 'complete', status: 'threw' });
    throw error;
  }
}

/** Called only for waits the existing cancellation is actually about to retire. */
export function recordReadingCancellation(
  contexts: Array<ReadingDiagnosticContext | undefined>,
  state: (context: ReadingDiagnosticContext) => ReadingDiagnosticState,
  cancelSource: ReadingCancelSource,
  input?: ReadingInputDiagnostic,
): void {
  for (const context of new Set(contexts)) {
    if (context)
      record(context, state, {
        phase: 'cancel',
        cancelSource,
        inputKind: input?.inputKind,
        inputTrusted: input?.inputTrusted,
      });
  }
}
