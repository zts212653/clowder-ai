type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {};
const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : undefined);
const httpStatus = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;

/** Read only declared error fields; never stringify arbitrary provider payloads or response bodies. */
export function readOpenCodeError(event: unknown) {
  const error = record(record(event).error);
  const data = record(error.data);
  return {
    message: text(data.message) ?? text(error.message) ?? text(error.name),
    type: text(error.type) ?? text(error.name),
    statusCode: httpStatus(data.statusCode) ?? httpStatus(error.status),
  };
}
