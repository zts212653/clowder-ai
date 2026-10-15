import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { resolveCliCommandOrBare } from '../../../../../../utils/cli-resolve.js';

/** Outer launcher/explicit file arguments only. Inner native executable stays unknown. */
export function acpLaunchArtifacts(
  command: string,
  args: string[],
  cwd: string,
): readonly { path: string; sha256: string }[] {
  const selected = resolveCliCommandOrBare(command);
  const files = [
    selected,
    ...args
      .filter((arg) => /\.(?:mjs|cjs|js|json|exe)$/i.test(arg))
      .map((arg) => (isAbsolute(arg) ? arg : resolve(cwd, arg))),
  ];
  return [...new Set(files)].map((path) => {
    try {
      if (isAbsolute(path) && statSync(path).isFile())
        return { path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
    } catch {
      /* Missing is a distinct unverified fingerprint, never a ready claim. */
    }
    return { path, sha256: 'unresolved' };
  });
}
