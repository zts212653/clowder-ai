import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveNamedAlphaCoordinates } from './alpha-coordinates.mjs';
import { NAMED_ALPHA_PORTS, namedAlphaFixture } from './alpha-named-fixture.mjs';
import { PROCESS_START_TIME_FORMAT } from './process-identity.mjs';

export function redisFixture(t) {
  const f = namedAlphaFixture(t);
  f.preparedBuilds();
  const coordinates = deriveNamedAlphaCoordinates({
    mainRoot: f.mainRoot,
    instance: 'f290-communication',
    ports: NAMED_ALPHA_PORTS,
    targetSha: f.head,
  });
  const raw = JSON.stringify(coordinates);
  const dataDirectory = join(f.alphaRoot, '.cat-cafe/redis');
  mkdirSync(dataDirectory, { recursive: true });
  const pidFile = join(dataDirectory, 'redis-15397.pid');
  writeFileSync(pidFile, '41021\n');
  // Explicit OS metadata fixture; production uses canonical process-identity, never Redis INFO.
  const identity = {
    startedAt: 'Wed Sep 30 20:00:00 2026',
    startedAtEpochMs: 1790798400000,
    startedAtFormat: PROCESS_START_TIME_FORMAT,
    command: 'redis-server 127.0.0.1:15397',
    ucomm: 'redis-server',
    argvAvailable: true,
    cwd: dataDirectory,
  };
  const deps = { readListeners: () => [41021], capture: () => identity };
  return { f, raw, pidFile, identity, deps };
}
