import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const installed = new Map();

export function ensureFakeCliOnPath(command) {
  const cached = installed.get(command);
  if (cached) return cached;

  const dir = mkdtempSync(join(tmpdir(), `cat-cafe-${command}-cli-`));
  const file = join(dir, command);
  const script =
    command === 'opencode'
      ? '#!/bin/sh\nif [ "$1" = "run" ] && [ "$2" = "--help" ]; then\n  echo "opencode run [message..]"\n  echo "      --auto         auto-approve permissions that are not explicitly denied (dangerous!)"\n  exit 0\nfi\nexit 0\n'
      : '#!/bin/sh\nexit 0\n';
  writeFileSync(file, script);
  chmodSync(file, 0o755);
  process.env.PATH = `${dir}${delimiter}${process.env.PATH ?? ''}`;
  installed.set(command, file);
  return file;
}
