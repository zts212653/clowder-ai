import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseEnv } from 'node:util';
import { parseDocument } from 'yaml';
import { buildDshNativePatch, composeDshProviderSource, inspectDshConfig } from '../routes/dsh-setup-config.js';
import { resolveDshHome } from '../routes/native-dsh-home.js';
import { dshInstallation, dshNativeSource } from './dsh-native-bundles.js';

function patch(path: string) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '[]';
}

/** Read only declared defaults. ACP is a transport profile, not the user's UI default. */
export function readDshNativeConfiguration(
  configuredHome?: string,
  launch?: { command: string; args: readonly string[] },
) {
  const home = resolveDshHome(configuredHome),
    profiles = join(home, 'profiles');
  if (!existsSync(profiles)) return undefined;
  const homePatch = patch(join(home, 'cordis.patch.yml'));
  const declaredProfiles = readdirSync(profiles, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory() && entry.name !== 'acp' && existsSync(join(profiles, entry.name, 'package.json')),
  );
  const found = declaredProfiles.flatMap((entry) => {
    const directory = join(profiles, entry.name);
    const source = composeDshProviderSource(dshNativeSource(home, entry.name, launch?.command, launch?.args), '[]');
    const info = inspectDshConfig(source);
    const declared = inspectDshConfig(composeDshProviderSource(patch(join(directory, 'cordis.patch.yml')), homePatch));
    return info.provider && info.model ? [{ profile: entry.name, source, info, explicit: !!declared.provider }] : [];
  });
  const candidates = found.some((item) => item.explicit) ? found.filter((item) => item.explicit) : found;
  if (!candidates.length) {
    if (declaredProfiles.length) throw Error('dsh_default_unreported');
    return undefined;
  }
  if (new Set(candidates.map(({ source }) => buildDshNativePatch(source))).size > 1)
    throw Error('dsh_default_ambiguous');
  const selected = candidates[0];
  const active = existsSync(join(profiles, 'acp/package.json'))
    ? dshNativeSource(home, 'acp', launch?.command, launch?.args)
    : '[]';
  const content = buildDshNativePatch(selected.source, active);
  const revision = createHash('sha256').update(home).update(content).digest('hex');
  const model = JSON.stringify([selected.info.provider, selected.info.model]);
  return {
    home,
    profile: selected.profile,
    revision,
    content,
    model,
    effort: selected.info.defaultEffort,
    models: [
      ...new Set([
        model,
        ...selected.info.providers.flatMap((provider) =>
          provider.models.map((model) => JSON.stringify([provider.id, model.id])),
        ),
      ]),
    ],
  };
}

/** The existing native credential store stays in place; only presence is projected. */
export function dshNativeCredentialMissing(
  configuredHome?: string,
  cwd = process.cwd(),
  launch?: { command: string; args: readonly string[] },
) {
  const home = resolveDshHome(configuredHome);
  const configuration = readDshNativeConfiguration(home, launch);
  if (!configuration) return false;
  const document = parseDocument(configuration.content);
  const entries = document.toJSON() as Array<{
    id: string;
    config: { providers?: Record<string, { apiKeyEnv?: string }>; apiKeyEnv?: string; provider?: string };
  }>;
  const provider = JSON.parse(configuration.model)[0] as string;
  const adapter = entries.find(
    (entry) => entry.id === (provider === 'deepseek-official' ? 'llm-deepseek' : 'llm-pi-ai'),
  );
  const ref = adapter?.config.providers?.[provider]?.apiKeyEnv ?? adapter?.config.apiKeyEnv;
  if (!ref || process.env[ref]?.trim()) return false;
  const credentials = parseDocument(patch(join(home, '.credentials.yaml')));
  const value = credentials.getIn(['refs', ref]);
  if (typeof value === 'string' && value.trim()) return false;
  return ![join(home, '.env'), join(cwd, '.env')].some(
    (file) => existsSync(file) && parseEnv(readFileSync(file, 'utf8'))[ref]?.trim(),
  );
}

export function prepareDshNativeConfiguration(command: string, args: string[], projectRoot: string) {
  const profile = args.indexOf('--profile');
  if (!/^dsh(?:\.(?:cmd|exe|bat))?$/i.test(basename(command)) && !dshInstallation(command, args)) return undefined;
  if (profile < 0 || args[profile + 1] !== 'acp' || args.includes('--patch')) return undefined;
  const configuration = readDshNativeConfiguration(undefined, { command, args });
  if (!configuration) return undefined;
  const directory = join(projectRoot, '.cat-cafe', 'native-dsh');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `${configuration.revision}.yml`);
  if (!existsSync(file)) writeFileSync(file, configuration.content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  if (readFileSync(file, 'utf8') !== configuration.content) throw Error('dsh_configuration_changed');
  return { ...configuration, args: [...args, '--patch', file] };
}
