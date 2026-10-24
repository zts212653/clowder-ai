import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { resolveCliCommandOrBare } from '../../../../../../../utils/cli-resolve.js';
import { resolveWindowsSpawnPlan } from '../../../../../../../utils/cli-spawn-win.js';
import { verifyDshSecretPatch } from '../../dsh-secret-patch.js';
import { isBuiltinPiBridgeArgs } from '../../pi/pi-bridge-launch.js';

const DSH_HASHES = {
  entry: '1a03dee18683483ff6a1b27b2a1e650230da6bcca9a0f55f7d81b3308c3f307f',
  '@deepseek-ai/dsh-app-boot': '234db45e1b3f8c683b5bc1f551948b2a2ec52a6468c7b6937725a23f1c0e0d96',
  '@deepseek-ai/dsh-acp': 'c08ed51ebe53b7b45ca8f475630afc0271bf4ccb8b53f13b456fe2b4568a61b3',
} as const;
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

function noOpPatch(path: string): boolean {
  if (!existsSync(path)) return true;
  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  // A deliberately small syntax whitelist; never evaluate DSH's !!js dialect.
  if (text.length > 65536) return false;
  const tokens = text.split(/\r?\n/).filter((line) => !/^\s*(?:#.*)?$/.test(line));
  return tokens.length === 0 || (tokens.length === 1 && /^\s*\[\s*\]\s*(?:#.*)?$/.test(tokens[0] ?? ''));
}

/** A shared volume can contain attacker-written ancestor config. Admit only audited bootstraps. */
export function auditedWindowsAcpStartup(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): 'builtin-pi' | 'dsh-0.2.0-rc.2' | undefined {
  if (process.platform !== 'win32') return undefined;
  try {
    const variable = (name: string): string | undefined => {
      const matches = Object.entries(env).filter(([key]) => key.toUpperCase() === name);
      if (matches.length > 1) throw new Error('Ambiguous Windows environment');
      return matches[0]?.[1];
    };
    if (variable('NODE_OPTIONS') || variable('NODE_PATH')) return undefined;
    const plan = resolveWindowsSpawnPlan(resolveCliCommandOrBare(command), args);
    if (plan.shell || !/^node(?:\.exe)?$/i.test(basename(plan.command))) return undefined;
    const [entry, ...rest] = plan.args;
    if (!entry || !isAbsolute(entry)) return undefined;
    if (isBuiltinPiBridgeArgs(plan.args)) return 'builtin-pi';
    const managedPatch =
      rest.length === 4 && rest[2] === '--patch' && typeof rest[3] === 'string' && verifyDshSecretPatch(rest[3]);
    if (
      (rest.length !== 2 && !managedPatch) ||
      rest[0] !== '--profile' ||
      rest[1] !== 'acp' ||
      hash(entry) !== DSH_HASHES.entry
    )
      return undefined;
    if (
      hash(join(dirname(entry), 'profile-boot.js')) !==
        'c53d4e2caf21428e263b525e657dafaf63fd183f7ef016aabda56af7998b6c4f' ||
      hash(join(dirname(entry), 'profile-boot-BZ2ZjNWi.js')) !==
        'c394b2aa2ce08a3b1fcc8c544257c7d689dd4d0b1cfaf8602687e65eeaba5aa1'
    )
      return undefined;
    const manifest: unknown = JSON.parse(readFileSync(join(dirname(dirname(entry)), 'package.json'), 'utf8'));
    if (
      !manifest ||
      typeof manifest !== 'object' ||
      !('name' in manifest) ||
      manifest.name !== '@deepseek-ai/dsh' ||
      !('version' in manifest) ||
      manifest.version !== '0.2.0-rc.2'
    )
      return undefined;
    const require = createRequire(entry);
    for (const module of ['@deepseek-ai/dsh-app-boot', '@deepseek-ai/dsh-acp'] as const) {
      if (hash(require.resolve(module)) !== DSH_HASHES[module]) return undefined;
    }
    const configuredHome = variable('DSH_HOME')?.trim();
    // Relative/tilde homes would resolve differently in the isolated child cwd.
    if (configuredHome && !isAbsolute(configuredHome)) return undefined;
    const userProfile = variable('USERPROFILE');
    if (!configuredHome && userProfile && resolve(userProfile).toLowerCase() !== homedir().toLowerCase())
      return undefined;
    const home = resolve(configuredHome || join(homedir(), '.dsh'));
    const profile = join(home, 'profiles', 'acp');
    if (![home, profile].every((path) => noOpPatch(join(path, 'cordis.patch.yml')))) return undefined;
    if (!existsSync(join(profile, 'package.json'))) {
      return !existsSync(profile) || readdirSync(profile).length === 0 ? 'dsh-0.2.0-rc.2' : undefined;
    }
    const config: unknown = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'));
    const expected = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'];
    if (
      !config ||
      typeof config !== 'object' ||
      !('dsh' in config) ||
      !config.dsh ||
      typeof config.dsh !== 'object' ||
      !('profile' in config.dsh) ||
      !config.dsh.profile ||
      typeof config.dsh.profile !== 'object' ||
      !('bundles' in config.dsh.profile) ||
      JSON.stringify(config.dsh.profile.bundles) !== JSON.stringify(expected)
    )
      return undefined;
    return 'dsh-0.2.0-rc.2';
  } catch {
    return undefined;
  }
}
