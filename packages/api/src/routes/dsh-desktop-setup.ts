import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import { z } from 'zod';
import { resolveInvokeCapabilityRoot } from '../config/capabilities/invoke-capability-root.js';
import { buildChildEnv } from '../utils/cli-spawn.js';
import { resolveDshDesktopLaunch } from '../utils/dsh-desktop-launch.js';
import { DSH_DESKTOP_RUNTIME } from './dsh-desktop-runtime.js';
import { assertDshCopyPolicy } from './dsh-setup-copy-policy.js';

export interface DshDesktopSource {
  command: string;
  cwd: string;
  nativeHome: string;
  nativeCwd: string;
}
const stateSchema = z.object({
  source: z.object({ nativeScope: z.string(), nativeHome: z.string(), nativeCwd: z.string() }),
  credentialPath: z.string(),
  officialConfig: z.record(z.unknown()).optional(),
  officialFields: z.array(z.string()),
  officialInject: z.array(z.string()),
  customInject: z.array(z.string()),
  llm: z.object({ providers: z.record(z.unknown()).optional() }),
  providers: z.array(
    z.object({
      id: z.string(),
      credential: z.enum(['configured', 'missing', 'native_auth']),
      models: z.array(z.object({ id: z.string(), label: z.string() })),
    }),
  ),
  revision: z.string(),
  provider: z.string().optional(),
  model: z.string().optional(),
});
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

async function runtimeFile(source: DshDesktopSource) {
  const plan = resolveDshDesktopLaunch(source.command, []);
  if (!plan) throw Error('dsh_setup_custom_startup');
  const root = await resolveInvokeCapabilityRoot(source.cwd);
  const directory = join(root, '.cat-cafe', 'dsh-desktop');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory())
    throw Error('dsh_setup_storage_invalid');
  const script = join(directory, `credentials-${digest(DSH_DESKTOP_RUNTIME)}.mjs`);
  try {
    writeFileSync(script, DSH_DESKTOP_RUNTIME, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (readFileSync(script, 'utf8') !== DSH_DESKTOP_RUNTIME) throw Error('dsh_setup_changed');
  return { directory, script, executable: plan.command, nativeScope: dirname(dirname(dirname(plan.args[1]))) };
}

export async function readDshDesktopSetup(source: DshDesktopSource) {
  const runtime = await runtimeFile(source);
  const { stdout } = await promisify(execFile)(
    runtime.executable,
    [
      '--expose-internals',
      runtime.script,
      'inspect',
      JSON.stringify({ nativeScope: runtime.nativeScope, nativeHome: source.nativeHome, nativeCwd: source.nativeCwd }),
    ],
    {
      cwd: source.nativeCwd,
      env: buildChildEnv({ ELECTRON_RUN_AS_NODE: '1' }, { workingDirectory: source.nativeCwd }),
      windowsHide: true,
      timeout: 20_000,
      maxBuffer: 4_000_000,
      encoding: 'utf8',
    },
  );
  const result: unknown = JSON.parse(stdout);
  const failure = z.object({ error: z.string().regex(/^dsh_[a-z_]+$/) }).safeParse(result);
  if (failure.success) throw Error(failure.data.error);
  const state = stateSchema.parse(result);
  return {
    state,
    runtime,
    view: {
      desktop: true,
      providers: state.providers,
      provider: state.provider,
      model: state.model,
      revision: state.revision,
    },
  };
}

/** Persist only the selected route and source references; credentials remain owned by Desktop. */
export async function prepareDshDesktopSetup(
  source: DshDesktopSource,
  revision: string,
  provider: string,
  model: string,
) {
  const current = await readDshDesktopSetup(source);
  if (current.state.revision !== revision) throw Error('dsh_setup_changed');
  const route = current.state.providers.find((route) => route.id === provider);
  if (!route || !route.models.some((item) => item.id === model)) throw Error('dsh_selection_invalid');
  if (route.credential === 'missing') throw Error('dsh_setup_credential_missing');
  if (
    provider === 'deepseek-official' &&
    Object.keys(current.state.officialConfig ?? {}).some((key) => !current.state.officialFields.includes(key))
  )
    throw Error('dsh_config_manual');
  const llm = {
    providers: provider === 'deepseek-official' ? {} : { [provider]: current.state.llm.providers?.[provider] },
  };
  assertDshCopyPolicy(llm, { provider, model });
  if (provider === 'deepseek-official')
    assertDshCopyPolicy(
      { providers: { [provider]: { baseURL: current.state.officialConfig?.baseURL } } },
      { provider, model },
    );
  const id = randomUUID();
  const home = join(current.runtime.directory, id);
  mkdirSync(home, { mode: 0o700 });
  const path = join(home, 'member.patch.yml');
  const patch = stringify([
    { id: 'credentials', disabled: true },
    {
      insert: [
        {
          id: 'clowder-desktop-credentials',
          name: pathToFileURL(current.runtime.script).href,
          config: { ...current.state.source, credentialPath: current.state.credentialPath },
        },
      ],
    },
    {
      id: 'llm-deepseek',
      disabled: provider !== 'deepseek-official',
      inject: current.state.officialInject,
      ...(provider === 'deepseek-official' ? { config: current.state.officialConfig } : {}),
    },
    { id: 'llm-deepseek-account', disabled: true },
    { id: 'llm-pi-ai', disabled: provider === 'deepseek-official', inject: current.state.customInject, config: llm },
    { id: 'acp', inject: ['acpAppStartup', 'credentials'], config: { provider, model } },
  ]);
  writeFileSync(path, patch, { mode: 0o600, flag: 'wx' });
  return {
    id,
    path,
    patchHash: digest(patch),
    provider,
    model,
    desktop: source,
    launch: {
      command: source.command,
      args: ['--profile', 'acp', '--patch', path],
      cwd: source.cwd,
      profileIndex: 1,
      env: { DSH_HOME: home },
    },
  };
}
