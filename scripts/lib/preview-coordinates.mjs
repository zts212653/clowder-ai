import { realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';

const RESERVED_PREVIEW_PORTS = new Set([
  '3001',
  '3002',
  '3003',
  '3004',
  '3011',
  '3012',
  '4100',
  '4111',
  '6397',
  '6398',
  '6399',
]);
const SAFE_MANAGED_PREVIEW_COORDINATE = /^[A-Za-z0-9._/@+-]+$/;

export function canonicalAlphaCwd(requestedCwd, shellCwd) {
  const requested = physicalDirectory(requestedCwd);
  const shell = physicalDirectory(shellCwd);
  return requested && requested === shell && basename(requested) === 'cat-cafe' ? requested : null;
}

export function canonicalWorktreePreviewPort(port) {
  if (typeof port !== 'string' || !/^[1-9]\d*$/.test(port)) return null;
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort > 65535) return null;
  const canonicalPort = String(numericPort);
  return RESERVED_PREVIEW_PORTS.has(canonicalPort) ? null : canonicalPort;
}

export function physicalDirectory(raw) {
  if (typeof raw !== 'string' || !SAFE_MANAGED_PREVIEW_COORDINATE.test(raw) || !isAbsolute(raw)) return null;
  try {
    const physical = realpathSync(raw);
    return statSync(physical).isDirectory() ? physical : null;
  } catch {
    return null;
  }
}
