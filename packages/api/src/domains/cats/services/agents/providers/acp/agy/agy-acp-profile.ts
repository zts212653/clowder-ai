import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgyProfileConfig } from '@cat-cafe/shared';
import { isolatedOAuthEnv } from '../../agy-native/agy-native-launch-env.js';
import { materializeAgyNativeSkills } from '../../agy-native/agy-native-skills.js';
import { resolveAgyProfile } from '../../agy-profile-manager.js';
import type { AgyAcpConfig } from './agy-acp-session.js';

function directory(path: string): void {
  const previous = lstatSync(path, { throwIfNoEntry: false });
  if (previous && (previous.isSymbolicLink() || !previous.isDirectory()))
    throw new Error('AGY ACP profile directory must not redirect');
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

/** ACP auth/storage is owned by the official server, separate from CLI history and tokens. */
export async function prepareAgyAcpProfile(input: {
  catId: string;
  model: string;
  projectRoot: string;
  profile: AgyProfileConfig;
}): Promise<{ antigravity: AgyAcpConfig; env: Record<string, string> }> {
  if (input.profile.carrier !== 'acp' || input.profile.enabled !== true || input.profile.model !== input.model)
    throw new Error('AGY ACP requires an enabled matching isolated profile');
  const base = resolveAgyProfile({
    materializeSettings: false,
    catId: input.catId,
    expectedModel: input.model,
    workingDirectory: input.projectRoot,
    config: input.profile,
  });
  if (!base) throw new Error('AGY ACP profile is disabled');
  const home = join(realpathSync(base.homePath), 'acp');
  directory(home);
  directory(join(home, '.gemini'));
  directory(join(home, '.gemini', 'config'));
  const data = join(home, '.gemini', 'antigravity-acp');
  directory(data);
  const settingsPath = join(data, 'settings.json');
  const entry = lstatSync(settingsPath, { throwIfNoEntry: false });
  if (entry) {
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error('AGY ACP settings must be a regular file');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { auth?: { type?: string } };
    if (settings.auth?.type !== 'oauth-personal')
      throw new Error('AGY ACP requires personal OAuth; API billing is not a fallback');
  } else writeFileSync(settingsPath, JSON.stringify({ auth: { type: 'oauth-personal' } }), { flag: 'wx', mode: 0o600 });
  await materializeAgyNativeSkills({
    profileHome: home,
    workspace: input.projectRoot,
    runtimeRoot: input.projectRoot,
    canonicalOnly: true,
  });
  const env = Object.fromEntries(
    Object.entries(isolatedOAuthEnv(home)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  env.AGY_ACP_DEFAULT_MODEL = input.model;
  return { antigravity: { profile: input.profile, profileHome: home }, env };
}
