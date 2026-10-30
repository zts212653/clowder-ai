import { lstatSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { resolveDeclaredCapabilityRoot } from '../config/capabilities/invoke-capability-root.js';
import { pathsEqual } from '../utils/project-path.js';
import { inspectDshRouteReadiness } from './dsh-setup-readiness.js';
import { resolveDshHome } from './native-dsh-home.js';

/** A classification hint only, never launcher authority. A random --patch is
 * not a saved setup: require this Host's exact UUID directory and a complete,
 * still-credentialed route selection. Existing native files stay read-only. */
export function hasPersistedDshSetup(args: readonly string[], cwd: string): boolean {
  const index = args.lastIndexOf('--patch');
  const patch = args[index + 1];
  if (index < 0 || index !== args.length - 2 || !patch || !isAbsolute(patch)) return false;
  try {
    const root = resolveDeclaredCapabilityRoot() ?? cwd;
    const parent = join(root, '.cat-cafe', 'dsh-acp');
    if (
      !pathsEqual(resolve(dirname(patch)), resolve(parent)) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.yml$/i.test(basename(patch))
    )
      return false;
    for (const path of [join(root, '.cat-cafe'), parent, patch]) {
      const entry = lstatSync(path);
      if (entry.isSymbolicLink() || (path === patch ? !entry.isFile() || entry.size > 4_000_000 : !entry.isDirectory()))
        return false;
    }
    const home = resolveDshHome();
    // bootstrap cwd is not the project: never infer a key from project/.env.
    const view = inspectDshRouteReadiness(readFileSync(patch, 'utf8'), home, home);
    return view.providers.some(
      (provider) =>
        provider.id === view.provider &&
        provider.credentialStatus === 'configured' &&
        provider.models.some((model) => model.id === view.model),
    );
  } catch {
    return false;
  }
}
