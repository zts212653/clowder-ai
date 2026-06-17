import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { findStaleDevProcesses } from './cleanup-stale-dev-processes.mjs';

describe('cleanup-stale-dev-processes Redis sanctuary guard', () => {
  it('does not mark production Redis port 6099 as stale cleanup target', () => {
    const findings = findStaleDevProcesses([
      {
        pid: 100,
        ppid: 1,
        pgid: 100,
        sess: 100,
        elapsed: '01:00:00',
        elapsedSeconds: 3600,
        rssKb: 4096,
        command: 'redis-server 127.0.0.1:6099',
      },
    ]);

    assert.deepEqual(findings, []);
  });

  it('still marks non-sanctuary orphan Redis as stale cleanup target', () => {
    const findings = findStaleDevProcesses([
      {
        pid: 101,
        ppid: 1,
        pgid: 101,
        sess: 101,
        elapsed: '01:00:00',
        elapsedSeconds: 3600,
        rssKb: 4096,
        command: 'redis-server 127.0.0.1:63552',
      },
    ]);

    assert.equal(findings.length, 1);
    assert.equal(findings[0].pid, 101);
  });
});
