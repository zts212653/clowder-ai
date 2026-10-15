/** Isolated W4.P owner only. Production must use its existing durable operation owner. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

export interface ControlIntent {
  operationId: string;
  nativeSessionId: string;
  nativeTurnId: string;
  bindingRevision: string;
  clientUserMessageId: string;
  signature: string;
  promptHash: string;
  receipt?: Record<string, unknown>;
}
export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function controlKey(bindingRevision: string, sessionId: string, operationId: string): string {
  return digest([bindingRevision, sessionId, operationId]);
}
export function nativeClientId(key: string): string {
  return `${key.slice(0, 8)}-${key.slice(8, 12)}-5${key.slice(13, 16)}-a${key.slice(17, 20)}-${key.slice(20, 32)}`;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function validNativeReceipt(receipt: Record<string, unknown>, intent: Record<string, unknown>): boolean {
  const native = receipt['nativeReceipt'];
  if (
    !isRecord(native) ||
    native['turnId'] !== intent['nativeTurnId'] ||
    receipt['operationId'] !== intent['operationId'] ||
    receipt['nativeSessionId'] !== intent['nativeSessionId'] ||
    receipt['nativeTurnId'] !== intent['nativeTurnId'] ||
    receipt['outcome'] !== 'injected'
  )
    return false;
  if (native['source'] === undefined) return true; // Native turn/steer response.
  return (
    native['source'] === 'native_history' &&
    typeof native['nativeItemId'] === 'string' &&
    native['nativeItemId'].length > 0 &&
    native['clientUserMessageId'] === intent['clientUserMessageId']
  );
}
export class ControlJournal {
  constructor(private readonly directory: string) {}
  async read(key: string): Promise<ControlIntent | null> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(this.directory, key, 'record.json'), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('control_journal_unreadable', { cause: error });
    }
    if (
      !isRecord(raw) ||
      ![
        'operationId',
        'nativeSessionId',
        'nativeTurnId',
        'bindingRevision',
        'clientUserMessageId',
        'signature',
        'promptHash',
      ].every((field) => typeof raw[field] === 'string' && raw[field]) ||
      controlKey(String(raw['bindingRevision']), String(raw['nativeSessionId']), String(raw['operationId'])) !== key ||
      raw['clientUserMessageId'] !== nativeClientId(key) ||
      (raw['receipt'] !== undefined && (!isRecord(raw['receipt']) || !validNativeReceipt(raw['receipt'], raw)))
    )
      throw new Error('control_journal_corrupt');
    return raw as unknown as ControlIntent;
  }
  async claim(key: string, intent: ControlIntent): Promise<boolean> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      // mkdir is the cross-process claim. A claimant never steals an orphaned claim.
      await mkdir(join(this.directory, key), { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
    await this.save(key, intent);
    return true;
  }
  async save(key: string, intent: ControlIntent): Promise<void> {
    const directory = join(this.directory, key);
    const temporary = join(directory, `record-${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(intent));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, join(directory, 'record.json'));
  }
}
