import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

const originalGetuid = process.getuid;
before(() => {
  if (!originalGetuid) process.getuid = () => 1000;
});
after(() => {
  if (!originalGetuid) delete process.getuid;
});

import { scanGateJobProcesses } from '../../../scripts/lib/gate-job-processes.mjs';

const pid = 424242;
const token = 'terminal-proof-token';
const deny = () => Object.assign(new Error('private-secret'), { code: 'EACCES' });
const stat = (state = 'Z', birth = '12345', threads = 1, id = pid) => {
  const fields = Array(20).fill('0');
  fields[0] = state;
  fields[17] = String(threads);
  fields[19] = birth;
  return `${id} (name with ) parentheses) ${fields.join(' ')}`;
};
function scan({
  before = stat(),
  after = stat(),
  last = after,
  task = stat(),
  tasks = [String(pid)],
  taskError = false,
  mixed = false,
} = {}) {
  let reads = 0;
  return scanGateJobProcesses(token, {
    platform: 'linux',
    execFileSyncImpl: () => (mixed ? `${pid}\n424243\n` : `${pid}\n`),
    readdirSyncImpl: (path) => {
      if (path === '/proc') return [];
      if (taskError) throw deny();
      return tasks;
    },
    readFileSyncImpl: (path) => {
      if (path === `/proc/${pid}/stat`) return [before, after, last][Math.min(reads++, 2)];
      if (path === `/proc/${pid}/task/${pid}/stat`) return task;
      throw deny();
    },
  });
}
test('fully terminal same-birth single-thread execution can be excluded after denied environ', () => {
  const result = scan();
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.processes, []);
});
for (const [label, options] of [
  ['live process', { before: stat('S'), after: stat('S') }],
  ['zombie leader with live worker', { before: stat('Z', '12345', 2), tasks: [String(pid), '424244'] }],
  ['missing task directory', { taskError: true }],
  ['empty task directory', { tasks: [] }],
  ['live leader thread', { task: stat('S') }],
  ['changed birth at denial', { after: stat('Z', '54321') }],
  ['changed birth after enumeration', { last: stat('Z', '54321') }],
  ['changed thread birth', { task: stat('Z', '54321') }],
  ['invalid state', { after: stat('?') }],
  ['malformed identity', { before: 'invalid' }],
  ['mismatched pid', { task: stat('Z', '12345', 1, 424244) }],
  ['another unreadable process', { mixed: true }],
])
  test(`${label} remains unknown`, () => {
    const result = scan(options);
    assert.equal(result.status, 'unknown');
    assert.equal(result.failure.code, 'EACCES');
    assert.ok(!JSON.stringify(result).includes('private-secret'));
  });

test('live-to-terminal transition requires the same birth and complete sole task', () => {
  assert.equal(scan({ before: stat('S') }).status, 'ok');
});
