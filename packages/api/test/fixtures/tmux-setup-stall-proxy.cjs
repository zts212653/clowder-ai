const { spawnSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');

const config = JSON.parse(readFileSync(join(__dirname, 'control.json'), 'utf8'));
const args = process.argv.slice(2);
if (args[0] !== '-L' || args[1] !== config.socket) throw new Error('Unexpected test socket');
const result = spawnSync(config.bin, args, { encoding: 'utf8' });
const finish = () => {
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  process.exitCode = result.status ?? 1;
};
if (config.stage === 'discovery' && args[2] === 'list-sessions') {
  writeFileSync(config.witness, JSON.stringify({ clientPid: process.pid }));
  setTimeout(finish, 22000);
} else if (result.status === 0 && (args.includes('new-session') || args.includes('new-window'))) {
  const pane = result.stdout.trim().split(' ')[0];
  const state = spawnSync(
    config.bin,
    ['-L', config.socket, 'list-panes', '-a', '-F', '#{pane_id} #{pane_pid} #{pane_dead} #{pane_start_command}'],
    { encoding: 'utf8' },
  );
  if (state.status !== 0) throw new Error('Could not observe the real creation');
  writeFileSync(
    config.witness,
    JSON.stringify({
      clientPid: process.pid,
      pane,
      state: state.stdout,
      directory: dirname(args.find((arg) => arg.endsWith('/launch.sh'))),
    }),
  );
  // Deliberately withhold the successful creation receipt. Never stall rollback.
  setTimeout(finish, 22000);
} else {
  finish();
}
