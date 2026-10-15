import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** Inspect the actual CLI argument in both inline (POSIX) and file (Windows) forms. */
export function readCliJsonArgument(args, flag) {
  const index = args.indexOf(flag);
  assert.ok(index >= 0, `${flag} should be present`);
  const value = args[index + 1];
  assert.equal(typeof value, 'string');
  return JSON.parse(value.trimStart().startsWith('{') ? value : readFileSync(value, 'utf8'));
}
