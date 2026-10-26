import { fileURLToPath } from 'node:url';

const workerPath = fileURLToPath(new URL('./ps-environment-worker.mjs', import.meta.url));

// One streaming ps read; retain every identity for safe process-group checks,
// but return full environment text only for the caller's ownership markers.
export function macProcessEnvironmentCommand({ pids, markers, retainEnvironmentKeys = [] }) {
  if (
    !Array.isArray(markers) ||
    markers.some((marker) => typeof marker !== 'string' || !marker || /[\0\r\n]/u.test(marker))
  ) {
    throw new Error('Process ownership markers are required');
  }
  if (!Array.isArray(retainEnvironmentKeys) || retainEnvironmentKeys.some((key) => !/^[A-Z_][A-Z_0-9]*$/u.test(key))) {
    throw new Error('Invalid process environment keys');
  }
  return { file: process.execPath, args: [workerPath, JSON.stringify({ pids, markers, retainEnvironmentKeys })] };
}
