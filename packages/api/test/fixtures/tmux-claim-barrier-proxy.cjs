const { spawnSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const config = JSON.parse(readFileSync(join(__dirname, 'control.json'), 'utf8'));
const args = process.argv.slice(2);
if (args[0] !== '-L' || args[1] !== config.socket) throw new Error('Unexpected fixture socket');
const creation = args.includes('new-session') || args.includes('new-window');
let gate;
if (creation) {
  const index = args.findIndex((arg) => arg.startsWith("const {symlinkSync}=require('node:fs')"));
  if (index < 0) throw new Error('The production claim publisher must be present');
  gate = args[index + 1];
  const barrier = `require('node:fs').writeFileSync(${JSON.stringify(config.barrier)},process.argv[1]);
    const stopAt=Date.now()+8000;
    while(!require('node:fs').existsSync(${JSON.stringify(config.release)})) {
      if(Date.now()>stopAt) throw new Error('claim fixture release timeout');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
    }`;
  if (config.mode === 'before-claim') args[index] = `${barrier}\n${args[index]}`;
  if (config.mode === 'successor-race') {
    args[index] = args[index].replace(
      "if(error.code==='EEXIST') return;",
      `if(error.code==='EEXIST') {${barrier}\nreturn;}`,
    );
  }
}
const result = spawnSync(config.bin, args, { encoding: 'utf8' });
const finish = () => {
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  process.exitCode = result.status ?? 1;
};
if (creation && result.status === 0) {
  const [paneId, panePid] = result.stdout.trim().split(' ');
  writeFileSync(config.witness, JSON.stringify({ paneId, panePid, gate, clientPid: process.pid }));
  if (config.mode !== 'normal') setTimeout(finish, 22000);
  else finish();
} else finish();
