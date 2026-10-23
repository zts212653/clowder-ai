const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { PROJECT_MIRROR_PROBES, prepareProjectMirrors } = require('./project-mirrors');
const { readProjectMirrorsInConsumer } = require('./project-mirror-consumer');
const { safeFilesystemFields, safeProbeFailure, attachMirrorDiagnostics } = require('./project-mirror-diagnostics');

function readEntries(entries) {
  return entries.flatMap((entry) => {
    try {
      fs.readFileSync(entry.path);
      return [];
    } catch (error) {
      return [safeProbeFailure(entry, error)];
    }
  });
}

function formatFailures(failures) {
  return failures.map(
    (failure) =>
      `${failure.reader ?? 'parent'} ${failure.kind} ${failure.path}: code=${failure.code} errno=${failure.errno ?? 'unknown'} syscall=${failure.syscall ?? 'unknown'}`,
  );
}

function parentReaderReady(mirrorFailures, sourceFailures) {
  return mirrorFailures.length === 0 && sourceFailures.length === 0;
}

function readinessError({ sourceFailures, failures, consumerFailures, consumerError, nodeExe }) {
  const details = [...formatFailures(sourceFailures), ...formatFailures(failures), ...formatFailures(consumerFailures)];
  if (consumerError) {
    const error = safeFilesystemFields(consumerError);
    details.push(
      `consumer ${nodeExe}: code=${error.code} errno=${error.errno ?? 'unknown'} syscall=${error.syscall ?? 'unknown'}`,
    );
  }
  return new Error(`Project mirror readiness failed before API start:\n${details.join('\n')}`);
}

async function probeConsumer({ nodeExe, entries, signal, remaining, attempt, log, onDiagnostic }) {
  try {
    const failures = await readProjectMirrorsInConsumer({
      nodeExe,
      entries,
      signal,
      timeoutMs: Math.min(1000, remaining),
      attempt: attempt + 1,
      onDiagnostic,
      onSpawn: (pid) => log(`Project mirror consumer attempt ${attempt + 1}: pid=${pid}, executable=${nodeExe}`),
    });
    signal?.throwIfAborted();
    return { failures: failures.map((failure) => ({ ...failure, reader: 'consumer' })) };
  } catch (error) {
    signal?.throwIfAborted();
    return { failures: [], error };
  }
}

/** Verify bundled resources before API startup; a fresh consumer is evidence,
 * not a claim about Windows cache behavior or permission-policy relaxation. */
async function waitWithDiagnostics(
  { installRoot, projectDir, nodeExe, signal, log = () => {}, timeoutMs = 5000, probes = PROJECT_MIRROR_PROBES },
  state,
) {
  signal?.throwIfAborted();
  const deadline = Date.now() + timeoutMs;
  const entries = (kind, root) =>
    probes.map(({ mirror, relativePath }) => ({
      kind,
      mirror,
      path: path.join(root, mirror, relativePath),
    }));
  const mirrorEntries = entries('mirror', projectDir);
  const sourceEntries = entries('source', installRoot);
  let failures = readEntries(mirrorEntries);
  let sourceFailures = readEntries(sourceEntries);
  state.mirrorFailures = failures;
  state.sourceFailures = sourceFailures;
  if (parentReaderReady(failures, sourceFailures)) {
    log(`Project mirror readiness verified (${probes.length} probes; parent reader)`);
    return { verification: 'parent' };
  }
  log(`Project mirror parent read failed:\n${formatFailures([...sourceFailures, ...failures]).join('\n')}`);
  let consumerFailures = [];
  let consumerError;
  let attempt = 0;
  let repaired = false;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    // Retest the parent after a short bounded backoff before spawning anything.
    await delay(Math.min(100 * 2 ** Math.min(attempt, 3), Math.max(1, deadline - Date.now())), undefined, { signal });
    signal?.throwIfAborted();
    failures = readEntries(mirrorEntries);
    sourceFailures = readEntries(sourceEntries);
    state.mirrorFailures = failures;
    state.sourceFailures = sourceFailures;
    if (parentReaderReady(failures, sourceFailures)) {
      log(`Project mirror readiness verified (${probes.length} probes; parent reader after retry)`);
      return { verification: 'parent' };
    }
    log(
      `Project mirror recovery attempt ${attempt + 1}: parent mirror failures=${failures.length}, source failures=${sourceFailures.length}`,
    );
    if (!sourceFailures.length && !repaired && failures.length) {
      prepareProjectMirrors({ installRoot, projectDir, log, rebuildMirrors: failures.map(({ mirror }) => mirror) });
      repaired = true;
    }
    const remaining = deadline - Date.now();
    if (remaining > 0 && nodeExe) {
      const result = await probeConsumer({
        nodeExe,
        entries: [...sourceEntries, ...mirrorEntries],
        signal,
        remaining,
        attempt,
        log,
        onDiagnostic: state.observe,
      });
      consumerFailures = result.failures;
      consumerError = result.error;
      if (!consumerFailures.length && !consumerError) {
        log(
          `Project mirror readiness verified (${probes.length} probes; bundled Node consumer). Parent read remained unavailable; no ACL, configuration or history was changed.`,
        );
        return { verification: 'consumer' };
      }
    }
    attempt += 1;
  }
  throw readinessError({ sourceFailures, failures, consumerFailures, consumerError, nodeExe });
}

async function waitForProjectMirrors(options) {
  const state = { sourceFailures: [], mirrorFailures: [], consumerAttempts: [] };
  state.observe = (event) => {
    if (event.phase === 'settled') state.consumerAttempts.push(event);
    options.log?.(`Project mirror consumer diagnostic ${JSON.stringify(event)}`);
  };
  try {
    return await waitWithDiagnostics(options, state);
  } catch (error) {
    throw attachMirrorDiagnostics(error, state);
  }
}

module.exports = { PROJECT_MIRROR_PROBES, waitForProjectMirrors };
