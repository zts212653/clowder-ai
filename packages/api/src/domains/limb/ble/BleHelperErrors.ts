export class BleHelperCompatibilityError extends Error {}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function isCompatibilityError(error: Error): boolean {
  return (
    error instanceof BleHelperCompatibilityError ||
    error.message.startsWith('Unsupported BLE helper protocol') ||
    error.message.startsWith('BLE helper message exceeds')
  );
}
