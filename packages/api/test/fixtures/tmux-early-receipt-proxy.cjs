const { spawn, spawnSync } = require('node:child_process');
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { publishWitness } = require('./atomic-witness.cjs');

const config = JSON.parse(readFileSync(join(__dirname, 'control.json'), 'utf8'));
const args = process.argv.slice(2);
const command = args[2];
if (args[0] !== '-L' || args[1] !== config.socket) throw new Error('Unexpected fixture socket');
if (!args.includes('new-session') && !args.includes('new-window')) {
  if (config.queryEntered && ['list-panes', 'list-sessions'].includes(args[2]) && existsSync(config.witness)) {
    const witness = JSON.parse(readFileSync(config.witness, 'utf8'));
    if (!existsSync(witness.gate)) {
      args.splice(2, 0, 'run-shell', `touch '${config.queryEntered}'`, ';', 'wait-for', 'diagnosis-release-query', ';');
    }
  }
  const result = spawnSync(config.bin, args, { encoding: 'utf8' });
  if (config.trace && ['list-panes', 'list-sessions'].includes(command)) {
    appendFileSync(
      config.trace,
      `${JSON.stringify({ at: Date.now(), command, status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, error: result.error?.message })}\n`,
    );
  }
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  process.exit(result.status ?? 1);
}

const index = args.findIndex((arg) => arg.startsWith("const {symlinkSync}=require('node:fs')"));
if (index < 0) throw new Error('The production claim publisher must be present');
const gate = args[index + 1];
args[index] =
  `require(${JSON.stringify(join(__dirname, 'atomic-witness.cjs'))}).publishWitness(${JSON.stringify(config.barrier)},process.argv[1]);
const stopAt=Date.now()+8000;
while(!require('node:fs').existsSync(${JSON.stringify(config.release)})) {
  if(Date.now()>stopAt) throw new Error('early receipt fixture release timeout');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
}
${args[index]}`;

// Forward native stdout as it arrives. A spawnSync proxy would hide the early
// receipt and fail to exercise the parent's receipt-present/empty-gate state.
const child = spawn(config.bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
let receipt = '';
child.stdout.on('data', (chunk) => {
  receipt += chunk.toString();
  process.stdout.write(chunk, () => {
    if (!receipt.includes('\n')) return;
    const [paneId, panePid] = receipt.trim().split(' ');
    publishWitness(config.witness, { paneId, panePid, gate, clientPid: process.pid, receipt });
  });
});
child.stderr.on('data', (chunk) => process.stderr.write(chunk));
child.on('error', (error) => {
  throw error;
});
child.on('close', (code) => {
  writeFileSync(config.clientClosed, '');
  if (code !== 0) process.exit(code ?? 1);
  setTimeout(() => process.exit(0), 22000);
});
