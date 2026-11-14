import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/** Reject drive-relative Windows paths before a test creates directories. */
export function testTempRoot(base = tmpdir()) {
  if (process.platform === 'win32' && !/^(?:[A-Za-z]:[\\/]|\\\\)/.test(base)) {
    throw new Error(`Test temporary root requires a Windows drive or UNC path: ${base}`);
  }
  return base;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.stdout.write(testTempRoot());
