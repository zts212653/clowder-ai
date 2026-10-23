import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { resolveDshHome } from './native-dsh-home.js';

function read(path: string): Buffer | undefined {
  try {
    if (statSync(path).size > 4_000_000) throw Error('dsh_config_invalid');
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** DSH's diagnostic rewrites cordis.yml. Mirror configuration into a private,
 * disposable HOME; never copy credential files, .env, sessions or databases. */
export function createDshDumpSnapshot(parent: string, profile: string) {
  if (!/^[\w-]+$/.test(profile)) throw Error('dsh_setup_custom_startup');
  const nativeHome = resolveDshHome();
  const directory = mkdtempSync(join(parent, 'dsh-dump-'));
  const files = new Map<string, Buffer | undefined>();
  function dispose() {
    const path = resolve(directory),
      root = resolve(parent);
    if (!path.startsWith(root + sep) || !path.slice(root.length + 1).startsWith('dsh-dump-'))
      throw Error('dsh_setup_storage_invalid');
    // This tree contains only this call's temporary configuration copies. No
    // symlinks or persistent native state are copied or traversed.
    rmSync(path, { recursive: true, force: true });
  }
  try {
    const destination = join(directory, 'profiles', profile);
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const relative of [
      'cordis.patch.yml',
      ...['package.json', 'cordis.yml', 'cordis.patch.yml'].map((file) => join('profiles', profile, file)),
    ]) {
      const original = join(nativeHome, relative),
        bytes = read(original);
      files.set(original, bytes);
      if (bytes) writeFileSync(join(directory, relative), bytes, { mode: 0o600, flag: 'wx' });
    }
    return {
      directory,
      dispose,
      verify: () => {
        for (const [path, previous] of files) {
          const current = read(path);
          if (previous === undefined ? current !== undefined : !current?.equals(previous))
            throw Error('dsh_setup_changed');
        }
      },
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
