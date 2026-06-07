export interface GitHubSelfLoginResolverOptions {
  readonly getConfiguredLogin?: () => string | undefined;
  readonly getTokenFingerprint: () => string | undefined;
  readonly resolveLogin: () => Promise<string | undefined>;
}

export interface GitHubSelfLoginResolver {
  readonly getCurrent: () => string | undefined;
  readonly refreshIfNeeded: () => Promise<string | undefined>;
}

function cleanLogin(value: string | undefined | null): string | undefined {
  if (typeof value !== 'string') return undefined;
  const login = value.trim();
  return login ? login : undefined;
}

function cleanFingerprint(value: string | undefined | null): string {
  if (typeof value !== 'string') return '';
  return value.trim();
}

export function createGitHubSelfLoginResolver(opts: GitHubSelfLoginResolverOptions): GitHubSelfLoginResolver {
  let cachedLogin: string | undefined;
  let cachedTokenFingerprint: string | undefined;
  let hasCachedTokenFingerprint = false;
  let inFlightTokenFingerprint: string | undefined;
  let inFlight: Promise<string | undefined> | undefined;

  const getConfiguredLogin = (): string | undefined => cleanLogin(opts.getConfiguredLogin?.());

  const getCurrent = (): string | undefined => getConfiguredLogin() ?? cachedLogin;

  const refreshIfNeeded = async (): Promise<string | undefined> => {
    const configuredLogin = getConfiguredLogin();
    if (configuredLogin) {
      cachedLogin = configuredLogin;
      cachedTokenFingerprint = undefined;
      hasCachedTokenFingerprint = false;
      return cachedLogin;
    }

    const tokenFingerprint = cleanFingerprint(opts.getTokenFingerprint());
    if (hasCachedTokenFingerprint && cachedTokenFingerprint === tokenFingerprint) {
      return cachedLogin;
    }

    if (inFlight && inFlightTokenFingerprint === tokenFingerprint) {
      return inFlight;
    }

    const resolvingTokenFingerprint = tokenFingerprint;
    inFlightTokenFingerprint = resolvingTokenFingerprint;
    inFlight = (async () => {
      try {
        const resolvedLogin = cleanLogin(await opts.resolveLogin());
        const configuredLogin = getConfiguredLogin();
        if (configuredLogin) {
          cachedLogin = configuredLogin;
          cachedTokenFingerprint = undefined;
          hasCachedTokenFingerprint = false;
          return cachedLogin;
        }
        if (cleanFingerprint(opts.getTokenFingerprint()) !== resolvingTokenFingerprint) {
          return getCurrent();
        }
        cachedLogin = resolvedLogin;
        if (resolvedLogin) {
          cachedTokenFingerprint = resolvingTokenFingerprint;
          hasCachedTokenFingerprint = true;
        } else {
          cachedTokenFingerprint = undefined;
          hasCachedTokenFingerprint = false;
        }
        return cachedLogin;
      } catch {
        cachedLogin = undefined;
        cachedTokenFingerprint = undefined;
        hasCachedTokenFingerprint = false;
        return undefined;
      }
    })();

    try {
      return await inFlight;
    } finally {
      if (inFlightTokenFingerprint === resolvingTokenFingerprint) {
        inFlight = undefined;
        inFlightTokenFingerprint = undefined;
      }
    }
  };

  return { getCurrent, refreshIfNeeded };
}
