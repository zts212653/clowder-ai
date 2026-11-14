import { createHash } from 'node:crypto';

export interface ApprovedTaskContinuationDiagnostic {
  stage: 'read' | 'missing' | 'json' | 'identity' | 'provenance' | 'recovery_envelope';
  object: 'proposal' | 'task' | 'child' | 'history_index' | 'implementation_history';
  keyDigest?: string;
}

export function continuationKeyDigest(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/** Carries only content-free diagnosis; original bytes and decoder errors never enter logs. */
export class ApprovedTaskContinuationUnavailable extends Error {
  readonly diagnostic: ApprovedTaskContinuationDiagnostic;

  constructor(
    stage: ApprovedTaskContinuationDiagnostic['stage'],
    object: ApprovedTaskContinuationDiagnostic['object'],
    key?: string,
  ) {
    super(`approved Task continuation unavailable: ${object}/${stage}`);
    this.diagnostic = { stage, object, ...(key ? { keyDigest: continuationKeyDigest(key) } : {}) };
  }
}

export async function readContinuationValue<T>(
  object: ApprovedTaskContinuationDiagnostic['object'],
  key: string,
  read: () => T | Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch {
    throw new ApprovedTaskContinuationUnavailable('read', object, key);
  }
}
