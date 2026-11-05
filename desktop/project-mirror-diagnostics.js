const { getSystemErrorMap } = require('node:util');

const CODES = new Set([...getSystemErrorMap().values()].map(([code]) => code));
for (const code of ['UNKNOWN', 'ABORT_ERR', 'INVALID_OUTPUT', 'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE'])
  CODES.add(code);
const SYSCALLS = new Set(['open', 'read', 'stat', 'lstat', 'readlink', 'spawn', 'kill', 'parse']);

function safeFilesystemFields(error) {
  const syscall = typeof error?.syscall === 'string' ? error.syscall.split(' ', 1)[0] : null;
  return {
    code: CODES.has(error?.code) ? error.code : 'UNKNOWN',
    errno: Number.isSafeInteger(error?.errno) ? error.errno : null,
    syscall: SYSCALLS.has(syscall) ? syscall : null,
  };
}

/** Paths come from the Host's known probe entries, never arbitrary worker output. */
function safeProbeFailure(entry, error) {
  return Object.freeze({
    ...(entry.reader ? { reader: entry.reader } : {}),
    kind: entry.kind,
    ...(entry.mirror ? { mirror: entry.mirror } : {}),
    path: entry.path,
    ...safeFilesystemFields(error),
  });
}

function parseConsumerFailures(output, entries) {
  const result = JSON.parse(output);
  if (result?.version !== 1 || !Array.isArray(result.failures) || result.failures.length > entries.length) {
    throw new Error('Invalid consumer diagnostics');
  }
  const seen = new Set();
  return result.failures.map((failure) => {
    const index = entries.findIndex(
      (entry) => entry.kind === failure?.kind && entry.path === failure.path && entry.mirror === failure.mirror,
    );
    if (index < 0 || seen.has(index)) throw new Error('Invalid consumer diagnostic entry');
    seen.add(index);
    return safeProbeFailure(entries[index], failure);
  });
}

function parseConsumerOutcome({ failure, status, code, output, entries }) {
  if (failure) return { failure, status, failures: [] };
  if (code !== 0) {
    return { failure: new Error(`Project mirror consumer exited ${code}`), status: 'exited', failures: [] };
  }
  try {
    const failures = parseConsumerFailures(output, entries);
    return { status: failures.length ? 'read_failed' : 'ready', failures };
  } catch {
    return {
      failure: Object.assign(new Error('Invalid consumer diagnostics'), { code: 'INVALID_OUTPUT', syscall: 'parse' }),
      status: 'invalid_output',
      failures: [],
    };
  }
}

function consumerFailureError({ failure, status, code, event }) {
  if (status === 'aborted') {
    try {
      Object.defineProperty(failure, 'projectMirrorConsumer', { value: event, configurable: true });
    } catch {
      /* Preserve the caller's abort reason. */
    }
    return failure;
  }
  const message = {
    timed_out: 'Project mirror consumer timed out',
    spawn_failed: 'Project mirror consumer failed to spawn',
    exited: `Project mirror consumer exited ${code}`,
    invalid_output: 'Invalid consumer diagnostics',
  }[status];
  return Object.assign(new Error(message), safeFilesystemFields(failure), { projectMirrorConsumer: event });
}

function createConsumerDiagnosticEmitter({ nodeExe, attempt, budgetMs, entryCount, onDiagnostic }) {
  const startedAt = Date.now();
  return (
    phase,
    status,
    { pid = null, exitCode = null, signal = null, stdoutBytes = 0, stderrBytes = 0, failures = [], error } = {},
  ) => {
    const event = Object.freeze({
      schemaVersion: 1,
      component: 'project-mirror-consumer',
      phase,
      attempt,
      pid: Number.isSafeInteger(pid) ? pid : null,
      budgetMs,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      executable: nodeExe,
      entryCount,
      status,
      exitCode: Number.isSafeInteger(exitCode) ? exitCode : null,
      signal: typeof signal === 'string' && /^SIG[A-Z0-9]+$/.test(signal) ? signal : null,
      stdoutBytes,
      stderrBytes,
      failures: Object.freeze([...failures]),
      ...(error ? { error: Object.freeze(safeFilesystemFields(error)) } : {}),
    });
    try {
      onDiagnostic(event);
    } catch {
      /* Diagnostics cannot strand the owned child. */
    }
    return event;
  };
}

function attachMirrorDiagnostics(error, state) {
  const metadata = Object.freeze({
    schemaVersion: 1,
    sourceFailures: Object.freeze(state.sourceFailures.map((entry) => safeProbeFailure(entry, entry))),
    mirrorFailures: Object.freeze(state.mirrorFailures.map((entry) => safeProbeFailure(entry, entry))),
    consumerAttempts: Object.freeze([...state.consumerAttempts]),
  });
  try {
    Object.defineProperty(error, 'projectMirrorDiagnostics', { value: metadata, configurable: true });
  } catch {
    // Frozen Errors and primitive abort reasons keep their original identity.
    // The per-attempt log already contains the available diagnostics.
  }
  return error;
}

module.exports = {
  safeFilesystemFields,
  safeProbeFailure,
  parseConsumerFailures,
  parseConsumerOutcome,
  consumerFailureError,
  createConsumerDiagnosticEmitter,
  attachMirrorDiagnostics,
};
