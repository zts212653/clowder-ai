import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type DshNativeLaunch, dshNativeModule, dshNativeFunction as fn } from './dsh-installation.js';

type Row = { id?: string; disabled?: unknown; config?: Record<string, unknown> };
export function readDshNativeFile(path: string): string | undefined {
  try {
    if (statSync(path).size > 4_000_000) throw new Error('native_config_too_large');
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
function bundlesOf(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    value[0] !== '@deepseek-ai/dsh-base' ||
    value[1] !== '@deepseek-ai/dsh-acp-app'
  )
    throw new Error('native_profile_unsupported');
  return value;
}

/** Public Native patch composition only. Unlike --dump-config, this does not
 * rewrite cordis.yml, initialize a profile, evaluate expressions or mount it. */
export async function readDshNativeProfile(launch: DshNativeLaunch) {
  const [boot, paths] = await Promise.all([
    dshNativeModule(launch, '@deepseek-ai/dsh-app-boot'),
    dshNativeModule(launch, '@deepseek-ai/dsh-home-paths'),
  ]);
  const nativeHome = fn<(home?: string) => string>(paths, 'resolveDshHome')(launch.env.DSH_HOME);
  const directory = join(nativeHome, 'profiles', launch.profile),
    manifestPath = join(directory, 'package.json');
  const manifest = JSON.parse(readDshNativeFile(manifestPath) ?? 'null') as {
    dsh?: { profile?: { bundles?: unknown } };
  } | null;
  const bundles = bundlesOf(manifest?.dsh?.profile?.bundles);
  const overlay = fn<(bin: string, path: string) => unknown[]>(boot, 'loadOverlayPatches');
  const optional = fn<(bin: string, path: string) => unknown[] | undefined>(boot, 'loadOptionalPatches');
  const sources = [manifestPath, launch.packagePath];
  const layers = bundles.map((name) => {
    const root = fn<(bin: string, name: string, anchor: string, profile: string) => string>(boot, 'resolveBundleDir')(
      'dsh',
      name,
      launch.packagePath,
      directory,
    );
    const pkg = JSON.parse(readDshNativeFile(join(root, 'package.json')) ?? 'null') as { dsh?: { bundle?: unknown } };
    const files = fn<(root: string, bundle: unknown) => string[]>(boot, 'bundlePatchPaths')(root, pkg.dsh?.bundle);
    sources.push(join(root, 'package.json'), ...files);
    return files.flatMap((path) => overlay('dsh', path));
  });
  const profilePatch = join(directory, 'cordis.patch.yml'),
    homePatch = join(nativeHome, 'cordis.patch.yml');
  sources.push(profilePatch, homePatch);
  layers.push(optional('dsh', profilePatch) ?? [], optional('dsh', homePatch) ?? []);
  const rows = fn<(layers: unknown[][]) => Row[]>(boot, 'composeEntries')(layers);
  const revision = createHash('sha256')
    .update(JSON.stringify(sources.map((path) => [path, readDshNativeFile(path)])))
    .digest('hex');
  return {
    nativeHome,
    revision,
    config(id: string): Record<string, unknown> {
      const found = rows.filter((row) => row.id === id);
      if (found.length !== 1 || (found[0]?.disabled !== undefined && found[0]?.disabled !== false))
        throw new Error('native_route_disabled');
      return found[0]?.config ?? {};
    },
  };
}
