const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const {
  safeFilesystemFields,
  parseConsumerOutcome,
  consumerFailureError,
  createConsumerDiagnosticEmitter,
} = require('./project-mirror-diagnostics');

// Inline the static worker: Electron may load this module from app.asar, while
// the bundled Node consumer cannot execute a script inside Electron's archive.
const WORKER = `
const fs = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const entries = JSON.parse(input);
    const failures = [];
    for (const entry of entries) {
      try { fs.readFileSync(entry.path); }
      catch (error) {
        failures.push({ ...entry, code: error.code, errno: error.errno, syscall: error.syscall });
      }
    }
    process.stdout.write(JSON.stringify({ version: 1, failures }));
  } catch (error) {
    process.stderr.write('Invalid project mirror worker input');
    process.exitCode = 1;
  }
});
`;

/** Read using the actual API executable and inherited user token; settle after close. */
function readProjectMirrorsInConsumer({
  nodeExe,
  entries,
  signal,
  timeoutMs = 1000,
  onSpawn = () => {},
  attempt = 1,
  onDiagnostic = () => {},
}) {
  signal?.throwIfAborted();
  const emit = createConsumerDiagnosticEmitter({
    nodeExe,
    attempt,
    budgetMs: Math.max(1, timeoutMs),
    entryCount: entries.length,
    onDiagnostic,
  });
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(nodeExe, ['-e', WORKER], {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      emit('started', 'spawn_pending');
      const event = emit('settled', 'spawn_failed', { error });
      reject(
        Object.assign(new Error('Project mirror consumer failed to spawn'), safeFilesystemFields(error), {
          projectMirrorConsumer: event,
        }),
      );
      return;
    }
    let output = '';
    const decoder = new StringDecoder('utf8');
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure;
    let status;
    let stopped = false;
    const stop = (error, reason) => {
      if (stopped) return;
      stopped = true;
      failure = error;
      status = reason;
      // This read-only probe owns no durable state. A handler installed by a
      // preload must not turn cancellation into an unbounded startup wait.
      child.kill('SIGKILL');
    };
    const abort = () => stop(signal.reason ?? new Error('Project mirror consumer aborted'), 'aborted');
    const timer = setTimeout(
      () =>
        stop(
          Object.assign(new Error('Project mirror consumer timed out'), {
            code: 'ETIMEDOUT',
            syscall: 'read',
          }),
          'timed_out',
        ),
      Math.max(1, timeoutMs),
    );
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', (error) => {
      failure ??= error;
      status ??= 'spawn_failed';
    });
    child.once('spawn', () => {
      try {
        onSpawn(child.pid);
      } catch {
        /* Diagnostics cannot strand the child. */
      }
    });
    child.stdin.on('error', () => {}); // EPIPE is reported by process error/close.
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > 64 * 1024) {
        stop(
          Object.assign(new Error('Project mirror consumer returned oversized diagnostics'), {
            code: 'INVALID_OUTPUT',
          }),
          'invalid_output',
        );
      } else output += decoder.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
    });
    child.once('close', (code, closeSignal) => {
      output += decoder.end();
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      const outcome = parseConsumerOutcome({ failure, status, code, output, entries });
      const event = emit('settled', outcome.status, {
        pid: child.pid,
        exitCode: code,
        signal: closeSignal,
        stdoutBytes,
        stderrBytes,
        failures: outcome.failures,
        error: outcome.failure,
      });
      if (outcome.failure) return reject(consumerFailureError({ ...outcome, code, event }));
      resolve(outcome.failures);
    });
    emit('started', child.pid ? 'spawned' : 'spawn_pending', { pid: child.pid });
    child.stdin.end(JSON.stringify(entries));
    if (signal?.aborted) abort();
  });
}

module.exports = { readProjectMirrorsInConsumer };
