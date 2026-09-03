import type { FastifyBaseLogger } from 'fastify';
import { GitHubValidationError } from '../infrastructure/github/github-object-validator.js';

type GitHubValidationSubject = 'Repository' | 'PR' | 'Issue';

function buildGitHubValidationFailureResponse(error: unknown, subject: GitHubValidationSubject) {
  if (!(error instanceof GitHubValidationError)) {
    return { statusCode: 503, body: { error: `${subject} validation unavailable — try again later` } };
  }
  if (error.kind === 'rate_limited') {
    return {
      statusCode: 429,
      body: {
        error: `GitHub rate limit reached during ${subject} validation — retry later`,
        code: 'github_rate_limited',
      },
    };
  }
  if (error.kind === 'authentication_required') {
    return {
      statusCode: 503,
      body: {
        error: `${subject} validation cannot authenticate to GitHub — configure gh auth or an explicit GitHub plugin token`,
        code: 'github_authentication_required',
      },
    };
  }
  if (error.kind === 'permission_denied') {
    return {
      statusCode: 503,
      body: {
        error: `GitHub credentials cannot access this ${subject.toLowerCase()}`,
        code: 'github_permission_denied',
      },
    };
  }
  return {
    statusCode: 503,
    body: { error: `${subject} validation unavailable — try again later`, code: 'github_validation_unavailable' },
  };
}

export async function resolveGitHubValidation(
  validate: () => Promise<boolean>,
  subject: GitHubValidationSubject,
  log: Pick<FastifyBaseLogger, 'warn'>,
  context: Record<string, unknown>,
) {
  try {
    return { ok: true as const, value: await validate() };
  } catch (error) {
    const failure = buildGitHubValidationFailureResponse(error, subject);
    log.warn(
      {
        ...context,
        githubValidationFailureKind: error instanceof GitHubValidationError ? error.kind : 'unavailable',
      },
      `GitHub ${subject.toLowerCase()} validation failed`,
    );
    return { ok: false as const, ...failure };
  }
}
