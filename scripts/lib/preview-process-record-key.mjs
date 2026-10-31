import { createHash } from 'node:crypto';

/** Existing preview record identity, shared by launcher and coordinate readers. */
export function previewProcessRecordId(cwd, port) {
  return createHash('sha256').update(`${cwd}\0${port}`).digest('hex').slice(0, 16);
}
