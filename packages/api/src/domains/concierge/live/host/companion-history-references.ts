import { randomBytes } from 'node:crypto';
import { CompanionBridgeError } from '../companion-owner-client.js';

export type HistoryReference =
  | { kind: 'history'; threadId: string; messageId: string; time: number }
  | { kind: 'body'; threadId: string; messageId: string; revision: string; offset: number };

/** Disposable read capabilities; Message and draft remain the durable owners. */
export class CompanionHistoryReferences {
  private readonly issued = new Map<string, HistoryReference>();
  issue(reference: HistoryReference): string {
    const token = randomBytes(24).toString('hex');
    this.issued.set(token, reference);
    if (this.issued.size > 256) this.issued.delete(this.issued.keys().next().value!);
    return token;
  }
  read(token: string, kind: HistoryReference['kind']): HistoryReference | undefined {
    if (!/^[a-f0-9]{48}$/.test(token)) throw new CompanionBridgeError('invalid_request');
    const reference = this.issued.get(token);
    if (reference && reference.kind !== kind) throw new CompanionBridgeError('invalid_request');
    return reference;
  }
  clear(): void {
    this.issued.clear();
  }
}
