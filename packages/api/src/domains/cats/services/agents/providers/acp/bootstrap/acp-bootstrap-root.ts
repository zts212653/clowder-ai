import { isAbsolute } from 'node:path';

/** Validate the configured path without loading filesystem or process launch code. */
export function isExplicitAcpBootstrapRoot(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 8192 &&
    !/[\u0000\r\n]/.test(value) &&
    isAbsolute(value) &&
    (process.platform !== 'win32' || /^[a-z]:[\\/]/i.test(value))
  );
}
