import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { NodeExternalPluginProcessAdapter } from '../dist/domains/plugin/external-runtime/index.js';

async function readLine(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const onData = (chunk) => {
      chunks.push(Buffer.from(chunk));
      const combined = Buffer.concat(chunks);
      const newline = combined.indexOf(0x0a);
      if (newline === -1) return;
      cleanup();
      resolve(combined.subarray(0, newline).toString('utf8'));
    };
    const cleanup = () => {
      stream.off('data', onData);
      stream.off('error', onError);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    stream.on('data', onData);
    stream.on('error', onError);
  });
}

test('Node process adapter starts without a shell, inherits no ambient env, and terminates the process group', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'cat-cafe-k2d-process-'));
  const script = join(rootDir, 'plugin.mjs');
  await writeFile(
    script,
    'process.stdout.write(JSON.stringify(process.env) + "\\n"); setInterval(() => {}, 1_000);\n',
    'utf8',
  );
  const adapter = new NodeExternalPluginProcessAdapter(100);
  const child = await adapter.spawn({
    command: process.execPath,
    args: [script],
    cwd: rootDir,
    env: {
      CLOWDER_PLUGIN_ID: 'official.external-source',
      CLOWDER_PACKAGE_DIGEST: 'sha512-test',
      CLOWDER_CONTRACT_VERSION: '0.1.0',
      CLOWDER_WIRE_VERSION: '0.1.0',
    },
  });
  try {
    const childEnvironment = JSON.parse(await readLine(child.stdout));
    const clowderKeys = Object.keys(childEnvironment)
      .filter((key) => key.startsWith('CLOWDER_'))
      .sort();
    assert.deepEqual(clowderKeys, [
      'CLOWDER_CONTRACT_VERSION',
      'CLOWDER_PACKAGE_DIGEST',
      'CLOWDER_PLUGIN_ID',
      'CLOWDER_WIRE_VERSION',
    ]);
    assert.equal('NPM_TOKEN' in childEnvironment, false);
    assert.equal('REDIS_URL' in childEnvironment, false);
    assert.equal('PATH' in childEnvironment, false);
    assert.deepEqual(
      Object.keys(childEnvironment).filter((key) => !key.startsWith('CLOWDER_') && key !== '__CF_USER_TEXT_ENCODING'),
      [],
    );
  } finally {
    await child.terminate();
  }
  const exit = await child.exited;
  assert.equal(exit.code, null);
  assert.equal(exit.signal, 'SIGTERM');
});

test('Node process adapter retains only a recognized structured runtime diagnostic', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'cat-cafe-k2d-diagnostic-'));
  const script = join(rootDir, 'plugin.mjs');
  await writeFile(
    script,
    [
      "process.stderr.write('secret remote path must not persist\\n');",
      `process.stderr.write('${JSON.stringify({
        kind: 'clowder.plugin.runtime-error',
        v: 1,
        code: 'EVENT_BUS_CONFLICT',
      })}\\n');`,
      'process.exit(17);',
    ].join(' '),
    'utf8',
  );
  const adapter = new NodeExternalPluginProcessAdapter();
  const child = await adapter.spawn({
    command: process.execPath,
    args: [script],
    cwd: rootDir,
    env: {
      CLOWDER_PLUGIN_ID: 'official.external-source',
      CLOWDER_PACKAGE_DIGEST: 'sha512-test',
      CLOWDER_CONTRACT_VERSION: '0.1.0',
      CLOWDER_WIRE_VERSION: '0.1.0',
    },
  });

  assert.deepEqual(await child.exited, {
    code: 17,
    signal: null,
    diagnostic: { code: 'EVENT_BUS_CONFLICT' },
  });
});

test('Node process adapter preserves a diagnostic before oversized noise in the same stderr chunk', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'cat-cafe-k2d-coalesced-diagnostic-'));
  const script = join(rootDir, 'plugin.mjs');
  const diagnostic = JSON.stringify({
    kind: 'clowder.plugin.runtime-error',
    v: 1,
    code: 'EVENT_BUS_CONFLICT',
  });
  await writeFile(
    script,
    `process.stderr.write(${JSON.stringify(`${diagnostic}\n`)} + 'x'.repeat(600) + '\\n'); process.exit(17);\n`,
    'utf8',
  );
  const adapter = new NodeExternalPluginProcessAdapter();
  const child = await adapter.spawn({
    command: process.execPath,
    args: [script],
    cwd: rootDir,
    env: {
      CLOWDER_PLUGIN_ID: 'official.external-source',
      CLOWDER_PACKAGE_DIGEST: 'sha512-test',
      CLOWDER_CONTRACT_VERSION: '0.1.0',
      CLOWDER_WIRE_VERSION: '0.1.0',
    },
  });

  assert.deepEqual(await child.exited, {
    code: 17,
    signal: null,
    diagnostic: { code: 'EVENT_BUS_CONFLICT' },
  });
});
