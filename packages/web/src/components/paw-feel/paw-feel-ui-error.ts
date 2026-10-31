import type { pawFeelCopy } from './paw-feel.shell-copy';

/** Local presentation failures remain structured so a language change never requires another request. */
export type PawFeelUiError =
  | { kind: 'inbox_request_failed' | 'duty_request_failed' | 'duty_save_failed'; status: number }
  | { kind: 'invalid_inbox' | 'invalid_duty' | 'both_required' | 'different_required' }
  | { kind: 'source'; message: string };

export class PawFeelLocalError extends Error {
  constructor(readonly detail: PawFeelUiError) {
    super(detail.kind);
  }
}

export function pawFeelUiError(reason: unknown): PawFeelUiError {
  return reason instanceof PawFeelLocalError
    ? reason.detail
    : { kind: 'source', message: reason instanceof Error ? reason.message : String(reason) };
}

/** Only local labels are translated. A returned producer message stays its original text. */
export function pawFeelUiErrorText(error: PawFeelUiError, t: typeof pawFeelCopy.zh): string {
  switch (error.kind) {
    case 'inbox_request_failed':
      return `${t.requestFailed} (${error.status})`;
    case 'duty_request_failed':
      return `${t.dutyRequestFailed} (${error.status})`;
    case 'duty_save_failed':
      return `${t.dutySaveFailed} (${error.status})`;
    case 'invalid_inbox':
      return t.invalidInbox;
    case 'invalid_duty':
      return t.invalidDuty;
    case 'both_required':
      return t.bothRequired;
    case 'different_required':
      return t.differentRequired;
    case 'source':
      return error.message;
  }
}
