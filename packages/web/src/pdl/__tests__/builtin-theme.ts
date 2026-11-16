// The built-in theme packages as the host serves them: the same reader as the API, over public/pdl/themes.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { listPackages, readPackage, themeRoots } from '../../../../api/src/domains/console-themes/packages';

const roots = themeRoots(path.join(process.cwd(), '.no-owner-packages'), path.join(process.cwd(), 'public/pdl/themes'));
const reads = new Map<string, Promise<unknown>>();

export const builtinThemes = {
  list: () => listPackages(roots),
  read: (id: string) => {
    if (!reads.has(id)) reads.set(id, readPackage(roots, id));
    return reads.get(id)!;
  },
};

/** The default package's pdl (what the console loads first). */
export function defaultThemePdl() {
  return parse(readFileSync(path.join(roots.builtin, 'default/theme.yaml'), 'utf8')).pdl;
}
