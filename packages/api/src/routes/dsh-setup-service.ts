import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveInvokeCapabilityRoot } from '../config/capabilities/invoke-capability-root.js';
import { AcpClient } from '../domains/cats/services/agents/providers/acp/AcpClient.js';
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
export type PreparedDshSetup = Awaited<ReturnType<typeof prepareDshSetup>>;

export async function testDshSetup(prepared: PreparedDshSetup): Promise<{ sessionId: string }> {
  if (digest(readFileSync(prepared.path, 'utf8')) !== prepared.patchHash) throw Error('dsh_setup_changed');
  // Exactly the same bootstrap authority and cwd checks used by normal ACP calls.
  const target = dshSetupBootstrap(prepared.launch);
  const client = new AcpClient({
    command: target.command,
    args: target.args,
    cwd: target.verifyCwd(),
    ...(process.platform === 'win32' ? { verifyBootstrapCwd: target.verifyCwd } : {}),
    permissionHandler: (_request, respond) => respond({ cancelled: true }),
  });
  try {
    await client.initialize();
    const session = await client.newSession(target.cwd, []);
    const result = await client.promptCollect(
      session.sessionId,
      'Connection test. Reply only DSH_CONNECTION_OK. Do not use tools or access files.',
      { timeoutMs: 60_000 },
    );
    const text = result.events
      .flatMap(({ update }) => {
        const content = update.content;
        return update.sessionUpdate === 'agent_message_chunk' &&
          content &&
          !Array.isArray(content) &&
          content.type === 'text'
          ? [content.text]
          : [];
      })
      .join('');
    if (result.stopReason !== 'end_turn' || !text.includes('DSH_CONNECTION_OK')) throw Error('dsh_setup_test_failed');
    return { sessionId: session.sessionId };
  } finally {
    await client.close();
  }
}
