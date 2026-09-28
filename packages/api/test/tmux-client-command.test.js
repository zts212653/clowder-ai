import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execTmuxClientCommand } from '../dist/domains/terminal/tmux-client-command.js';

test('creation observers receive complete lines without promoting a partial PID or unfinished suffix', async () => {
  const lines = [];
  const { stdout } = await execTmuxClientCommand(
    process.execPath,
    ['-e', "process.stdout.write('%1 12');setTimeout(()=>process.stdout.write('345\\nincomplete'),30)"],
    { onStdoutLine: (line) => lines.push(line) },
  );
  assert.deepEqual(lines, ['%1 12345']);
  assert.equal(stdout, '%1 12345\nincomplete');
});

test('a setup client without a caller signal still has a deadline and is reaped', { timeout: 8000 }, async () => {
  await assert.rejects(
    execTmuxClientCommand(process.execPath, ['-e', 'console.log(process.pid);setInterval(()=>{},1000)']),
    (error) => {
      assert.equal(error.killed, true);
      const pid = Number(error.stdout.trim());
      assert.ok(pid > 0, 'the client must really have started');
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      return true;
    },
  );
});
