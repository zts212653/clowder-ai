import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'smol-toml';
import { codexProjectConfigDirectories } from './codex-project-config-projection.js';

export function codexConfigRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function merge(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = Object.assign(Object.create(null), base);
  for (const [key, value] of Object.entries(overlay)) {
    result[key] =
      value && typeof value === 'object' && !Array.isArray(value)
        ? merge(codexConfigRecord(result[key]), codexConfigRecord(value))
        : value;
  }
  return result;
}
function normalizeSqliteLayer(
  config: Record<string, unknown>,
  baseDir: string,
  nativeHome: string,
): Record<string, unknown> {
  if (typeof config.sqlite_home === 'string') {
    const path = config.sqlite_home;
    config.sqlite_home =
      path === '~' ? nativeHome : path.startsWith('~/') ? resolve(nativeHome, path.slice(2)) : resolve(baseDir, path);
  }
  return config;
}
function readConfig(path: string): Record<string, unknown> {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error('codex_account_config_unreadable');
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error('unsupported');
    const bytes = Buffer.alloc(1024 * 1024 + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const after = fstatSync(fd);
    if (length > 1024 * 1024 || info.size !== after.size || info.mtimeMs !== after.mtimeMs)
      throw new Error('unsupported');
    return parse(bytes.subarray(0, length).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new Error('codex_account_config_invalid');
  } finally {
    closeSync(fd);
  }
}
/** Native treats the left side as a literal dotted path; only the value is parsed as TOML. */
export function codexCliConfig(args: readonly string[], onAssignment?: (key: string) => void): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const assignment =
      flag === '-c' || flag === '--config'
        ? args[++i]
        : flag.startsWith('--config=')
          ? flag.slice(9)
          : flag.startsWith('-c=')
            ? flag.slice(3)
            : flag.startsWith('-c') && flag.length > 2
              ? flag.slice(2)
              : undefined;
    if (assignment === undefined) {
      if (flag === '-c' || flag === '--config') throw new Error('codex_account_config_invalid');
      continue;
    }
    const equals = assignment.indexOf('=');
    const key = assignment.slice(0, equals).trim();
    if (equals < 1 || !key) throw new Error('codex_account_config_invalid');
    onAssignment?.(key);
    const raw = assignment.slice(equals + 1).trim();
    let value: unknown;
    try {
      value = parse(`_x_=${raw}`)._x_;
    } catch {
      value = raw.replace(/^['"]+|['"]+$/g, '');
    }
    setPath(result, key, value);
  }
  return result;
}
function setPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let target = root;
  for (const key of segments.slice(0, -1)) {
    const current = codexConfigRecord(Object.hasOwn(target, key) ? target[key] : undefined);
    target[key] = Object.assign(Object.create(null), current);
    target = target[key] as Record<string, unknown>;
  }
  target[segments[segments.length - 1]] = value;
}
const SENSITIVE_FIELDS = [
  'model_provider',
  'model_providers',
  'forced_login_method',
  'forced_chatgpt_workspace_id',
  'cli_auth_credentials_store',
  'openai_base_url',
  'chatgpt_base_url',
  'experimental_realtime_webrtc_call_base_url',
  'experimental_realtime_ws_base_url',
  'sqlite_home',
];
export function codexSensitiveProjection(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    SENSITIVE_FIELDS.filter((key) => Object.hasOwn(config, key)).map((key) => [key, config[key]]),
  );
}
/** RPC keys use the same native dotted-path runtime overlay grammar. */
export function codexRpcConfig(config: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(config)) setPath(result, key, value);
  return codexSensitiveProjection(result);
}
export interface CodexLaunchConfigLayer {
  readonly kind: 'system' | 'user' | 'profile' | 'project' | 'cli' | 'managed' | 'requirements';
  readonly source: string;
  readonly baseDir: string;
  readonly config: Record<string, unknown>;
}
/** A bounded bootstrap projection, not a native effective-config implementation.
 * Project auth fields are denied by native. Project trust/SQLite, MDM and cloud
 * remain native observations; no managed-account enablement can rely on this projection alone.
 */
