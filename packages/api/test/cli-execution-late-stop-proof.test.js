import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createCliExecutionOwnerService, readCliProcessOwnerRecords } from '../dist/utils/cli-process-ownership.js';

for (const mode of ['root', 'sibling', 'unrelated'])
  test(`a known ${mode} published during the final OS read vetoes stopped proof`, async () => {
    const parent = resolve('artifacts/role-agent-refactor/late-stop-proof');
    await mkdir(parent, { recursive: true });
    const dataDir = await mkdtemp(join(parent, 'owned-'));
    const ownerDir = join(dataDir, 'cli-process-owners');
    await mkdir(ownerDir);
    const execution = {
      executionId: 'late-parent',
      invocationId: 'late-child',
      threadId: 'late-thread',
      catId: 'codex',
      userId: 'late-user',
    };
    const supervisor = { pid: 424242, ppid: 1, pgid: 424242, startedAt: 'Wed Aug 13 01:00:00 2026' };
    const late = { ...supervisor, pid: 424243, ppid: supervisor.pid };
    const ownerId = '12345678-1234-4234-8234-123456789abc';
    const original = { v: 1, ownerId, createdAt: 1000, supervisor, execution };
    await writeFile(join(ownerDir, `${ownerId}.json`), JSON.stringify(original));
    let signaled = false,
      published = false;
    const reads = [];
    const service = createCliExecutionOwnerService({
      dataDir,
      kill: () => {
        signaled = true;
      },
      readProcessSnapshot: async ({ pids }) => {
        reads.push(pids);
        if (!signaled) return new Map([[supervisor.pid, supervisor]]);
        if (!published) {
          // The real reader awaits OS I/O; manifest writers can run in that window.
          await Promise.resolve();
          published = true;
          if (mode === 'root') {
            await writeFile(join(ownerDir, `${ownerId}.json`), JSON.stringify({ ...original, root: late }));
          } else {
            const siblingId = '22345678-1234-4234-8234-123456789abc';
            await writeFile(
              join(ownerDir, `${siblingId}.json`),
              JSON.stringify({
                ...original,
                ownerId: siblingId,
                supervisor: late,
                execution: {
                  ...execution,
                  invocationId: 'late-sibling',
                  ...(mode === 'unrelated' ? { executionId: 'another-parent', threadId: 'another-thread' } : {}),
                },
              }),
            );
          }
        }
        // Original supervisor has exited; the newly registered identity remains alive.
        return new Map(pids.includes(late.pid) ? [[late.pid, late]] : []);
      },
    });
    const result = await service.terminateExact(execution);
    const records = readCliProcessOwnerRecords(dataDir);
    const live = await service.listLive();
    assert.equal(records.invalidPaths.length, 0);
    assert.equal(
      records.records.some(({ manifest }) =>
        mode === 'root' ? manifest.root?.pid === late.pid : manifest.supervisor.pid === late.pid,
      ),
      true,
    );
    const evidence = { mode, result, reads, records, live, stillAlive: late, noOsProcessCreated: true };
    await writeFile(join(dataDir, 'evidence.json'), JSON.stringify(evidence, null, 2));
    assert.equal(
      result.stopped,
      mode === 'unrelated',
      'only a changed identity in this exact scope vetoes the observed stop',
    );
  });
