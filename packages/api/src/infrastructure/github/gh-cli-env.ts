export interface GhCliEnvOptions {
  readonly token?: string | null;
  readonly baseEnv?: NodeJS.ProcessEnv;
}

export interface ResolveGhCliTokenOptions {
  readonly pluginEnv?: Record<string, string | undefined>;
  readonly baseEnv?: NodeJS.ProcessEnv;
}

function cleanToken(value: string | undefined | null): string | undefined {
  if (typeof value !== 'string') return undefined;
  const token = value.trim();
  return token ? token : undefined;
}

export function resolveGhCliToken(options: ResolveGhCliTokenOptions = {}): string | undefined {
  const pluginEnv = options.pluginEnv ?? {};
  if (Object.hasOwn(pluginEnv, 'GITHUB_TOKEN')) {
    return cleanToken(pluginEnv.GITHUB_TOKEN);
  }

  const env = options.baseEnv ?? process.env;
  return cleanToken(env.GH_TOKEN) ?? cleanToken(env.GITHUB_TOKEN);
}

/**
 * Build the per-invocation environment for `gh` child processes.
 *
 * Ambient GITHUB_TOKEN/GH_TOKEN makes `gh` ignore its own auth store. Only pass
 * a token when the caller explicitly resolved a non-empty plugin/legacy value.
 */
export function buildGhCliEnv(options: GhCliEnvOptions = {}): NodeJS.ProcessEnv {
  const env = { ...(options.baseEnv ?? process.env) };
  const token = typeof options.token === 'string' ? options.token.trim() : '';

  delete env.GH_TOKEN;
  if (token) {
    env.GITHUB_TOKEN = token;
  } else {
    delete env.GITHUB_TOKEN;
  }

  return env;
}
