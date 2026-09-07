export interface GitHubAppManifest {
  readonly name: string;
  readonly url: string;
  readonly redirect_url: string;
  readonly callback_urls: readonly string[];
  readonly public: true;
}

export interface GitHubAppManifestBeginResult {
  readonly registrationUrl: string;
  readonly manifest: GitHubAppManifest;
}

export interface GitHubAppManifestSubmission {
  readonly action: string;
  readonly method: 'post';
  readonly fields: readonly [{ readonly name: 'manifest'; readonly value: string }];
}

export function prepareGitHubAppManifestSubmission(value: unknown): GitHubAppManifestSubmission {
  if (!isRecord(value) || typeof value.registrationUrl !== 'string') {
    throw new Error('GitHub 登录应用创建地址不可信');
  }
  const action = trustedGitHubAppRegistrationUrl(value.registrationUrl);
  if (!action) throw new Error('GitHub 登录应用创建地址不可信');
  const manifest = parseGitHubAppManifest(value.manifest);
  if (!manifest) throw new Error('GitHub 登录应用配置不完整');
  return {
    action,
    method: 'post',
    fields: [{ name: 'manifest', value: JSON.stringify(manifest) }],
  };
}

export function trustedGitHubAppRegistrationUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.pathname !== '/settings/apps/new' ||
    url.hash ||
    url.searchParams.size !== 1 ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(url.searchParams.get('state') ?? '')
  ) {
    return undefined;
  }
  return url.href;
}

function parseGitHubAppManifest(value: unknown): GitHubAppManifest | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'callback_urls,name,public,redirect_url,url') return undefined;
  if (typeof value.name !== 'string' || value.name.trim().length === 0 || value.name.length > 100) return undefined;
  if (!isHttpUrl(value.url) || !isHttpUrl(value.redirect_url)) return undefined;
  if (!Array.isArray(value.callback_urls) || value.callback_urls.length !== 1) return undefined;
  if (!value.callback_urls.every(isHttpUrl) || value.public !== true) return undefined;
  return {
    name: value.name,
    url: value.url,
    redirect_url: value.redirect_url,
    callback_urls: value.callback_urls,
    public: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
