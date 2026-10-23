const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { resolveExternalNodeEntry } = require('./subprocess-entry');
const { MARKER, MIRRORS } = require('./project-mirror-resource-state');

function runMaterialization({
  installRoot,
  projectDir,
  nodeExe,
  signal,
  mirrors,
  allowLink = false,
  budgetMs = 60000,
  log = () => {},
}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(nodeExe, [resolveExternalNodeEntry('project-mirror-materialization-worker.js')], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let failure;
    const stop = (error) => {
      failure ??= error;
      child.kill('SIGKILL');
    };
    const abort = () => stop(signal.reason ?? new Error('Managed resource recovery aborted'));
    const timer = setTimeout(
      () =>
        stop(
          Object.assign(new Error('Managed resource recovery timed out; its owned transaction is retained for retry'), {
            code: 'ETIMEDOUT',
          }),
        ),
      budgetMs + 1000,
    );
    signal?.addEventListener('abort', abort, { once: true });
    child.once('spawn', () =>
      log(`Project mirror materialization worker pid=${child.pid}, mirrors=${mirrors.join(',')}, budgetMs=${budgetMs}`),
    );
    child.once('error', (error) => {
      failure ??= error;
    });
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.length > 65536) stop(new Error('Invalid managed resource recovery output'));
    });
    child.stderr.resume();
    child.once('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (failure) return reject(failure);
      try {
        const result = JSON.parse(output);
        if (result.version !== 1) throw new Error('Invalid managed resource recovery protocol');
        if (result.error)
          throw Object.assign(new Error(`Managed resource recovery failed: ${result.error.message}`), {
            code: result.error.code,
            errno: result.error.errno,
            syscall: result.error.syscall,
          });
        if (code !== 0 || !Array.isArray(result.results)) throw new Error('Managed resource recovery worker failed');
        signal?.throwIfAborted();
        for (const entry of result.results) log(`Project mirror materialization ${JSON.stringify(entry)}`);
        resolve(result.results);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify({ installRoot, projectDir, mirrors, allowLink, budgetMs }));
    if (signal?.aborted) abort();
  });
}

async function refreshMaterializedMirrors(options) {
  const mirrors = [...MIRRORS].filter((mirror) => {
    try {
      const destination = path.join(options.projectDir, mirror);
      return !fs.lstatSync(destination).isSymbolicLink() && fs.existsSync(path.join(destination, MARKER));
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  });
  if (!mirrors.length && !fs.existsSync(path.join(options.projectDir, '.clowder-resource-transaction.json'))) return;
  await runMaterialization({ ...options, mirrors });
}

async function preparePhysicalMirrors(options) {
  const mirrors = [...MIRRORS].filter((mirror) => {
    const source = path.join(options.installRoot, mirror);
    const destination = path.join(options.projectDir, mirror);
    try {
      const bundled = fs.lstatSync(source);
      if (bundled.isSymbolicLink()) throw new Error(`Managed resource source contains a reparse entry: ${source}`);
      if (!bundled.isDirectory()) return false;
      const entry = fs.lstatSync(destination);
      // Unknown real directories remain owner data, including absent probes.
      return entry.isSymbolicLink();
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  });
  if (mirrors.length) await runMaterialization({ ...options, mirrors, allowLink: true });
}

async function materializeFailedMirrors(options, failures) {
  const mirrors = [...new Set(failures.filter((entry) => entry.kind === 'mirror').map((entry) => entry.mirror))];
  if (!mirrors.length || mirrors.some((mirror) => !MIRRORS.has(mirror))) return false;
  for (const mirror of mirrors) {
    const destination = path.join(options.projectDir, mirror);
    const entry = fs.lstatSync(destination);
    if (!entry.isSymbolicLink() && !fs.existsSync(path.join(destination, MARKER))) {
      options.log?.(`Preserving existing real resource directory without ownership: ${destination}`);
      return false;
    }
  }
  await runMaterialization({ ...options, mirrors, allowLink: true });
  return true;
}

module.exports = { runMaterialization, refreshMaterializedMirrors, preparePhysicalMirrors, materializeFailedMirrors };
