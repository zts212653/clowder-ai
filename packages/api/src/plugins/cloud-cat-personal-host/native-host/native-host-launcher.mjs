#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDirectory = dirname(fileURLToPath(import.meta.url));
const pairingRecordPath = join(rootDirectory, 'pairing.json');

async function launch() {
  const record = JSON.parse(await readFile(pairingRecordPath, 'utf8'));
  if (typeof record?.artifactDigest !== 'string' || !/^sha512:[a-f0-9]{128}$/.test(record.artifactDigest)) {
    throw new Error('pairing record has an invalid artifact digest');
  }
  const artifactEntrypoint = join(
    rootDirectory,
    'artifacts',
    record.artifactDigest.slice('sha512:'.length),
    'native-host.mjs',
  );
  const { runNativeHost } = await import(pathToFileURL(artifactEntrypoint).href);
  await runNativeHost({ pairingRecordPath });
}

launch().catch((error) => {
  process.stderr.write(
    `personal Chrome native host launcher failed: ${error instanceof Error ? error.message : 'unknown'}\n`,
  );
  process.exitCode = 1;
});
