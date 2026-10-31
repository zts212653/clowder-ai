export type NativeControlCommand =
  | { kind: 'live'; threadId: string; executionId: string; catId: string; invocationId: string }
  | { kind: 'queue'; threadId: string; entryId: string; messageId?: string; catId?: string };
export interface NativeControlReceiptPort {
  authorize(receiptRef: string, ownerUserId: string, command: NativeControlCommand): boolean;
  observe(receiptRef: string, ownerUserId: string, statusCode: number, acknowledged: boolean, code?: string): unknown;
}
