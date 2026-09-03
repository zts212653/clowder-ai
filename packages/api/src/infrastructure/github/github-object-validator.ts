import { buildGhCliEnv, withHiddenGhCliWindow } from './gh-cli-env.js';

export type GitHubObjectLookupResult<T> = { readonly found: true; readonly value: T } | { readonly found: false };

export type GitHubValidationFailureKind =
  | 'authentication_required'
  | 'permission_denied'
  | 'rate_limited'
  | 'not_found'
  | 'unavailable';

interface GhProcessFailure extends Error {
  readonly code?: unknown;
  readonly killed?: boolean;
  readonly signal?: string | null;
  readonly stdout?: unknown;
  readonly stderr?: unknown;
}

export interface GitHubApiResourceValidationOptions {
  readonly token?: string;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly execFileAsync?: (
    file: string,
    args: string[],
    options: { timeout: number; env: NodeJS.ProcessEnv; windowsHide: boolean },
  ) => Promise<{ stdout: string }>;
}

export class GitHubValidationError extends Error {
  constructor(readonly kind: Exclude<GitHubValidationFailureKind, 'not_found'>) {
    super(`GitHub validation failed: ${kind}`);
    this.name = 'GitHubValidationError';
  }
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return '';
}

function isConfirmedGitHubNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const failure = error as GhProcessFailure;
  if (typeof failure.code !== 'number') return false;

  // Only trust source-attributed diagnostics emitted by `gh` itself. A process
  // failure can contain arbitrary proxy/runtime text (including "HTTP 404")
  // in its Error message or stdout without proving that GitHub rejected the
  // requested object.
  const ghDiagnostic = textOf(failure.stderr);
  return (
    /^gh:\s+.+\(HTTP\s+404\)\s*$/im.test(ghDiagnostic) ||
    /^GraphQL:\s+Could not resolve to a Repository with (?:the )?name\b/im.test(ghDiagnostic)
  );
}

export function classifyGhValidationFailure(error: unknown): GitHubValidationFailureKind {
  if (!(error instanceof Error)) return 'unavailable';

  const failure = error as GhProcessFailure;
  if (isConfirmedGitHubNotFound(error)) return 'not_found';

  // Status classification is based only on diagnostics attributed to `gh`.
  // The generic Error message and stdout can contain proxy/runtime text and
  // must never turn an infrastructure failure into an object-level verdict.
  const ghDiagnostic = textOf(failure.stderr).toLowerCase();
  if (
    failure.code === 4 ||
    ghDiagnostic.includes('http 401') ||
    ghDiagnostic.includes('requires authentication') ||
    ghDiagnostic.includes('bad credentials') ||
    ghDiagnostic.includes('not logged into any github hosts')
  ) {
    return 'authentication_required';
  }
  if (
    ghDiagnostic.includes('rate limit') ||
    ghDiagnostic.includes('secondary rate') ||
    ghDiagnostic.includes('abuse detection') ||
    ghDiagnostic.includes('http 429')
  ) {
    return 'rate_limited';
  }
  if (
    ghDiagnostic.includes('http 403') ||
    ghDiagnostic.includes('resource not accessible') ||
    ghDiagnostic.includes('permission denied') ||
    ghDiagnostic.includes('forbidden')
  ) {
    return 'permission_denied';
  }
  return 'unavailable';
}

/**
 * Preserve the historical GitHub object lookup boundary behind a testable seam.
 *
 * The caller maps `found: false` to its object-not-found response and lets
 * infrastructure failures escape. Error classification is intentionally kept
 * here so every repo/PR/issue lookup follows one contract.
 */
export async function resolveGitHubObjectLookup<T>(lookup: () => Promise<T>): Promise<GitHubObjectLookupResult<T>> {
  try {
    return { found: true, value: await lookup() };
  } catch (error: unknown) {
    if (isConfirmedGitHubNotFound(error)) return { found: false };
    throw error;
  }
}

export async function readGitHubApiResource(
  endpoint: string,
  jqExpression: string,
  options: GitHubApiResourceValidationOptions = {},
): Promise<string | null> {
  const execFileAsync =
    options.execFileAsync ??
    (async (file, args, execOptions) => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      return promisify(execFile)(file, args, execOptions);
    });

  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['api', endpoint, '--jq', jqExpression],
      withHiddenGhCliWindow({
        timeout: options.timeoutMs ?? 10_000,
        env: buildGhCliEnv({ token: options.token, baseEnv: options.baseEnv }),
      }),
    );
    return stdout;
  } catch (error) {
    const kind = classifyGhValidationFailure(error);
    if (kind === 'not_found') return null;
    throw new GitHubValidationError(kind);
  }
}

export async function validateGitHubApiResource(
  endpoint: string,
  jqExpression: string,
  options: GitHubApiResourceValidationOptions = {},
): Promise<boolean> {
  return (await readGitHubApiResource(endpoint, jqExpression, options)) !== null;
}
