import { realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

/**
 * How a directory operand resolves, shared by every guard that follows `cd` or `git -C`.
 *
 * The kernel opens a path component by component, so a symlink is followed before the
 * `..` after it: `alias/..` is the parent of the link's target. Normalising first
 * (`path.resolve`) answers a different question. A shell `cd` is logical by default
 * (`..` drops the previous path text) and physical under `cd -P` / CHASE_LINKS.
 */

/** The physical path the kernel reaches, or null when it does not exist. */
export function kernelPath(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

/** Join without normalizing, so `..` is left for the kernel to apply after symlinks. */
export function unfoldedJoin(base, operand) {
  return isAbsolute(operand) ? operand : `${base}${sep}${operand}`;
}

/**
 * Where `cd <operand>` can leave a shell that stands at `location` ({logical, physical}).
 * Plain `cd` gives both readings, because a CHASE_LINKS shell is physical; `cd -P` only
 * the physical one. A directory that does not exist yet (created earlier in the same
 * command line) keeps its lexical reading.
 */
export function cdReadings(location, operand, { physicalOnly = false } = {}) {
  const readings = [];
  const joined = unfoldedJoin(location.physical, operand);
  const physicalCd = kernelPath(joined) ?? resolve(joined);
  readings.push({ logical: physicalCd, physical: physicalCd });
  if (!physicalOnly) {
    const logical = resolve(location.logical, operand);
    readings.push({ logical, physical: kernelPath(logical) ?? logical });
  }
  return readings;
}
