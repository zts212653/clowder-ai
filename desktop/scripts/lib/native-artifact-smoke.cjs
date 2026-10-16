// Evaluated by the bundled Node with native-artifact-guard.cjs preloaded.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const api = fs.realpathSync(process.argv[1]);
const requireApi = createRequire(path.join(api, 'package.json'));
const audit = globalThis.clowderNativeArtifactAudit;

async function checkPty() {
  const entry = requireApi.resolve('node-pty');
  const pty = requireApi('node-pty');
  if (process.platform === 'win32') {
    // This cleanup helper is otherwise deferred until kill(). Load its actual
    // ABI here as well as exercising conpty/worker helpers via a real spawn.
    requireApi(path.join(path.dirname(entry), 'utils.js')).loadNativeModule('conpty_console_list');
  }
  await new Promise((resolve, reject) => {
    let terminal;
    let output = '';
    const timer = setTimeout(() => {
      terminal.kill();
      reject(new Error('Native PTY smoke timed out'));
    }, 10000);
    try {
      terminal = pty.spawn(process.execPath, ['-e', 'process.stdout.write("CLOWDER_PTY_OK");'], {
        cwd: api,
        env: process.env,
        cols: 80,
        rows: 24,
        name: 'xterm',
      });
      terminal.onData((data) => {
        output += data;
      });
      terminal.onExit(({ exitCode }) => {
        clearTimeout(timer);
        // Windows natural exit closes the output socket but leaves node-pty's
        // conout worker alive. Its public kill() disposes this owned session,
        // drains/terminates the worker and exercises the cleanup helper.
        if (process.platform === 'win32') terminal.kill();
        if (exitCode === 0 && output.includes('CLOWDER_PTY_OK')) resolve();
        else reject(new Error(`Native PTY smoke failed: exit=${exitCode}, output=${output}`));
      });
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
  console.log('native-pty: spawned bundled Node, marker received, exited');
}

async function smoke() {
  const db = new (requireApi('better-sqlite3'))(':memory:');
  try {
    const vec = requireApi('sqlite-vec');
    // SQLite loads an extension directly, bypassing process.dlopen.
    db.loadExtension(audit.artifactPath(vec.getLoadablePath()));
    console.log('sqlite/vec:', db.prepare('select vec_version() as v').get().v);
    // Capture the extension's linker dependencies while it is loaded; closing
    // SQLite may unload them before the final whole-smoke audit.
    audit.assertComplete();
  } finally {
    db.close();
  }
  await requireApi('sharp')({ create: { width: 1, height: 1, channels: 3, background: 'white' } })
    .png()
    .toBuffer();
  await checkPty();
  audit.assertComplete();
  console.log('native-smoke: OK');
}

smoke().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
