import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { recoverySnapshot } from './preview-alpha-recovery-evidence.mjs';

const MAX_ARCHIVED_LOG_BYTES = 16 * 1024 * 1024;
const identity = (st) => [st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs].join(':');

function regularLog(path) {
  const st = lstatSync(path);
  if (realpathSync(path) !== path || st.isSymbolicLink()) throw new Error('preview diagnostic log is linked');
  if (!st.isFile()) throw new Error('preview diagnostic log must be a regular file');
  return st;
}

/** Logs are diagnostics, never authority to stop a process or assert that data was saved. */
export function capturePreviewDiagnosticLog(config, record, evidence) {
  if (!record.logPath) return { details: {}, assertCurrent() {} };
  const path = record.logPath;
  if (path !== (config.logPath ?? join(config.stateDir, `${config.id}.log`)))
    throw new Error('preview log coordinate changed');
  const st = regularLog(path);
  if (st.size <= MAX_ARCHIVED_LOG_BYTES) {
    evidence.sources.log = recoverySnapshot(path, { maxBytes: MAX_ARCHIVED_LOG_BYTES });
    return { details: {}, assertCurrent() {} }; // Checked with the other archived sources.
  }
  // Keep large historical logs at their original coordinate; never allocate or copy their contents.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (identity(fstatSync(fd)) !== identity(st)) throw new Error('preview diagnostic log changed');
  } finally {
    closeSync(fd);
  }
  return {
    details: {
      diagnosticLog: {
        path,
        bytes: st.size,
        status: 'retained_at_source',
        dev: st.dev,
        ino: st.ino,
        mtimeMs: st.mtimeMs,
        ctimeMs: st.ctimeMs,
      },
    },
    assertCurrent() {
      if (identity(regularLog(path)) !== identity(st)) throw new Error('preview diagnostic log changed');
    },
  };
}
