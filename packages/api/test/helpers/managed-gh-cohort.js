import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
