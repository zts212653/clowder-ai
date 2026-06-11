import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function resolveCurrentWorktreeSkillsSource(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== dirname(dir)) {
    const candidate = join(dir, 'cat-cafe-skills', 'manifest.yaml');
    if (existsSync(candidate)) return join(dir, 'cat-cafe-skills');
    dir = dirname(dir);
  }
  return resolve(process.cwd(), 'cat-cafe-skills');
}

/** Canonical Cat Cafe skill source used by capability writeback and drift resolution. */
export async function resolveCatCafeSkillsSource(): Promise<string> {
  return resolveCurrentWorktreeSkillsSource();
}
