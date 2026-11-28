import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkDshConnection } from '@clowder-ai/agent-access/runtime/acp/dsh/connection-check';
import { resolveInvokeCapabilityRoot } from '../config/capabilities/invoke-capability-root.js';
import { AcpClient, type AcpClientConfig } from '../domains/cats/services/agents/providers/acp/AcpClient.js';
import { prepareDshSecretPatch } from '../domains/cats/services/agents/providers/dsh-secret-patch.js';
import { type prepareDshDesktopSetup, readDshDesktopSetup } from './dsh-desktop-setup.js';
import { buildDshPatch, canonicalDshConfig, composeDshProviderSource, inspectDshConfig } from './dsh-setup-config.js';
import { type DshSetupLaunch, dshSetupBootstrap, dumpDshConfig } from './dsh-setup-launch.js';
import { resolveDshHome } from './native-dsh-home.js';

export function dshSourceProfiles(configuredHome?: string): string[] {
  try {
    const home = resolveDshHome(configuredHome);
    return readdirSync(join(home, 'profiles'), { withFileTypes: true })
      .flatMap((entry) => {
        if (!entry.isDirectory() || !/^[\w-]+$/.test(entry.name)) return [];
        try {
          const dir = join(home, 'profiles', entry.name);
          const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
            dsh?: { profile?: { bundles?: unknown } };
          };
          // Existing complete profiles only: --dump-config must not initialize a profile.
          if (
            !Array.isArray(pkg.dsh?.profile?.bundles) ||
            !pkg.dsh.profile.bundles.length ||
            !lstatSync(join(dir, 'cordis.yml')).isFile()
          )
            return [];
          return [entry.name];
        } catch {
          return [];
        }
      })
      .sort();
  } catch {
    return [];
  }
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function patchFile(path: string): string {
  try {
    if (statSync(path).size > 4_000_000) throw Error('dsh_config_invalid');
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '[]';
    throw error;
  }
}

export async function readDshSetup(launch: DshSetupLaunch, sourceProfile: string) {
  const activeProfile = launch.args[launch.profileIndex] ?? '';
  const profiles = [...new Set([...dshSourceProfiles(), ...(activeProfile === 'acp' ? ['acp'] : [])])];
  if (!profiles.includes(sourceProfile) || !profiles.includes(launch.args[launch.profileIndex] ?? ''))
    throw Error('dsh_setup_profile_required');
  const active = await dumpDshConfig(launch);
  const home = resolveDshHome();
  const source =
    sourceProfile === launch.args[launch.profileIndex]
      ? active
      : composeDshProviderSource(
          patchFile(join(home, 'profiles', sourceProfile, 'cordis.patch.yml')),
          patchFile(join(home, 'cordis.patch.yml')),
        );
  return {
    active,
    source,
    view: {
      profiles,
      sourceProfile,
      active: inspectDshConfig(active),
      source: inspectDshConfig(source),
      revision: digest(JSON.stringify([launch, home, canonicalDshConfig(active), canonicalDshConfig(source)])),
    },
  };
}

/** Immutable files keep old invocations stable and change the existing pool's spawn signature. */
export async function prepareDshSetup(
  launch: DshSetupLaunch,
  sourceProfile: string,
  revision: string,
  provider: string,
  model: string,
) {
  const current = await readDshSetup(launch, sourceProfile);
  if (current.view.revision !== revision) throw Error('dsh_setup_changed');
  const patch = buildDshPatch(current.active, current.source, provider, model);
  const root = await resolveInvokeCapabilityRoot(launch.cwd);
  const parent = join(root, '.cat-cafe');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (lstatSync(parent).isSymbolicLink() || !lstatSync(parent).isDirectory()) throw Error('dsh_setup_storage_invalid');
  const directory = join(parent, 'dsh-acp');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory())
    throw Error('dsh_setup_storage_invalid');
  const id = randomUUID(),
    path = join(directory, `${id}.yml`);
  writeFileSync(path, patch, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  const prepared = { ...launch, args: [...launch.args, '--patch', path] };
  const effective = inspectDshConfig(await dumpDshConfig(prepared));
  if (
    effective.provider !== provider ||
    effective.model !== model ||
    !effective.providers.some((route) => route.id === provider && route.models.some((m) => m.id === model))
  )
    throw Error('dsh_setup_not_applied');
  return { id, path, patchHash: digest(patch), launch: prepared, provider, model };
}
export type PreparedDshSetup = Awaited<ReturnType<typeof prepareDshSetup | typeof prepareDshDesktopSetup>>;

export type RunDshConnection = (
  config: AcpClientConfig,
  cwd: string,
  preferences: { model?: string; effort?: string },
) => Promise<{ sessionId: string }>;

export async function testDshSetup(
  prepared: PreparedDshSetup,
  preferences: { model?: string; effort?: string } = {},
  run?: RunDshConnection,
) {
  if (digest(readFileSync(prepared.path, 'utf8')) !== prepared.patchHash) throw Error('dsh_setup_changed');
  if ('desktop' in prepared) {
    const current = await readDshDesktopSetup(prepared.desktop);
    const route = current.state.providers.find((item) => item.id === prepared.provider);
    if (!route || route.credential === 'missing') throw Error('dsh_setup_credential_missing');
    const selected = JSON.stringify([prepared.provider, prepared.model]);
    if (preferences.model && preferences.model !== selected && preferences.model !== prepared.model)
      throw Error('dsh_setup_changed');
    return testDshConnection(prepared.launch, { ...preferences, model: selected }, run);
  }
  return testDshConnection(prepared.launch, preferences, run);
}

export async function testDshConnection(
  launch: Pick<DshSetupLaunch, 'command' | 'args' | 'cwd' | 'env'>,
  preferences: { model?: string; effort?: string } = {},
  run: RunDshConnection = (config, cwd, preferences) => checkDshConnection(new AcpClient(config), cwd, preferences),
): Promise<{ sessionId: string }> {
  // Exactly the same bootstrap authority and cwd checks used by normal ACP calls.
  const args = await prepareDshSecretPatch(launch.command, launch.args, launch.cwd, preferences.model);
  const target = dshSetupBootstrap({ ...launch, args });
  const config: AcpClientConfig = {
    command: target.command,
    args: target.args,
    cwd: target.verifyCwd(),
    env: launch.env,
    ...(process.platform === 'win32' ? { verifyBootstrapCwd: target.verifyCwd } : {}),
    permissionHandler: (_request, respond) => respond({ cancelled: true }),
  };
  return run(config, target.cwd, preferences);
}
