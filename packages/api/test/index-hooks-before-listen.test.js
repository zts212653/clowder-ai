import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const INDEX_TS = path.join(here, '..', 'src', 'index.ts');

/**
 * Fastify throws FST_ERR_INSTANCE_ALREADY_LISTENING if addHook runs after listen().
 * That kills main() outright — the API never binds and the whole product is down.
 * PR #3104 shipped exactly this and no test caught it, so guard the ordering statically.
 *
 * Fix pattern when a hook needs a handle created after listen: declare the handle as a
 * mutable `let` before listen, register the onClose hook there, and assign later.
 */
test('no app.addHook() is registered after app.listen() in main()', async () => {
  const source = await readFile(INDEX_TS, 'utf8');
  const lines = source.split('\n');

  const listenLine = lines.findIndex((line) => line.includes('app.listen('));
  assert.notEqual(listenLine, -1, 'expected an app.listen( call in src/index.ts');

  const offenders = [];
  for (let i = listenLine + 1; i < lines.length; i++) {
    if (lines[i].includes('app.addHook(')) {
      offenders.push(`${i + 1}: ${lines[i].trim()}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `app.addHook() after app.listen() (line ${listenLine + 1}) crashes startup with ` +
      `FST_ERR_INSTANCE_ALREADY_LISTENING:\n${offenders.join('\n')}`,
  );
});
