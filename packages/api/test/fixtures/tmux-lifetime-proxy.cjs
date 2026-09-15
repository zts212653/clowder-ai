const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync, unlinkSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const config = JSON.parse(readFileSync(join(__dirname, 'control.json'), 'utf8'));
const args = process.argv.slice(2);
if (args[0] !== '-L' || args[1] !== config.socket) throw new Error('Unexpected fixture socket');
const forward = () => spawnSync(config.bin, args, { encoding: 'utf8' });

function replaceServer() {
  const stop = spawnSync(config.bin, ['-L', config.socket, 'kill-server']);
  if (stop.status !== 0) throw new Error('Fixture could not replace its own server');
  const command = `printf ready > ${quote(config.ready)}; while [ ! -f ${quote(config.release)} ]; do sleep .02; done; printf done > ${quote(config.done)}; sleep 30`;
  const start = spawnSync(config.bin, ['-L', config.socket, 'new-session', '-d', '/bin/sh', '-c', command]);
  if (start.status !== 0) throw new Error('Fixture successor failed to start');
  const deadline = Date.now() + 5000;
  while (!existsSync(config.ready) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  if (!existsSync(config.ready)) throw new Error('Fixture successor did not execute');
  writeFileSync(config.witness, 'recycled');
}

function run() {
  let result;
  if (existsSync(config.armed)) {
    unlinkSync(config.armed);
    const separateRead = ['display-message', 'list-panes', 'show-options'].includes(args[2]);
    if (separateRead) result = forward();
    replaceServer();
    if (!separateRead) result = forward();
  } else {
    result = forward();
  }
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  process.exit(result.status ?? 1);
}
const quote = (value) => `'${value.replace(/'/g, "'\"'\"'")}'`;
run();
