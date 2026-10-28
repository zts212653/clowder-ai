import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureNamedAlphaRedisIdentity } from './alpha-redis-process.mjs';
import { redisFixture } from './alpha-redis-process-test-fixture.mjs';
import { previewProcessRecordId } from './preview-process-record-key.mjs';

export function failedAlphaFixture(t) {
  const { f, raw, deps, identity } = redisFixture(t);
  const coordinates = JSON.parse(raw);
  const proof = captureNamedAlphaRedisIdentity(raw, deps);
  const stateDir = join(f.directory, 'preview-state');
  const registryDir = join(f.directory, 'leases');
  mkdirSync(stateDir);
  mkdirSync(registryDir);
  const id = previewProcessRecordId(f.mainRoot, coordinates.ports.frontend);
  const config = {
    cwd: f.mainRoot,
    port: coordinates.ports.frontend,
    id,
    stateDir,
    recordPath: join(stateDir, `${id}.json`),
  };
  const record = {
    version: 1,
    id,
    cwd: f.mainRoot,
    port: config.port,
    command: [
      'pnpm',
      'alpha:start',
      '--',
      '--instance',
      coordinates.instance,
      '--ports',
      Object.values(coordinates.ports).join(','),
    ],
    origin: 'detached',
    pid: 900000001,
    processStartedAt: 'Wed Sep 30 19:59:50 2026',
    processCommand: 'original fixture supervisor',
    startedAt: '2026-09-30T19:59:50.000Z',
    expiresAt: '2026-10-01T03:59:50.000Z',
    completionPath: join(stateDir, `${id}.11111111-1111-4111-8111-111111111111.completion.json`),
  };
  const completion = {
    pid: record.pid,
    expiresAt: record.expiresAt,
    exitCode: 1,
    forced: false,
    cleanupOwnerStatus: 'complete',
    completedAt: '2026-09-30T20:01:00.000Z',
  };
  const owner = { pid: 900000002, processGroupId: 900000003, exitCode: 1 };
  const lease = {
    version: 1,
    kind: 'named-alpha',
    coordinates,
    owner: {
      pid: owner.pid,
      process: {
        ...identity,
        startedAt: 'Wed Sep 30 19:59:55 2026',
        startedAtEpochMs: identity.startedAtEpochMs - 5000,
        ucomm: 'bash',
        command: `bash ${join(f.alphaRoot, 'scripts/start-dev.sh')} --quick`,
        cwd: f.alphaRoot,
      },
    },
    redis: proof,
    createdAt: '2026-09-30T20:00:01.000Z',
    expiresAt: record.expiresAt,
  };
  const leaseFile = join(registryDir, `redis-${proof.port}-${proof.pid}-${owner.pid}.json`);
  const dumpFile = join(proof.dataDirectory, 'dump.rdb');
  const rdb = Buffer.concat([Buffer.from('REDIS0012'), Buffer.from([255]), Buffer.alloc(8)]);
  writeFileSync(dumpFile, rdb);
  const write = (path, data) => writeFileSync(path, `${JSON.stringify(data)}\n`);
  write(config.recordPath, record);
  write(record.completionPath, completion);
  write(`${record.completionPath}.owner.json`, owner);
  write(leaseFile, lease);
  const originalCompletion = readFileSync(record.completionPath);
  const originalOwner = readFileSync(`${record.completionPath}.owner.json`);
  const calls = [];
  let listening = true;
  const recovery = {
    registryDir,
    isRunning: (pid) => listening && pid === proof.pid,
    groupRunning: () => false,
    readListeners: (port) => (port === proof.port && listening ? [proof.pid] : []),
    capture: () => identity,
    run: (program, args) => {
      assert.equal(program, 'redis-cli');
      calls.push(args);
      const command = args.slice(6);
      if (command.join(' ') === 'config get dir') return `dir\n${proof.dataDirectory}\n`;
      if (command.join(' ') === 'config get dbfilename') return 'dbfilename\ndump.rdb\n';
      if (command.join(' ') === 'dbsize') return '1\n';
      assert.deepEqual(command, ['shutdown', 'save']);
      listening = false;
      return '';
    },
  };
  return {
    ...f,
    config,
    record,
    completion,
    owner,
    lease,
    leaseFile,
    proof,
    dumpFile,
    originalCompletion,
    originalOwner,
    calls,
    recovery,
    write,
  };
}
