import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { parseEnv } from 'node:util';
import type { RuntimeProviderProfile } from '../account-resolver.js';
import {
  type DshNativeLaunch,
  dshNativeModule,
  dshNativeFunction as fn,
  inspectDshNativeLaunch,
} from './dsh-installation.js';
import { readDshNativeFile as read, readDshNativeProfile } from './dsh-profile.js';

export interface DshNativeAccount {
  readonly profile: RuntimeProviderProfile;
  readonly credentialPath: string;
  readonly credentialRef: string;
  readonly keyDigest: string;
  readonly provider: string;
  readonly model: string;
  readonly providerConfig: Readonly<Record<string, unknown>>;
}
const digest = (input: string) => createHash('sha256').update(input).digest('hex');
function plain(value: unknown): boolean {
  if (value === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(plain);
  return (
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype &&
    !Object.hasOwn(value, '__jsExpr') &&
    Object.values(value).every(plain)
  );
}
function selectedModel(value: string): readonly [string, string] {
  const selection: unknown = JSON.parse(value);
  if (
    !Array.isArray(selection) ||
    selection.length !== 2 ||
    selection[0] !== 'deepseek-official' ||
    typeof selection[1] !== 'string' ||
    !selection[1]
  )
    throw new Error('native_model_selection_unsupported');
  return [selection[0], selection[1]];
}

/** Project the actual native file credential into an in-memory Host profile.
 * DSH remains the credential owner; no login, key or profile is copied/written. */
export async function readDshNativeAccount(
  launch: DshNativeLaunch,
  modelSelection: string,
  cwd: string,
): Promise<DshNativeAccount> {
  try {
    const actual = inspectDshNativeLaunch(launch);
    if (!actual || actual.packagePath !== launch.packagePath) throw new Error('native_installation_changed');
    const [profile, credentials, local, adapter, protocol, launchEnvironment] = await Promise.all([
      readDshNativeProfile(launch),
      dshNativeModule(launch, '@deepseek-ai/dsh-credentials'),
      dshNativeModule(launch, '@deepseek-ai/dsh-credentials-local'),
      dshNativeModule(launch, '@deepseek-ai/dsh-llm-deepseek-api-key'),
      dshNativeModule(launch, '@deepseek-ai/dsh-llm-deepseek'),
      dshNativeModule(launch, '@deepseek-ai/dsh-launch-environment'),
    ]);
    const { nativeHome } = profile;
    const acp = profile.config('acp'),
      config = profile.config('llm-deepseek'),
      store = profile.config('credentials');
    if (!plain(config) || !plain(store) || typeof acp.provider !== 'string' || typeof acp.model !== 'string')
      throw new Error('native_config_expression');
    const fields = protocol.deepSeekConfigFields;
    if (!fields || typeof fields !== 'object') throw new Error('native_config_schema_unavailable');
    const keys = new Set([...Object.keys(fields), 'apiKeyEnv']);
    if (Object.keys(config).some((key) => !keys.has(key))) throw new Error('native_provider_config_unsupported');
    const selection = selectedModel(modelSelection);
    const environment = fn<
      (layers: readonly { source: string; values: Record<string, string | undefined>; path?: string }[]) => unknown
    >(
      launchEnvironment,
      'createLaunchEnvironmentSnapshot',
    )([
      { source: 'process', values: { ...process.env, ...launch.env } },
      { source: 'project-env', path: join(cwd, '.env'), values: parseEnv(read(join(cwd, '.env')) ?? '') },
      { source: 'user-env', path: join(nativeHome, '.env'), values: parseEnv(read(join(nativeHome, '.env')) ?? '') },
    ]);
    const connection = fn<
      (input: Record<string, unknown>, environment: unknown) => { baseURL: string; apiKeyEnv: string }
    >(adapter, 'resolveAdapterOptions')(config, environment);
    const credentialRef = fn<(ref: string) => string>(credentials, 'credentialRef')(connection.apiKeyEnv);
    if (store.path !== undefined && (typeof store.path !== 'string' || !isAbsolute(store.path)))
      throw new Error('native_credential_path_unsupported');
    const { filename: credentialPath } = fn<(config: Record<string, unknown>) => { filename: string }>(
      local,
      'resolveSpec',
    )({ ...store, dshHome: store.dshHome ?? nativeHome });
    const document = fn<(text: string, path: string) => { refs: Map<string, string> }>(
      local,
      'parseCredentialsDocument',
    )(read(credentialPath) ?? '', credentialPath);
    const apiKey = document.refs.get(credentialRef);
    if (!apiKey) throw new Error('native_file_account_unavailable');
    const sourceRevision = digest(
      JSON.stringify({
        profileRevision: profile.revision,
        providerConfig: config,
        baseURL: connection.baseURL,
      }),
    );
    const id = `native-dsh:${digest(JSON.stringify([nativeHome, credentialPath, credentialRef, selection[0]])).slice(0, 40)}`;
    return {
      profile: {
        id,
        displayName: `DSH · ${credentialRef}`,
        kind: 'api_key',
        authType: 'api_key',
        persistedClientId: 'acp',
        accountOwnerRoot: nativeHome,
        baseUrl: connection.baseURL,
        apiKey,
        nativeSourceRevision: sourceRevision,
        models: [modelSelection],
      },
      credentialPath,
      credentialRef,
      keyDigest: digest(apiKey),
      provider: selection[0],
      model: selection[1],
      providerConfig: Object.freeze({ ...config, baseURL: connection.baseURL, apiKeyEnv: credentialRef }),
    };
  } catch {
    throw new Error('dsh_native_account_unavailable');
  }
}
