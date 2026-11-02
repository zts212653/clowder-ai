/** Server-admitted reply provenance. This is independent from a browser delivery receipt. */
export interface CloudBridgeReturnV1 {
  readonly v: 1;
  readonly threadId: string;
  readonly sourceMessageId: string;
  readonly targetCatId: string;
  readonly dispatchInvocationId: string;
}

const FIELDS = ['v', 'threadId', 'sourceMessageId', 'targetCatId', 'dispatchInvocationId'];
export function isCloudBridgeReturnV1(value: unknown): value is CloudBridgeReturnV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.v === 1 &&
    Object.keys(record).every((key) => FIELDS.includes(key)) &&
    FIELDS.slice(1).every(
      (key) =>
        typeof record[key] === 'string' &&
        record[key].length > 0 &&
        record[key].length <= (key === 'targetCatId' ? 128 : 512) &&
        !/[\u0000-\u001f\u007f]/u.test(record[key]),
    )
  );
}
