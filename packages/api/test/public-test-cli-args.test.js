import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { normalizePublicTestCliArgv } from '../scripts/public-test-cli-args.mjs';
import {
  atomicPublicTestJsonWrite,
  comparePublicTestStrings,
  parsePublicTestCliOptions,
} from '../scripts/public-test-support.mjs';

const roots = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

describe('F308 public-test CLI arguments', () => {
  it("accepts only pnpm's leading forwarding separator", () => {
    assert.deepEqual(normalizePublicTestCliArgv(['--', '--output', 'plan.json']), ['--output', 'plan.json']);
    assert.deepEqual(normalizePublicTestCliArgv(['--output', 'plan.json']), ['--output', 'plan.json']);
    assert.deepEqual(normalizePublicTestCliArgv(['--output', 'plan.json', '--']), ['--output', 'plan.json', '--']);
  });

  it('rejects a non-array argument vector', () => {
    assert.throws(() => normalizePublicTestCliArgv('--output plan.json'), /must be an array/);
  });

  it('parses the shared strict key-value option contract', () => {
    assert.deepEqual(parsePublicTestCliOptions(['--output', 'plan.json', '--shards=4']), {
      output: 'plan.json',
      shards: '4',
    });
    assert.deepEqual(parsePublicTestCliOptions(['--help']), { help: true });
    assert.throws(() => parsePublicTestCliOptions(['--output']), /requires a value/);
    assert.throws(() => parsePublicTestCliOptions(['plan.json']), /unexpected argument/);
  });

  it('compares paths by code unit instead of host locale', () => {
    assert.equal(comparePublicTestStrings('test/z.test.js', 'test/ä.test.js'), -1);
    assert.equal(comparePublicTestStrings('same', 'same'), 0);
    assert.equal(comparePublicTestStrings('test/ä.test.js', 'test/z.test.js'), 1);
  });

  it('writes atomically even when the old predictable temp name is stale', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-f308-public-test-support-'));
    roots.push(root);
    const destination = join(root, 'report.json');
    writeFileSync(`${destination}.${process.pid}.tmp`, 'stale\n');

    await atomicPublicTestJsonWrite(destination, { status: 'succeeded' });

    assert.deepEqual(JSON.parse(readFileSync(destination, 'utf8')), { status: 'succeeded' });
  });
});
