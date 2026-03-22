import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const installed = new Map();

export function ensureFakeCliOnPath(command) {
  const cached = installed.get(command);
  if (cached) return cached;

  const dir = mkdtempSync(join(tmpdir(), `cat-cafe-${command}-cli-`));
  const file = join(dir, command);
  writeFileSync(file, '#!/bin/sh\nexit 0\n');
  chmodSync(file, 0o755);
  process.env.PATH = `${dir}${delimiter}${process.env.PATH ?? ''}`;
  installed.set(command, file);
  return file;
}