export function readCodexLaunchProjection(
  home: string,
  cwd: string,
  args: readonly string[] = [],
  options: { nativeHome?: string } = {},
): { config: Record<string, unknown>; layers: CodexLaunchConfigLayer[]; requirements: Record<string, unknown> } {
  const nativeHome = options.nativeHome ?? process.env.HOME ?? homedir();
  let nativeProfile: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--profile' || arg === '-p') nativeProfile = args[++i];
    else if (arg.startsWith('--profile=')) nativeProfile = arg.slice(10);
    else if (arg.startsWith('-p=')) nativeProfile = arg.slice(3);
    else if (arg.startsWith('-p') && arg.length > 2) nativeProfile = arg.slice(2);
    else continue;
    if (!nativeProfile || !/^[A-Za-z0-9_-]+$/.test(nativeProfile)) throw new Error('codex_account_config_invalid');
  }
  const systemPath = '/etc/codex/config.toml',
    userPath = join(home, 'config.toml');
  const system = readConfig(systemPath),
    user = readConfig(userPath),
    cli = codexCliConfig(args);
  const managedPath = '/etc/codex/managed_config.toml',
    managed = readConfig(managedPath);
  const nativeProfileConfig = nativeProfile ? readConfig(join(home, `${nativeProfile}.config.toml`)) : {};
  const selection = [system, user, nativeProfileConfig, cli, managed].reduce(
    (base, layer) =>
      merge(
        base,
        Object.fromEntries(
          ['profile', 'projects', 'project_root_markers']
            .filter((key) => Object.hasOwn(layer, key))
            .map((key) => [key, layer[key]]),
        ),
      ),
    {},
  );
  const legacyProfile = typeof selection.profile === 'string' ? selection.profile : undefined;
  const layers: CodexLaunchConfigLayer[] = [];
  const add = (kind: CodexLaunchConfigLayer['kind'], source: string, baseDir: string, raw: Record<string, unknown>) => {
    const selected = codexSensitiveProjection(raw);
    layers.push({ kind, source, baseDir, config: normalizeSqliteLayer(selected, baseDir, nativeHome) });
  };
  add('system', systemPath, dirname(systemPath), system);
  add('user', userPath, home, user);
  if (nativeProfile) {
    const source = join(home, `${nativeProfile}.config.toml`);
    add('profile', source, home, nativeProfileConfig);
  }
  if (legacyProfile) {
    // Legacy profiles are projected from their original layer, preserving path origin.
    for (const [source, raw] of [
      [systemPath, system],
      [userPath, user],
      [join(home, `${nativeProfile}.config.toml`), nativeProfileConfig],
    ] as const)
      add(
        'profile',
        `${source}#profiles.${legacyProfile}`,
        dirname(source),
        codexConfigRecord(codexConfigRecord(raw.profiles)[legacyProfile]),
      );
  }
  // Native removes these project-local credential/provider outlets even for trusted projects.
  const denied = new Set([
    'openai_base_url',
    'chatgpt_base_url',
    'model_provider',
    'model_providers',
    'experimental_realtime_webrtc_call_base_url',
    'experimental_realtime_ws_base_url',
  ]);
  for (const baseDir of codexProjectConfigDirectories(cwd, selection)) {
    if (resolve(baseDir) === resolve(home)) continue;
    const source = join(baseDir, 'config.toml');
    const projected = codexSensitiveProjection(readConfig(source));
    for (const key of denied) delete projected[key];
    add('project', source, baseDir, projected);
  }
  if (legacyProfile)
    add(
      'profile',
      `argv#profiles.${legacyProfile}`,
      cwd,
      codexConfigRecord(codexConfigRecord(cli.profiles)[legacyProfile]),
    );
  add('cli', 'argv', cwd, cli);
  add('managed', managedPath, dirname(managedPath), managed);
  if (legacyProfile)
    add(
      'managed',
      `${managedPath}#profiles.${legacyProfile}`,
      dirname(managedPath),
      codexConfigRecord(codexConfigRecord(managed.profiles)[legacyProfile]),
    );
  const rawRequirements = readConfig('/etc/codex/requirements.toml');
  const requirements = normalizeSqliteLayer(codexSensitiveProjection(rawRequirements), '/etc/codex', nativeHome);
  if (Object.hasOwn(rawRequirements, 'allowed_login_methods'))
    requirements.allowed_login_methods = rawRequirements.allowed_login_methods;
  const config = layers.reduce((config, layer) => merge(config, layer.config), {});
  layers.push({
    kind: 'requirements',
    source: '/etc/codex/requirements.toml',
    baseDir: '/etc/codex',
    config: requirements,
  });
  return { config, layers, requirements };
}
export function readCodexLaunchConfig(
  home: string,
  cwd: string,
  args: readonly string[] = [],
  options: { nativeHome?: string } = {},
): Record<string, unknown> {
  const projection = readCodexLaunchProjection(home, cwd, args, options);
  return projection.requirements.sqlite_home === undefined
    ? projection.config
    : { ...projection.config, sqlite_home: projection.requirements.sqlite_home };
}
export function overlayCodexSensitiveConfig(
  config: Record<string, unknown>,
  rpcConfig: Record<string, unknown>,
): Record<string, unknown> {
  return merge(codexSensitiveProjection(config), codexRpcConfig(rpcConfig));
}
