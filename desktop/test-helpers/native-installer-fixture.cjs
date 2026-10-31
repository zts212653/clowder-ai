const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');

function retainFailure(root, error) {
  fs.writeFileSync(path.join(root, 'fixture-failure.txt'), error.stack || String(error));
  const evidence = process.env.CAT_CAFE_NATIVE_INSTALLER_EVIDENCE_DIR;
  if (!evidence) return;
  fs.mkdirSync(evidence, { recursive: true });
  fs.cpSync(root, path.join(evidence, path.basename(root)), {
    recursive: true,
    filter: (entry) => fs.statSync(entry).isDirectory() || /\.(log|json|iss|ps1|txt)$/.test(entry),
  });
}

async function withTempRoot(prefix, run, { remove = fs.rmSync } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  let failure;
  try {
    await run(root);
  } catch (error) {
    failure = error;
    try {
      retainFailure(root, error);
    } catch (evidenceError) {
      failure = new AggregateError([error, evidenceError], 'Fixture and evidence capture failed', { cause: error });
    }
  }
  try {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.match(path.basename(root), new RegExp(`^${prefix}`));
    // Windows may briefly retain handles after the owned process tree exits.
    remove(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
  } catch (cleanupError) {
    if (failure) {
      throw new AggregateError([failure, cleanupError], `${failure.message}; cleanup failed: ${root}`, {
        cause: failure,
      });
    }
    throw cleanupError;
  }
  if (failure) throw failure;
}

function terminateOwnedTree(pid) {
  if (process.platform === 'win32') {
    const stopped = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });
    if (stopped.error || stopped.status !== 0) {
      return stopped.error || new Error(stopped.stdout + stopped.stderr);
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') return error;
    }
  }
}

async function runNativeCommand(root, phase, command, args, { timeoutMs = 30000 } = {}) {
  const child = spawn(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let launchError;
  let cleanupError;
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk;
  });
  const result = await new Promise((resolve) => {
    let settled = false;
    let cleanupTimer;
    const finish = (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      resolve({ status, signal, pid: child.pid, stdout, stderr, timedOut });
    };
    child.on('error', (error) => {
      launchError = error;
    });
    child.on('close', finish);
    const timer = setTimeout(() => {
      timedOut = true;
      // Do this before killing the launcher: Setup has a separate .tmp child.
      cleanupError = terminateOwnedTree(child.pid);
      cleanupTimer = setTimeout(() => {
        cleanupError ||= new Error('Owned process close was not observed after termination');
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish(null, null);
      }, 5000);
    }, timeoutMs);
  });
  fs.writeFileSync(
    path.join(root, `${phase}-process.json`),
    JSON.stringify(
      {
        ...result,
        timeoutMs,
        launchError: launchError?.message,
        cleanupError: cleanupError?.message,
      },
      null,
      2,
    ),
  );
  if (timedOut || launchError || cleanupError) {
    const log = path.join(root, 'setup.log');
    const recorded = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '(no setup log)';
    const error = new Error(
      `${phase} ${timedOut ? 'timed out' : 'failed to execute'} after budget ${timeoutMs}ms\n` +
        `${stdout}\n${stderr}\n${recorded}\n${cleanupError?.message || ''}`,
      { cause: launchError || cleanupError },
    );
    error.pid = child.pid;
    error.result = result;
    error.cleanupError = cleanupError;
    throw error;
  }
  return result;
}

module.exports = { withTempRoot, runNativeCommand };
