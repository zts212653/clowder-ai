// Only structured mirror diagnostics cross the short UI-summary boundary. Never
// expand arbitrary Error messages, stacks, causes, process output or environment.
const LIMIT = 64;
const statuses = new Set(['ready', 'read_failed', 'spawn_failed', 'exited', 'timed_out', 'aborted', 'invalid_output']);

function scalar(source, keys) {
  const result = {};
  for (const key of keys) {
    const value = source[key];
    if (value === null || (typeof value === 'number' && Number.isFinite(value))) result[key] = value;
  }
  return result;
}

function textFields(source, keys) {
  const result = {};
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string') {
      result[key] = value.slice(0, 32768);
      if (value.length > 32768) {
        result.truncatedFields ??= [];
        result.truncatedFields.push(key);
      }
    }
  }
  return result;
}

function failure(value) {
  if (!value || typeof value !== 'object') return {};
  return {
    ...textFields(value, ['reader', 'kind', 'mirror', 'path', 'code', 'syscall']),
    ...scalar(value, ['errno']),
  };
}

function list(values, pick) {
  if (!Array.isArray(values)) return [];
  return values.slice(0, LIMIT).map(pick);
}

function attempt(value) {
  if (!value || typeof value !== 'object') return {};
  const result = {
    schemaVersion: 1,
    component: 'project-mirror-consumer',
    phase: 'settled',
    ...scalar(value, [
      'attempt',
      'pid',
      'budgetMs',
      'elapsedMs',
      'entryCount',
      'exitCode',
      'stdoutBytes',
      'stderrBytes',
    ]),
    ...textFields(value, ['executable', 'signal']),
    ...(statuses.has(value.status) ? { status: value.status } : {}),
    failures: list(value.failures, failure),
  };
  if (value.signal === null) result.signal = null;
  if (value.error && typeof value.error === 'object') {
    result.error = { ...textFields(value.error, ['code', 'syscall']), ...scalar(value.error, ['errno']) };
  }
  if (Array.isArray(value.failures) && value.failures.length > LIMIT) {
    result.omittedFailures = value.failures.length - LIMIT;
  }
  return result;
}

function getStartupErrorDiagnostics(error) {
  try {
    const value = error?.projectMirrorDiagnostics;
    if (!value || value.schemaVersion !== 1) return undefined;
    const details = {
      schemaVersion: 1,
      component: 'project-mirror-readiness',
      sourceFailures: list(value.sourceFailures, failure),
      mirrorFailures: list(value.mirrorFailures, failure),
      consumerAttempts: list(value.consumerAttempts, attempt),
    };
    for (const key of ['sourceFailures', 'mirrorFailures', 'consumerAttempts']) {
      if (Array.isArray(value[key]) && value[key].length > LIMIT) {
        details.omitted ??= {};
        details.omitted[key] = value[key].length - LIMIT;
      }
    }
    return details;
  } catch {
    // Optional diagnostics cannot replace the original startup failure.
    return undefined;
  }
}

function logStartupErrorDiagnostics(dbg, details) {
  if (!details) return;
  const { consumerAttempts, ...parent } = details;
  for (const record of [parent, ...consumerAttempts]) {
    try {
      dbg(`Desktop startup diagnostic ${JSON.stringify(record)}`);
    } catch {
      // Disk/diagnostic failures must not interrupt service shutdown or the UI.
    }
  }
}

module.exports = { getStartupErrorDiagnostics, logStartupErrorDiagnostics };
