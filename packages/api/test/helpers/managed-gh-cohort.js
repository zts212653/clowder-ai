import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { after } from 'node:test';
import { GH_COHORT_FILES } from '../../../../scripts/native-effect-gh-cohort.mjs';

/** A managed entry fixture must carry the same scanner imports it would load. */
export function copyManagedGhCohort(destination) {
  for (const file of GH_COHORT_FILES) {
    const target = join(destination, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(new URL('../../../../' + file, import.meta.url), target);
  }
  return join(destination, 'scripts/guarded-bin/gh');
}

/** Classification inputs never execute gh/git. Own the ordinary delegate chain,
 * instead of inheriting pnpm's relative PATH or a launcher's protected wrapper. */
export function isolateManagedGhProgramFixture() {
  const bin = realpathSync(mkdtempSync(join(tmpdir(), 'f306-managed-programs-')));
  for (const name of ['gh', 'git']) writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const names = ['PATH', 'CAT_CAFE_REAL_GH_PATH'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const hostTools = (previous.PATH ?? '').split(delimiter).filter(isAbsolute);
  process.env.PATH = [dirname(process.execPath), bin, '/usr/bin', '/bin', ...hostTools].join(delimiter);
  process.env.CAT_CAFE_REAL_GH_PATH = join(bin, 'gh');
  after(() => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    rmSync(bin, { recursive: true, force: true });
  });
}
