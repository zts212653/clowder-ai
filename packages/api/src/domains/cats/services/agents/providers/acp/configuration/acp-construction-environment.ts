import { isDeepStrictEqual } from 'node:util';
import { buildChildEnv } from '../../../../../../../utils/cli-spawn.js';
import { isNativePluginActionEnvironmentKey } from '../../../../../../plugin/declared/native-plugin-action-environment.js';
import { BUILTIN_ENV_MAPS } from '../../env-map.js';

// Actual launch/auth/config roots and transport inputs. Unknown third-party ambient
// dependencies keep the first-spawn snapshot; declare member.env to follow changes.
const BASE_KEYS = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'ComSpec',
  'COMSPEC',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'SHELL',
  'ZDOTDIR',
  'HISTFILE',
  'CAT_CAFE_ORIGINAL_ZDOTDIR',
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'NODE_OPTIONS',
  'NODE_PATH',
] as const;
const CLIENT_KEYS: Readonly<Record<string, readonly string[]>> = {
  kimi: [
    'KIMI_CODE_HOME',
    'KIMI_CODE_BASE_URL',
    'KIMI_CODE_OAUTH_HOST',
    'KIMI_OAUTH_HOST',
    'KIMI_MODEL_NAME',
    'KIMI_MODEL_API_KEY',
    'KIMI_MODEL_BASE_URL',
    'KIMI_MODEL_MAX_CONTEXT_SIZE',
  ],
  opencode: [
    'OPENCODE_CONFIG',
    'OPENCODE_CONFIG_CONTENT',
    'OPENCODE_CONFIG_DIR',
    'OPENCODE_API_KEY',
    'OPENCODE_BASE_URL',
  ],
  google: ['GEMINI_CLI_HOME', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_APPLICATION_CREDENTIALS'],
};

/** Same finite projection feeds admission freshness and the process-local pool HMAC. */
export function acpConstructionEnvironment(
  clientId: string,
  preparedEnv: Readonly<Record<string, string>>,
  declaredEnv: Readonly<Record<string, string>> = {},
  platform: NodeJS.Platform = process.platform,
): Readonly<Record<string, string | null>> {
  const normalize = (key: string) => (platform === 'win32' ? key.toUpperCase() : key);
  // Match node:child_process on Windows: aliases are case-insensitive and the
  // lexicographically first spelling is the one delivered to the child.
  const effective = new Map<string, string>();
  for (const key of Object.keys(preparedEnv).sort()) {
    const canonical = normalize(key);
    if (!effective.has(canonical)) effective.set(canonical, preparedEnv[key]!);
  }
  const keys = new Set(
    [
      ...BASE_KEYS,
      ...Object.keys(BUILTIN_ENV_MAPS[clientId] ?? {}),
      ...(CLIENT_KEYS[clientId] ?? []),
      ...Object.keys(declaredEnv),
    ].map(normalize),
  );
  return Object.freeze(Object.fromEntries([...keys].sort().map((key) => [key, effective.get(key) ?? null])));
}

/** The existing factory owns this snapshot; no new service generation or state store is created. */
export function captureAcpConstructionEnvironment(input: {
  clientId: string;
  workingDirectory: string;
  declaredEnv?: Readonly<Record<string, string>>;
  inheritParentEnv: boolean;
  overrides(): Record<string, string> | undefined;
  onChanged(keys: string[]): never;
}) {
  const read = () =>
    Object.fromEntries(
      Object.entries(
        buildChildEnv(input.overrides(), {
          workingDirectory: input.workingDirectory,
          inheritParentEnv: input.inheritParentEnv,
        }),
      )
        .filter((entry): entry is [string, string] => entry[1] !== undefined)
        .filter(([key]) => !isNativePluginActionEnvironmentKey(key))
        .sort(([left], [right]) => left.localeCompare(right)),
    );
  const preparedEnv = Object.freeze(read());
  const projection = acpConstructionEnvironment(input.clientId, preparedEnv, input.declaredEnv);
  return {
    preparedEnv,
    projection,
    assertCurrent() {
      const current = acpConstructionEnvironment(input.clientId, read(), input.declaredEnv);
      if (!isDeepStrictEqual(projection, current))
        input.onChanged(Object.keys(projection).filter((key) => projection[key] !== current[key]));
    },
  };
}
