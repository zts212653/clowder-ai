import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { prepareWindowsProviderHost } from '../dist/utils/windows-provider-host.js';

function startupFixture(reasons) {
  const starts = [];
  const spawnHost = () => {
    const previous = starts.at(-1);
    if (previous) assert.equal(previous.exitCode, 1, 'wait for the failed Host to exit before replacing it');
    assert.ok(starts.length < reasons.length, 'unexpected Host start');
    const reason = reasons[starts.length];
    const host = Object.assign(new EventEmitter(), {
      pid: 20 + starts.length,
      exitCode: null,
      signalCode: null,
      launches: [],
      kill() {
        setImmediate(() => {
          this.exitCode = 1;
          this.emit('exit', 1);
        });
        return true;
      },
      send(message) {
        this.launches.push(message);
      },
    });
    starts.push(host);
    setImmediate(() =>
      host.emit(
        'message',
        reason
          ? { type: 'failed', reason }
          : {
              type: 'ready',
              path: 'unused-owner-record.json',
              record: {
                v: 1,
                jobName: 'Local\\ClowderProviderJob-test',
                apiPid: host.pid,
                helperPid: 42,
                sessionId: 1,
                createdAt: 1,
                controller: { pid: process.pid, createdAt: '2026-11-27T10:00:00.0000000Z' },
              },
            },
      ),
    );
    return host;
  };
  return { spawnHost, starts };
}

test('a Windows Job helper timeout is retried once with a fresh, separately owned Host', async () => {
  const { spawnHost, starts } = startupFixture(['JOB_FAILED_TIMEOUT:stage=target_identity', null]);
  const ready = await prepareWindowsProviderHost({ spawnHost });

  assert.equal(starts.length, 2);
  assert.equal(ready.job.apiPid, starts[1].pid);
  ready.launch({ command: 'provider', args: [] });
  assert.equal(starts[0].launches.length, 0);
  assert.equal(starts[1].launches.length, 1);
});

test('a second timeout fails preparation without starting a provider or a third Host', async () => {
  const { spawnHost, starts } = startupFixture(['JOB_FAILED_TIMEOUT', 'JOB_FAILED_TIMEOUT:stage=membership']);
  await assert.rejects(prepareWindowsProviderHost({ spawnHost }), /JOB_FAILED_TIMEOUT:stage=membership/);

  assert.equal(starts.length, 2);
  assert.ok(starts.every((host) => host.launches.length === 0));
});

test('a failed Windows ownership check is never retried', async () => {
  const { spawnHost, starts } = startupFixture(['JOB_FAILED_NOT_OUR_PROCESS']);
  await assert.rejects(prepareWindowsProviderHost({ spawnHost }), /JOB_FAILED_NOT_OUR_PROCESS/);

  assert.equal(starts.length, 1);
  assert.equal(starts[0].launches.length, 0);
});
