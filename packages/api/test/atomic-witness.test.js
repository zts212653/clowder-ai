import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { publishWitness } from './fixtures/atomic-witness.cjs';

const HELPER = fileURLToPath(new URL('./fixtures/atomic-witness.cjs', import.meta.url));
const temporaryDirectories = [];

function workspace() {
  const directory = mkdtempSync(join(tmpdir(), 'atomic-witness-'));
  temporaryDirectories.push(directory);
  return directory;
}

after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

/** Observe the target exactly the way the cancellation fixture's reader does. */
function pollUntilParsed(targetPath, attempts) {
  let partialObservations = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!existsSync(targetPath)) continue;
    try {
      JSON.parse(readFileSync(targetPath, 'utf8'));
    } catch {
      partialObservations += 1;
    }
  }
  return partialObservations;
}

describe('fixture witness publication', () => {
  // A read-only target inside a writable directory separates the two publication
  // strategies without racing them: writing through the target path needs write
  // permission on the file, replacing it by rename needs only directory
  // permission. This is the same property that makes partial reads impossible,
  // observed deterministically instead of by timing.
  const readOnlyTargetOptions = {
    skip: typeof process.getuid === 'function' && process.getuid() === 0 && 'root bypasses file permission bits',
  };

  it('exposes the defect: the previous publication mutated the target in place', readOnlyTargetOptions, () => {
    const directory = workspace();
    const targetPath = join(directory, 'witness.json');
    writeFileSync(targetPath, JSON.stringify({ generation: 'previous' }), 'utf8');
    chmodSync(targetPath, 0o444);

    assert.throws(
      () => writeFileSync(targetPath, JSON.stringify({ generation: 'next' }), 'utf8'),
      /EACCES/,
      'the pre-repair strategy writes through the target path, which is why readers could see it half-written',
    );
    assert.equal(JSON.parse(readFileSync(targetPath, 'utf8')).generation, 'previous');
  });

  it('publishes by replacing the target rather than writing through it', readOnlyTargetOptions, () => {
    const directory = workspace();
    const targetPath = join(directory, 'witness.json');
    writeFileSync(targetPath, JSON.stringify({ generation: 'previous' }), 'utf8');
    chmodSync(targetPath, 0o444);

    publishWitness(targetPath, { generation: 'next' });

    assert.equal(JSON.parse(readFileSync(targetPath, 'utf8')).generation, 'next');
    assert.deepEqual(
      readdirSync(directory).filter((entry) => entry !== 'witness.json'),
      [],
    );
  });

  it('publishes a document that a polling reader can always parse', () => {
    const directory = workspace();
    const targetPath = join(directory, 'witness.json');
    publishWitness(targetPath, { clientPid: process.pid, state: 'y'.repeat(64 * 1024) });

    assert.equal(pollUntilParsed(targetPath, 200), 0);
    assert.equal(JSON.parse(readFileSync(targetPath, 'utf8')).clientPid, process.pid);
  });

  it('removes its temp artifact when the publisher exits', () => {
    const directory = workspace();
    const targetPath = join(directory, 'witness.json');

    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `const { publishWitness } = require(process.argv[1]);
         publishWitness(process.argv[2], { clientPid: process.pid });`,
        HELPER,
        targetPath,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);

    const residue = readdirSync(directory).filter((entry) => entry !== 'witness.json');
    assert.deepEqual(residue, [], `publishing must not leave temp artifacts, found: ${residue.join(', ')}`);
  });

  it('refuses to publish onto an existing temp path instead of overwriting it', () => {
    const directory = workspace();
    const targetPath = join(directory, 'witness.json');
    publishWitness(targetPath, { generation: 1 });
    publishWitness(targetPath, { generation: 2 });

    assert.equal(JSON.parse(readFileSync(targetPath, 'utf8')).generation, 2);
    assert.deepEqual(
      readdirSync(directory).filter((entry) => entry !== 'witness.json'),
      [],
    );
  });
});
