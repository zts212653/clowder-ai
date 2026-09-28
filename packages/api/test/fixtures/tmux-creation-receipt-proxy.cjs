const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const config = JSON.parse(readFileSync(join(__dirname, 'control.json'), 'utf8'));
const args = process.argv.slice(2);
if (args[0] !== '-L' || args[1] !== config.socket) throw new Error('Unexpected fixture socket');
const result = spawnSync(config.bin, args, { encoding: 'utf8' });
const creation = args.includes('new-session') || args.includes('new-window');
if (creation && result.status === 0) {
  const deadline = Date.now() + 5000;
  while (!existsSync(config.ready) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  if (!existsSync(config.ready)) throw new Error('The real agent did not start');
  const paneId = result.stdout.trim().split(' ')[0];
  const state = spawnSync(
    config.bin,
    ['-L', config.socket, 'list-panes', '-a', '-F', '#{pane_id} #{pane_pid} #{pane_dead} #{pane_start_command}'],
    { encoding: 'utf8' },
  );
  if (state.status !== 0) throw new Error('Could not witness the created pane');
  writeFileSync(config.witness, JSON.stringify({ paneId, state: state.stdout }));
  if (config.rename) {
    const renamed = spawnSync(config.bin, ['-L', config.socket, 'rename-window', '-t', paneId, 'changed-display-name']);
    if (renamed.status !== 0) throw new Error('Could not rename the created window');
  }
  process.stdout.write(config.receipt);
  process.exit(config.exitCode);
}
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
process.exit(result.status ?? 1);
