import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Keep writable shell state outside tracked templates; publish each startup file atomically. */
export function prepareGuardedZshDirectory(templateDir: string, guardedDir: string): void {
  mkdirSync(guardedDir, { recursive: true, mode: 0o700 });
  for (const name of ['.zshenv', '.zprofile', '.zshrc', '.zlogin']) {
    const template = readFileSync(resolve(templateDir, name));
    const destination = resolve(guardedDir, name);
    if (existsSync(destination) && readFileSync(destination).equals(template)) continue;

    const pending = resolve(guardedDir, `${name}.${randomUUID()}.tmp`);
    try {
      writeFileSync(pending, template, { flag: 'wx', mode: 0o600 });
      renameSync(pending, destination);
    } finally {
      rmSync(pending, { force: true });
    }
  }
}
